import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	healInstalledConfigs,
	installClaudeConfig,
	installCodexConfig,
	installStatus,
	uninstallClaudeConfig,
	uninstallCodexConfig
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

interface ClaudeSettingsFile {
	env?: Record<string, string>
	[key: string]: unknown
}

async function writeClaudeSettings(settings: ClaudeSettingsFile): Promise<void> {
	await writeFile(
		join(process.env.CLAUDE_CONFIG_DIR ?? '', 'settings.json'),
		JSON.stringify(settings, null, 2)
	)
}

async function readClaudeSettings(): Promise<ClaudeSettingsFile> {
	return JSON.parse(
		await readFile(join(process.env.CLAUDE_CONFIG_DIR ?? '', 'settings.json'), 'utf8')
	) as ClaudeSettingsFile
}

describe('installClaudeConfig', () => {
	test('sets only the base URL so the native claude.ai login stays active', async () => {
		await writeClaudeSettings({ model: 'fable[1m]' })
		await installClaudeConfig(paths())
		const settings = await readClaudeSettings()
		expect(settings.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8459/anthropic')
		expect(settings.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
		expect(settings.model).toBe('fable[1m]')
	})

	test('an earlier install left the dummy token behind; reinstall clears it', async () => {
		await writeClaudeSettings({
			env: {
				ANTHROPIC_AUTH_TOKEN: 'managed-by-tokenmaxx',
				ANTHROPIC_BASE_URL: 'http://127.0.0.1:8459/anthropic',
				OTHER: 'kept'
			}
		})
		await installClaudeConfig(paths())
		const settings = await readClaudeSettings()
		expect(settings.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
		expect(settings.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8459/anthropic')
		expect(settings.env?.OTHER).toBe('kept')
	})

	test('a token the user set themselves is not touched', async () => {
		await writeClaudeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'users-own-token' } })
		await installClaudeConfig(paths())
		const settings = await readClaudeSettings()
		expect(settings.env?.ANTHROPIC_AUTH_TOKEN).toBe('users-own-token')
		expect(settings.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8459/anthropic')
	})

	test('installStatus reports claude routing after install', async () => {
		await installClaudeConfig(paths())
		expect((await installStatus()).claudeRouted).toBe(true)
	})

	test('uninstall removes the routing but keeps a token the user set themselves', async () => {
		await writeClaudeSettings({
			env: { ANTHROPIC_AUTH_TOKEN: 'users-own-token' },
			model: 'fable[1m]'
		})
		await installClaudeConfig(paths())
		await uninstallClaudeConfig()
		const settings = await readClaudeSettings()
		expect(settings.env?.ANTHROPIC_BASE_URL).toBeUndefined()
		expect(settings.env?.ANTHROPIC_AUTH_TOKEN).toBe('users-own-token')
		expect(settings.model).toBe('fable[1m]')
	})

	test('uninstall after a legacy dummy-token install leaves no env behind', async () => {
		await writeClaudeSettings({
			env: {
				ANTHROPIC_AUTH_TOKEN: 'managed-by-tokenmaxx',
				ANTHROPIC_BASE_URL: 'http://127.0.0.1:8459/anthropic'
			}
		})
		await uninstallClaudeConfig()
		const settings = await readClaudeSettings()
		expect(settings.env).toBeUndefined()
	})
})

describe('healInstalledConfigs', () => {
	test('re-applies every routed config, healing what an older version wrote', async () => {
		await installCodexConfig(paths())
		await writeClaudeSettings({
			env: {
				ANTHROPIC_AUTH_TOKEN: 'managed-by-tokenmaxx',
				ANTHROPIC_BASE_URL: 'http://127.0.0.1:8459/anthropic'
			}
		})
		expect(await healInstalledConfigs(paths())).toEqual(['codex', 'claude'])
		const settings = await readClaudeSettings()
		expect(settings.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
		expect(settings.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8459/anthropic')
	})

	test('never adds routing to an unrouted harness', async () => {
		expect(await healInstalledConfigs(paths())).toEqual([])
		await expect(readClaudeSettings()).rejects.toThrow()
		expect((await installStatus()).codexRouted).toBe(false)
	})

	test('runs once per version, not on every start', async () => {
		await healInstalledConfigs(paths())
		await writeClaudeSettings({
			env: {
				ANTHROPIC_AUTH_TOKEN: 'managed-by-tokenmaxx',
				ANTHROPIC_BASE_URL: 'http://127.0.0.1:8459/anthropic'
			}
		})
		expect(await healInstalledConfigs(paths())).toEqual([])
		expect((await readClaudeSettings()).env?.ANTHROPIC_AUTH_TOKEN).toBe('managed-by-tokenmaxx')
	})
})
