import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	installCodexConfig,
	installHarnessConfig,
	installStatus,
	uninstallCodexConfig,
	uninstallHarnessConfig
} from './config-install.ts'
import { applicationPaths } from './paths.ts'

const legacyBrokenConfig = `model = "gpt-5.6-sol"
approval_policy = "never"

[projects."/Users/someone/Code/app"]
trust_level = "trusted"

[notice]
hide_rate_limit_model_nudge = true

# >>> tokmax managed (do not edit) >>>
model_provider = "tokmax"

[model_providers.tokmax]
name = "tokmax"
base_url = "http://127.0.0.1:8459/openai"
wire_api = "responses"
# <<< tokmax managed <<<
`

let home = ''

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), 'tokenmaxx-config-'))
	process.env.CODEX_HOME = join(home, 'codex')
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	await mkdir(process.env.CODEX_HOME, { recursive: true })
	await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
})

afterEach(() => {
	delete process.env.CODEX_HOME
	delete process.env.CLAUDE_CONFIG_DIR
	rmSync(home, { force: true, recursive: true })
})

const paths = () => applicationPaths({ ...process.env, TOKENMAXX_HOME: join(home, 'state') })

async function writeCodexConfig(content: string): Promise<void> {
	await writeFile(join(process.env.CODEX_HOME ?? '', 'config.toml'), content)
}

async function readCodexConfig(): Promise<string> {
	return readFile(join(process.env.CODEX_HOME ?? '', 'config.toml'), 'utf8')
}

describe('installCodexConfig', () => {
	test('model_provider lands before any table so TOML keeps it top-level', async () => {
		await writeCodexConfig(legacyBrokenConfig)
		await installCodexConfig(paths())
		const parsed = Bun.TOML.parse(await readCodexConfig()) as Record<string, unknown>
		expect(parsed.model_provider).toBe('tokenmaxx')
		const providers = parsed.model_providers as Record<string, Record<string, unknown>>
		expect(providers.tokenmaxx?.base_url).toBe('http://127.0.0.1:8459/openai')
		expect(providers.tokenmaxx?.requires_openai_auth).toBe(true)
		expect(parsed.model).toBe('gpt-5.6-sol')
		expect((parsed.notice as Record<string, unknown>).hide_rate_limit_model_nudge).toBe(true)
		expect((parsed.notice as Record<string, unknown>).model_provider).toBeUndefined()
	})

	test('installStatus flags the legacy swallowed block as stale, not routed', async () => {
		await writeCodexConfig(legacyBrokenConfig)
		const status = await installStatus()
		expect(status.codexRouted).toBe(false)
		expect(status.codexStale).toBe(true)
	})

	test('installStatus verifies routing semantically after install', async () => {
		await writeCodexConfig(legacyBrokenConfig)
		await installCodexConfig(paths())
		const status = await installStatus()
		expect(status.codexRouted).toBe(true)
		expect(status.codexStale).toBe(false)
	})

	test('reinstall is idempotent', async () => {
		await writeCodexConfig(legacyBrokenConfig)
		await installCodexConfig(paths())
		const once = await readCodexConfig()
		await installCodexConfig(paths())
		expect(await readCodexConfig()).toBe(once)
	})

	test('uninstall restores the user config without managed blocks', async () => {
		await writeCodexConfig(legacyBrokenConfig)
		await installCodexConfig(paths())
		await uninstallCodexConfig()
		const restored = await readCodexConfig()
		expect(restored).not.toContain('tokenmaxx')
		expect(restored).not.toContain('tokmax')
		const parsed = Bun.TOML.parse(restored) as Record<string, unknown>
		expect(parsed.model).toBe('gpt-5.6-sol')
		expect(parsed.model_provider).toBeUndefined()
	})

	test('a config that starts with bare keys is not swallowed by the provider table', async () => {
		await writeCodexConfig('model = "gpt-5.6-sol"\nservice_tier = "fast"\n')
		await installCodexConfig(paths())
		const parsed = Bun.TOML.parse(await readCodexConfig()) as Record<string, unknown>
		expect(parsed.model).toBe('gpt-5.6-sol')
		expect(parsed.service_tier).toBe('fast')
		expect(parsed.model_provider).toBe('tokenmaxx')
	})
})

