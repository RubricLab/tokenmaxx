import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplicationError } from './errors.ts'
import {
	readDashboard,
	readRouting,
	requestAddApiKey,
	requestRouting,
	startManagerServer
} from './ipc.ts'
import { AccountManager } from './manager.ts'
import { applicationPaths, ensureApplicationPaths } from './paths.ts'
import { createStateStore } from './storage.ts'
import type { CredentialVault } from './vault.ts'

const secrets = new Map<string, string>()
const vault: CredentialVault = {
	async read(reference) {
		return secrets.get(reference) ?? null
	},
	async remove(reference) {
		secrets.delete(reference)
	},
	async write(reference, value) {
		secrets.set(reference, value)
	}
}

const acceptingFetch = async () => new Response('{}', { status: 200 })

let home = ''
let socketPath = ''
let close: () => Promise<void> = async () => undefined

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), 'tokenmaxx-ipc-'))
	process.env.CODEX_HOME = join(home, 'codex')
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	process.env.PI_CODING_AGENT_DIR = join(home, 'pi')
	await mkdir(process.env.CODEX_HOME, { recursive: true })
	await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
	const paths = applicationPaths({ ...process.env, TOKENMAXX_HOME: join(home, 'state') })
	await ensureApplicationPaths(paths)
	const manager = new AccountManager({
		dependencies: { fetchImplementation: acceptingFetch },
		paths,
		store: createStateStore(paths.database),
		vault
	})
	socketPath = paths.managerSocket
	const server = await startManagerServer({ manager, onStop: () => undefined, socketPath })
	close = server.close
})

afterEach(async () => {
	await close()
	delete process.env.CODEX_HOME
	delete process.env.CLAUDE_CONFIG_DIR
	delete process.env.PI_CODING_AGENT_DIR
	secrets.clear()
	rmSync(home, { force: true, recursive: true })
})

describe('routing over ipc', () => {
	test('reads and toggles codex and claude routing', async () => {
		expect((await readRouting(socketPath)).routed).toEqual({ anthropic: false, openai: false })

		const on = await requestRouting(socketPath, 'anthropic', true)
		expect(on.routed.anthropic).toBe(true)
		const settings = await readFile(join(home, 'claude', 'settings.json'), 'utf8')
		expect(settings).toContain('127.0.0.1')

		const off = await requestRouting(socketPath, 'anthropic', false)
		expect(off.routed.anthropic).toBe(false)
	})

	test('routes pi and refuses to touch a models.json it cannot parse', async () => {
		await mkdir(join(home, 'pi'), { recursive: true })
		expect((await requestRouting(socketPath, 'pi', true)).pi).toEqual({
			present: true,
			routed: true
		})

		await writeFile(join(home, 'pi', 'models.json'), '{ not json')
		const failure = await requestRouting(socketPath, 'pi', true).catch(error => error)
		expect(failure).toBeInstanceOf(ApplicationError)
		expect((failure as ApplicationError).code).toBe('MANUAL_EDIT_REQUIRED')
	})
})

describe('api key accounts over ipc', () => {
	test('stores the key in the vault and activates the first account', async () => {
		const account = await requestAddApiKey(socketPath, {
			key: 'sk-ant-test',
			label: 'team key',
			provider: 'anthropic'
		})
		expect(account.auth).toBe('apiKey')
		expect(account.secretReference === null ? null : secrets.get(account.secretReference)).toBe(
			'sk-ant-test'
		)

		const dashboard = await readDashboard(socketPath)
		expect(dashboard.accounts.map(candidate => candidate.label)).toEqual(['team key'])
		expect(dashboard.providers.find(state => state.provider === 'anthropic')?.activeAccountId).toBe(
			account.id
		)
	})

	test('rejects an empty name', async () => {
		const failure = await requestAddApiKey(socketPath, {
			key: 'sk-test',
			label: '   ',
			provider: 'openai'
		}).catch(error => error)
		expect((failure as ApplicationError).code).toBe('USAGE')
		expect(secrets.size).toBe(0)
	})
})
