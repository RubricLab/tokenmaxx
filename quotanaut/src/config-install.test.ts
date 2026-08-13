import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCodexConfig, installStatus, uninstallCodexConfig } from './config-install.ts'
import { applicationPaths } from './paths.ts'

const existingConfig = `model = "gpt-5.6-sol"
approval_policy = "never"

[projects."/home/someone/app"]
trust_level = "trusted"

[notice]
hide_rate_limit_model_nudge = true
`

let home = ''

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), 'quotanaut-config-'))
	process.env.CODEX_HOME = join(home, 'codex')
	await mkdir(process.env.CODEX_HOME, { recursive: true })
})

afterEach(() => {
	delete process.env.CODEX_HOME
	rmSync(home, { force: true, recursive: true })
})

const paths = () => applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })

async function writeCodexConfig(content: string): Promise<void> {
	await writeFile(join(process.env.CODEX_HOME ?? '', 'config.toml'), content)
}

async function readCodexConfig(): Promise<string> {
	return readFile(join(process.env.CODEX_HOME ?? '', 'config.toml'), 'utf8')
}

describe('installCodexConfig', () => {
	test('puts the selected provider before TOML tables and configures proxy authorization', async () => {
		await writeCodexConfig(existingConfig)
		const statePaths = paths()
		await installCodexConfig(statePaths)
		expect((await lstat(join(process.env.CODEX_HOME ?? '', 'config.toml'))).mode & 0o777).toBe(
			0o600
		)
		expect(
			(await readdir(process.env.CODEX_HOME ?? '')).filter(name =>
				name.includes('.quotanaut-config-')
			)
		).toEqual([])
		const parsed = Bun.TOML.parse(await readCodexConfig()) as Record<string, unknown>
		expect(parsed.model_provider).toBe('quotanaut')
		const providers = parsed.model_providers as Record<string, Record<string, unknown>>
		expect(providers.quotanaut?.base_url).toBe('http://127.0.0.1:8460/openai')
		expect(providers.quotanaut?.requires_openai_auth).toBe(false)
		expect(providers.quotanaut?.experimental_bearer_token).toBe(
			(await readFile(statePaths.proxyToken, 'utf8')).trim()
		)
		expect(parsed.model).toBe('gpt-5.6-sol')
		expect((parsed.notice as Record<string, unknown>).hide_rate_limit_model_nudge).toBe(true)
	})

	test('installStatus verifies the full managed provider contract', async () => {
		const statePaths = paths()
		await installCodexConfig(statePaths)
		expect(await installStatus(statePaths)).toEqual({ codexRouted: true, codexStale: false })

		const modified = (await readCodexConfig()).replace(
			'requires_openai_auth = false',
			'requires_openai_auth = true'
		)
		await writeCodexConfig(modified)
		expect(await installStatus(statePaths)).toEqual({ codexRouted: false, codexStale: true })
	})

	test('installStatus rejects a changed URL, changed token, or missing persisted token', async () => {
		const statePaths = paths()
		await installCodexConfig(statePaths)
		const installed = await readCodexConfig()

		await writeCodexConfig(installed.replace('127.0.0.1:8460', '127.0.0.1:9999'))
		expect(await installStatus(statePaths)).toEqual({ codexRouted: false, codexStale: true })

		await writeCodexConfig(
			installed.replace(/experimental_bearer_token = ".+"/, 'experimental_bearer_token = "wrong"')
		)
		expect(await installStatus(statePaths)).toEqual({ codexRouted: false, codexStale: true })

		await writeCodexConfig(installed)
		await rm(statePaths.proxyToken)
		expect(await installStatus(statePaths)).toEqual({ codexRouted: false, codexStale: true })
	})

	test('reinstall is idempotent and preserves the proxy capability', async () => {
		await writeCodexConfig(existingConfig)
		await installCodexConfig(paths())
		const once = await readCodexConfig()
		await installCodexConfig(paths())
		expect(await readCodexConfig()).toBe(once)
	})

	test('uninstall restores the user config without managed blocks or secret', async () => {
		await writeCodexConfig(existingConfig)
		const statePaths = paths()
		await installCodexConfig(statePaths)
		const token = (await readFile(statePaths.proxyToken, 'utf8')).trim()
		await uninstallCodexConfig()
		const restored = await readCodexConfig()
		expect(restored).not.toContain('quotanaut')
		expect(restored).not.toContain(token)
		const parsed = Bun.TOML.parse(restored) as Record<string, unknown>
		expect(parsed.model).toBe('gpt-5.6-sol')
		expect(parsed.model_provider).toBeUndefined()
	})

	test('preserves and restores the previous top-level provider', async () => {
		await writeCodexConfig('model_provider = "native"\nmodel = "gpt-5.6-sol"\n')
		await installCodexConfig(paths())
		const managed = await readCodexConfig()
		expect(managed).toContain('# quotanaut-disabled: model_provider = "native"')
		await uninstallCodexConfig()
		const parsed = Bun.TOML.parse(await readCodexConfig()) as Record<string, unknown>
		expect(parsed.model_provider).toBe('native')
	})

	test('does not alter a provider selected inside a profile table', async () => {
		await writeCodexConfig(
			'model_provider = "native"\nmodel = "gpt-5.6-sol"\n\n[profiles.work]\nmodel_provider = "profile-native"\n'
		)
		await installCodexConfig(paths())
		const managed = await readCodexConfig()
		expect(managed).toContain('# quotanaut-disabled: model_provider = "native"')
		expect(managed).toContain('[profiles.work]\nmodel_provider = "profile-native"')
		const installed = Bun.TOML.parse(managed) as {
			profiles?: Record<string, { model_provider?: string }>
		}
		expect(installed.profiles?.work?.model_provider).toBe('profile-native')

		await uninstallCodexConfig()
		const restored = Bun.TOML.parse(await readCodexConfig()) as {
			model_provider?: string
			profiles?: Record<string, { model_provider?: string }>
		}
		expect(restored.model_provider).toBe('native')
		expect(restored.profiles?.work?.model_provider).toBe('profile-native')
	})

	test('does not treat a non-file config read error as an empty config', async () => {
		const configPath = join(process.env.CODEX_HOME ?? '', 'config.toml')
		await mkdir(configPath)

		await expect(installCodexConfig(paths())).rejects.toBeTruthy()
		expect((await lstat(configPath)).isDirectory()).toBe(true)
	})
})
