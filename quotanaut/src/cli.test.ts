import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	applyCodexAuthImports,
	help,
	prepareCodexAuthImports,
	removeStaleDaemonArtifacts,
	runCli
} from './cli.ts'
import type { Account } from './domain.ts'
import { applicationPaths, ensureApplicationPaths } from './paths.ts'
import { createStateStore } from './storage.ts'
import { createFileSystemCredentialVault } from './vault.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
	)
})

test('help exposes only the Codex v1 command surface and Quotanaut environment', () => {
	const text = help()
	expect(text).toContain('quotanaut login')
	expect(text).toContain('quotanaut import <auth.json>...')
	expect(text).toContain('quotanaut auto <on|off>')
	expect(text).toContain('QUOTANAUT_HOME')
	expect(text).not.toContain('tokenmaxx')
	expect(text).not.toContain('claude')
	expect(text).not.toContain('anthropic')
	expect(text).not.toContain('api-key')
})

test('uninstall restores direct routing even when Quotanaut state is unusable', async () => {
	const home = await mkdtemp(join(tmpdir(), 'quotanaut-cli-uninstall-test-'))
	temporaryDirectories.push(home)
	const codexHome = join(home, 'codex')
	await mkdir(codexHome)
	const configPath = join(codexHome, 'config.toml')
	await writeFile(
		configPath,
		'# >>> quotanaut managed (do not edit) >>>\nmodel_provider = "quotanaut"\n# <<< quotanaut managed <<<\n\nmodel = "gpt-5.6-sol"\n\n# >>> quotanaut provider (do not edit) >>>\n[model_providers.quotanaut]\nbase_url = "http://127.0.0.1:8460/openai"\n# <<< quotanaut provider <<<\n'
	)
	const unusableState = join(home, 'state-file')
	await writeFile(unusableState, 'not a directory')
	const previousCodexHome = process.env.CODEX_HOME
	const previousQuotanautHome = process.env.QUOTANAUT_HOME
	process.env.CODEX_HOME = codexHome
	process.env.QUOTANAUT_HOME = unusableState
	try {
		expect(await runCli(['uninstall'])).toBe(0)
		expect(await readFile(configPath, 'utf8')).toBe('model = "gpt-5.6-sol"\n')
		expect(await readFile(unusableState, 'utf8')).toBe('not a directory')
	} finally {
		if (previousCodexHome === undefined) delete process.env.CODEX_HOME
		else process.env.CODEX_HOME = previousCodexHome
		if (previousQuotanautHome === undefined) delete process.env.QUOTANAUT_HOME
		else process.env.QUOTANAUT_HOME = previousQuotanautHome
	}
})

function fakeJwt(claims: object): string {
	return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

function authJson(email: string, accountId = 'acct-1', userId = 'user-1'): string {
	return JSON.stringify({
		tokens: {
			access_token: fakeJwt({
				exp: 4_102_444_800,
				'https://api.openai.com/auth': { chatgpt_account_id: accountId }
			}),
			account_id: accountId,
			id_token: fakeJwt({
				chatgpt_account_id: accountId,
				chatgpt_user_id: userId,
				email
			}),
			refresh_token: 'refresh'
		}
	})
}

async function importFixture(): Promise<{
	home: string
	paths: ReturnType<typeof applicationPaths>
}> {
	const home = await mkdtemp(join(tmpdir(), 'quotanaut-cli-import-test-'))
	temporaryDirectories.push(home)
	const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })
	return { home, paths }
}

test('import preflight parses private files before creating Quotanaut state', async () => {
	const { home, paths } = await importFixture()
	const source = join(home, 'auth.json')
	await writeFile(source, authJson('pilot@example.com'), { mode: 0o600 })

	const prepared = await prepareCodexAuthImports(paths, [source])

	expect(prepared.map(item => item.account.identity)).toEqual(['pilot@example.com'])
	expect(
		await stat(paths.root).then(
			() => true,
			() => false
		)
	).toBe(false)
})

test('import preflight rejects the whole batch when an identity repeats', async () => {
	const { home, paths } = await importFixture()
	const first = join(home, 'first.json')
	const second = join(home, 'second.json')
	await writeFile(first, authJson('pilot@example.com'), { mode: 0o600 })
	await writeFile(second, authJson('pilot@example.com'), { mode: 0o600 })

	await expect(prepareCodexAuthImports(paths, [first, second])).rejects.toMatchObject({
		code: 'DUPLICATE_IMPORT_IDENTITY'
	})
})

test('import preflight rejects unsafe modes and symbolic links', async () => {
	const { home, paths } = await importFixture()
	const source = join(home, 'auth.json')
	const link = join(home, 'linked.json')
	await writeFile(source, authJson('pilot@example.com'), { mode: 0o600 })
	await chmod(source, 0o640)

	await expect(prepareCodexAuthImports(paths, [source])).rejects.toMatchObject({
		code: 'IMPORT_SOURCE_MODE_INVALID'
	})
	await chmod(source, 0o600)
	await symlink(source, link)
	await expect(prepareCodexAuthImports(paths, [link])).rejects.toMatchObject({
		code: 'IMPORT_SOURCE_INVALID'
	})
})

test('import preflight rejects files inside the managed credential directory', async () => {
	const { paths } = await importFixture()
	await mkdir(paths.credentials, { mode: 0o700, recursive: true })
	const source = join(paths.credentials, 'codex-source')
	await writeFile(source, authJson('pilot@example.com'), { mode: 0o600 })

	await expect(prepareCodexAuthImports(paths, [source])).rejects.toMatchObject({
		code: 'IMPORT_SOURCE_MANAGED'
	})
})