describe('harness installs', () => {
	test('openclaw providers merge in and back out without touching the rest', async () => {
		process.env.OPENCLAW_CONFIG_PATH = join(home, 'openclaw.json')
		await writeFile(
			process.env.OPENCLAW_CONFIG_PATH,
			JSON.stringify({ agents: { defaults: { model: { primary: 'anthropic/claude-opus-4-8' } } } })
		)
		const installed = await installHarnessConfig('openclaw', applicationPaths())
		expect(installed.applied).toBe(true)
		const config = JSON.parse(await readFile(installed.path, 'utf8'))
		expect(config.models.providers['tokenmaxx-anthropic'].api).toBe('anthropic-messages')
		expect(config.models.providers['tokenmaxx-openai'].baseUrl).toContain('/openai')
		expect(config.agents.defaults.model.primary).toBe('anthropic/claude-opus-4-8')
		const removed = await uninstallHarnessConfig('openclaw')
		expect(removed.applied).toBe(true)
		const restored = JSON.parse(await readFile(installed.path, 'utf8'))
		expect(restored.models.providers['tokenmaxx-anthropic']).toBeUndefined()
		delete process.env.OPENCLAW_CONFIG_PATH
	})

	test('a json5 openclaw config is left alone with manual instructions', async () => {
		process.env.OPENCLAW_CONFIG_PATH = join(home, 'openclaw.json')
		await writeFile(process.env.OPENCLAW_CONFIG_PATH, '{\n  // my settings\n  models: {},\n}\n')
		const result = await installHarnessConfig('openclaw', applicationPaths())
		expect(result.applied).toBe(false)
		expect(result.manual).toContain('models.providers')
		expect(await readFile(result.path, 'utf8')).toContain('// my settings')
		delete process.env.OPENCLAW_CONFIG_PATH
	})

	test('pi models.json gains and loses the providers cleanly', async () => {
		process.env.PI_CODING_AGENT_DIR = join(home, 'pi-agent')
		const installed = await installHarnessConfig('pi', applicationPaths())
		expect(installed.applied).toBe(true)
		const config = JSON.parse(await readFile(installed.path, 'utf8'))
		expect(config.providers['tokenmaxx-anthropic'].baseUrl).toContain('/anthropic')
		const removed = await uninstallHarnessConfig('pi')
		expect(removed.applied).toBe(true)
		expect(JSON.parse(await readFile(installed.path, 'utf8')).providers).toEqual({})
		delete process.env.PI_CODING_AGENT_DIR
	})

	test('hermes gets a marked block that round-trips, and defers when providers exist', async () => {
		process.env.HERMES_HOME = join(home, 'hermes')
		await mkdir(process.env.HERMES_HOME, { recursive: true })
		const configPath = join(process.env.HERMES_HOME, 'config.yaml')
		await writeFile(configPath, 'model:\n  default: "claude-opus-4-8"\n')
		const installed = await installHarnessConfig('hermes', applicationPaths())
		expect(installed.applied).toBe(true)
		const written = await readFile(configPath, 'utf8')
		expect(written).toContain('api_mode: "codex_responses"')
		expect(written).toContain('model:')
		const removed = await uninstallHarnessConfig('hermes')
		expect(removed.applied).toBe(true)
		expect(await readFile(configPath, 'utf8')).not.toContain('tokenmaxx-anthropic')

		await writeFile(configPath, 'providers:\n  mine:\n    base_url: "https://example.com"\n')
		const deferred = await installHarnessConfig('hermes', applicationPaths())
		expect(deferred.applied).toBe(false)
		expect(await readFile(configPath, 'utf8')).not.toContain('tokenmaxx')
		delete process.env.HERMES_HOME
	})
})
