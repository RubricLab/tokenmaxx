import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	clientConfigPaths,
	installClaudeConfig,
	installCodexConfig,
	installPiConfig,
	uninstallClaudeConfig
} from './config-install.ts'
import { applicationPaths, ensureApplicationPaths } from './paths.ts'
import { createStateStore } from './storage.ts'
import { uninstallTokenmaxx } from './uninstall.ts'

let directory: string
let environment: NodeJS.ProcessEnv
let savedEnvironment: NodeJS.ProcessEnv

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'tmx-clean-'))
	environment = {
		CLAUDE_CONFIG_DIR: join(directory, 'claude'),
		CODEX_HOME: join(directory, 'codex'),
		GROK_HOME: join(directory, 'grok'),
		PI_CODING_AGENT_DIR: join(directory, 'pi'),
		TOKENMAXX_HOME: join(directory, 'state')
	}
	savedEnvironment = { ...process.env }
	Object.assign(process.env, environment)
})

afterEach(async () => {
	for (const key of Object.keys(environment)) {
		if (savedEnvironment[key] === undefined) delete process.env[key]
		else process.env[key] = savedEnvironment[key]
	}
	await rm(directory, { force: true, recursive: true })
})

async function setup() {
	const paths = applicationPaths(environment)
	await ensureApplicationPaths(paths)
	const store = createStateStore(paths.database)
	store.close()
	await installCodexConfig(paths)
	await installClaudeConfig(paths)
	await installPiConfig(paths)
	await writeFile(join(paths.runtime, 'daemon.log'), 'usage log')
	await writeFile(join(paths.root, 'preferences.json'), '{"theme":"dark"}')
	return paths
}

test('complete cleanup restores original files and removes startup, credentials, profiles, and state without restarting', async () => {
	const configs = clientConfigPaths(environment)
	const originals = {
		claude:
			'{"theme":"light","env":{"ANTHROPIC_BASE_URL":"https://previous.example","ANTHROPIC_AUTH_TOKEN":"native-token"}}\n',
		codex: 'model_provider = "my-provider"\n\n[projects."/work"]\ntrust_level = "trusted"\n',
		pi: '{"providers":{"personal":{"baseUrl":"https://personal.example"}}}\n'
	}
	for (const key of ['codex', 'claude', 'pi'] as const) {
		await mkdir(join(directory, key))
		await writeFile(configs[key], originals[key])
	}
	const nativeAuth = join(directory, 'codex', 'auth.json')
	await writeFile(nativeAuth, 'native login stays')
	const paths = await setup()
	await installClaudeConfig(paths)
	const profile = join(paths.claudeProfiles, 'isolated-account')
	await mkdir(profile)
	await writeFile(join(profile, '.credentials.json'), 'isolated credentials')
	const app = join(directory, 'tokenmaxx.app')
	const agent = join(directory, 'sh.tokenmaxx.daemon.plist')
	await mkdir(app)
	await writeFile(agent, 'startup')
	const events: string[] = []
	const credentials = new Map([
		['account', 'key'],
		['account:0', 'chunk'],
		['orphan', 'old-key']
	])
	const input = {
		environment,
		paths,
		removeCredentials: async () => {
			expect(await readFile(configs.claude, 'utf8')).toBe(originals.claude)
			events.push('credentials')
			credentials.clear()
		},
		removeProfile: async (path: string) => {
			events.push('profile')
			await rm(path, { recursive: true })
		},
		removeStartup: async () => {
			events.push('startup')
			await rm(app, { force: true, recursive: true })
			await rm(agent, { force: true })
		},
		stopDaemon: async () => {
			events.push('stop')
		}
	}
	await uninstallTokenmaxx(input)
	expect(events).toEqual(['stop', 'profile', 'credentials', 'startup'])
	expect(credentials.size).toBe(0)
	for (const key of ['codex', 'claude', 'pi'] as const)
		expect(await readFile(configs[key], 'utf8')).toBe(originals[key])
	expect(await readFile(nativeAuth, 'utf8')).toBe('native login stays')
	for (const path of [paths.root, app, agent])
		expect(
			await stat(path).then(
				() => true,
				() => false
			)
		).toBe(false)
	await uninstallTokenmaxx(input)
	expect(
		await stat(paths.root).then(
			() => true,
			() => false
		)
	).toBe(false)
})