test('applies an import, reports it immediately, and refreshes usage', async () => {
	const { home, paths } = await importFixture()
	await ensureApplicationPaths(paths)
	const source = join(home, 'auth.json')
	await writeFile(source, authJson('pilot@example.com'), { mode: 0o600 })
	const [prepared] = await prepareCodexAuthImports(paths, [source])
	if (prepared === undefined) {
		throw new Error('missing prepared import')
	}
	const store = createStateStore(paths.database)
	const vault = createFileSystemCredentialVault(paths.credentials)
	const existing: Account = {
		...prepared.account,
		createdAt: '2025-01-02T03:04:05.000Z',
		enabled: false,
		id: '00000000-0000-4000-8000-000000000099',
		onThreshold: 'spill',
		secretReference: 'codex:previous'
	}
	store.saveAccount(existing)
	await vault.write(existing.secretReference, 'old credential')
	try {
		const reported: string[] = []
		let refreshed = 0
		const imported = await applyCodexAuthImports([prepared], {
			onImported: account => reported.push(account.identity),
			onRefreshFailure: () => {
				throw new Error('refresh should succeed')
			},
			refreshUsage: async () => {
				refreshed += 1
			},
			saveAccount: async serializedAuth => {
				await vault.write(existing.secretReference, serializedAuth)
				return existing
			}
		})

		expect(imported).toHaveLength(1)
		expect(reported).toEqual(['pilot@example.com'])
		expect(refreshed).toBe(1)
		expect(await vault.read(existing.secretReference)).toBe(prepared.serializedAuth)
	} finally {
		store.close()
	}
})

test('reports committed imports immediately and refreshes them when a later item fails', async () => {
	const { home, paths } = await importFixture()
	const first = join(home, 'first.json')
	const second = join(home, 'second.json')
	await writeFile(first, authJson('first@example.com', 'acct-1', 'user-1'), { mode: 0o600 })
	await writeFile(second, authJson('second@example.com', 'acct-2', 'user-2'), { mode: 0o600 })
	const prepared = await prepareCodexAuthImports(paths, [first, second])
	const reported: string[] = []
	let attempts = 0
	let refreshed = 0

	await expect(
		applyCodexAuthImports(prepared, {
			onImported: account => reported.push(account.identity),
			onRefreshFailure: () => {
				throw new Error('refresh should succeed')
			},
			refreshUsage: async () => {
				refreshed += 1
			},
			saveAccount: async () => {
				const item = prepared[attempts++]
				if (attempts === 2) {
					expect(reported).toEqual(['first@example.com'])
					throw new Error('second import failed')
				}
				if (item === undefined) {
					throw new Error('missing prepared item')
				}
				return item.account
			}
		})
	).rejects.toMatchObject({
		code: 'IMPORT_PARTIAL_FAILURE',
		message:
			'Imported 1 of 2 Codex accounts before the batch stopped. Rerun the same command; Quotanaut safely updates identities that were already imported.'
	})
	expect(reported).toEqual(['first@example.com'])
	expect(refreshed).toBe(1)
})

test('keeps successful imports when immediate usage refresh fails', async () => {
	const { home, paths } = await importFixture()
	const source = join(home, 'auth.json')
	await writeFile(source, authJson('pilot@example.com'), { mode: 0o600 })
	const prepared = await prepareCodexAuthImports(paths, [source])
	let refreshWarnings = 0

	const imported = await applyCodexAuthImports(prepared, {
		onImported: () => undefined,
		onRefreshFailure: () => {
			refreshWarnings += 1
		},
		refreshUsage: async () => {
			throw new Error('provider unavailable')
		},
		saveAccount: async () => prepared[0]?.account ?? Promise.reject(new Error('missing item'))
	})

	expect(imported).toHaveLength(1)
	expect(refreshWarnings).toBe(1)
})

test('stale daemon cleanup keeps artifacts for a process that still exists', async () => {
	const home = await mkdtemp(join(tmpdir(), 'quotanaut-cli-test-'))
	temporaryDirectories.push(home)
	const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })
	await ensureApplicationPaths(paths)
	const lock = {
		createdAt: new Date().toISOString(),
		ownerId: crypto.randomUUID(),
		processId: 42
	}
	await writeFile(paths.managerLock, JSON.stringify(lock), { mode: 0o600 })
	await writeFile(paths.managerSocket, 'socket-placeholder', { mode: 0o600 })

	await expect(removeStaleDaemonArtifacts(paths, async () => true)).rejects.toMatchObject({
		code: 'DAEMON_NOT_REACHABLE'
	})
	expect(JSON.parse(await readFile(paths.managerLock, 'utf8'))).toEqual(lock)
	expect((await stat(paths.managerSocket)).isFile()).toBe(true)
})

test('stale daemon cleanup removes artifacts only after the recorded process is gone', async () => {
	const home = await mkdtemp(join(tmpdir(), 'quotanaut-cli-test-'))
	temporaryDirectories.push(home)
	const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })
	await ensureApplicationPaths(paths)
	await writeFile(
		paths.managerLock,
		JSON.stringify({
			createdAt: new Date().toISOString(),
			ownerId: crypto.randomUUID(),
			processId: 42
		}),
		{ mode: 0o600 }
	)
	await writeFile(paths.managerSocket, 'socket-placeholder', { mode: 0o600 })

	await removeStaleDaemonArtifacts(paths, async () => false)

	expect(await Bun.file(paths.managerLock).exists()).toBe(false)
	expect(await Bun.file(paths.managerSocket).exists()).toBe(false)
})