test('files and empty client directories created by setup disappear on uninstall', async () => {
	const paths = await setup()
	await uninstallTokenmaxx({
		environment,
		paths,
		removeCredentials: async () => {},
		removeStartup: async () => {},
		stopDaemon: async () => {}
	})
	for (const path of Object.values(clientConfigPaths(environment))) {
		expect(await Bun.file(path).exists()).toBe(false)
	}
	for (const name of ['codex', 'claude', 'pi', 'state'])
		expect(
			await stat(join(directory, name)).then(
				() => true,
				() => false
			)
		).toBe(false)
})

test('edits made after installation survive while overwritten client settings are restored', async () => {
	const configs = clientConfigPaths(environment)
	await mkdir(join(directory, 'claude'))
	await writeFile(
		configs.claude,
		JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://previous.example' }, theme: 'light' })
	)
	const paths = await setup()
	const claude = JSON.parse(await readFile(configs.claude, 'utf8'))
	claude.theme = 'dark'
	claude.env.NEW_SETTING = 'keep'
	await writeFile(configs.claude, JSON.stringify(claude))
	await writeFile(
		configs.codex,
		`${await readFile(configs.codex, 'utf8')}\n[projects."/new"]\ntrust_level = "trusted"\n`
	)
	await uninstallTokenmaxx({
		environment,
		paths,
		removeCredentials: async () => {},
		removeStartup: async () => {},
		stopDaemon: async () => {}
	})
	expect(JSON.parse(await readFile(configs.claude, 'utf8'))).toEqual({
		env: { ANTHROPIC_BASE_URL: 'https://previous.example', NEW_SETTING: 'keep' },
		theme: 'dark'
	})
	const codex = await readFile(configs.codex, 'utf8')
	expect(codex).toContain('[projects."/new"]')
	expect(codex).not.toContain('tokenmaxx')
})

test('failed credential cleanup keeps local recovery data and can be retried', async () => {
	const paths = await setup()
	let removedStartup = false
	const input = {
		environment,
		paths,
		removeStartup: async () => {
			removedStartup = true
		},
		stopDaemon: async () => {}
	}
	await expect(
		uninstallTokenmaxx({
			...input,
			removeCredentials: async () => {
				throw new Error('Keychain locked')
			}
		})
	).rejects.toThrow('Keychain locked')
	expect(removedStartup).toBe(false)
	expect(await Bun.file(paths.database).exists()).toBe(true)
	expect(await Bun.file(join(paths.root, 'config-backups.json')).exists()).toBe(true)
	await uninstallTokenmaxx({ ...input, removeCredentials: async () => {} })
	expect(removedStartup).toBe(true)
	expect(await Bun.file(paths.database).exists()).toBe(false)
})

test('a home directory cannot be purged as tokenmaxx data', async () => {
	let stopped = false
	await expect(
		uninstallTokenmaxx({
			environment,
			paths: applicationPaths({ TOKENMAXX_HOME: homedir() }),
			removeCredentials: async () => {},
			removeStartup: async () => {},
			stopDaemon: async () => {
				stopped = true
			}
		})
	).rejects.toThrow('dedicated data directory')
	expect(stopped).toBe(false)
})

test('unrelated files in a custom data directory are preserved', async () => {
	const paths = await setup()
	const unrelated = join(paths.root, 'keep.txt')
	await writeFile(unrelated, 'not tokenmaxx data')
	await uninstallTokenmaxx({
		environment,
		paths,
		removeCredentials: async () => {},
		removeStartup: async () => {},
		stopDaemon: async () => {}
	})
	expect(await readFile(unrelated, 'utf8')).toBe('not tokenmaxx data')
	expect(await Bun.file(paths.database).exists()).toBe(false)
	expect(
		await stat(paths.runtime).then(
			() => true,
			() => false
		)
	).toBe(false)
})

test('reinstall after restoring routing records the latest native settings', async () => {
	const paths = await setup()
	const path = clientConfigPaths(environment).claude
	await uninstallClaudeConfig(paths, path)
	await mkdir(join(directory, 'claude'), { recursive: true })
	const native = '{"env":{"ANTHROPIC_BASE_URL":"https://new-native.example"},"theme":"dark"}\n'
	await writeFile(path, native)
	await installClaudeConfig(paths)
	await uninstallTokenmaxx({
		environment,
		paths,
		removeCredentials: async () => {},
		removeStartup: async () => {},
		stopDaemon: async () => {}
	})
	expect(await readFile(path, 'utf8')).toBe(native)
})
