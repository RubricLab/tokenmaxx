import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account, FetchImplementation } from './domain.ts'
import { AccountManager } from './manager.ts'
import { applicationPaths } from './paths.ts'
import { createStateStore } from './storage.ts'
import type { CredentialVault } from './vault.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
	)
})

function account(secretReference: string): Account {
	return {
		auth: 'oauth',
		createdAt: '2026-08-12T00:00:00.000Z',
		enabled: true,
		externalAccountId: 'account-1',
		externalUserId: 'user-1',
		health: 'ready',
		id: '00000000-0000-4000-8000-000000000001',
		identity: 'user@example.com',
		label: 'user@example.com',
		onThreshold: 'switch',
		plan: 'pro',
		profilePath: null,
		provider: 'openai',
		secretReference,
		updatedAt: '2026-08-12T00:00:00.000Z'
	}
}

function usageResponse(usedPercent = 5): Response {
	return Response.json({
		additional_rate_limits: [],
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				limit_window_seconds: 18_000,
				reset_at: 1_785_131_424,
				used_percent: usedPercent
			},
			secondary_window: null
		},
		rate_limit_reached_type: null
	})
}

function fakeJwt(claims: object): string {
	return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

function authJson(marker: string): string {
	return JSON.stringify({
		tokens: {
			access_token: fakeJwt({
				exp: 4_102_444_800,
				'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
				marker
			}),
			account_id: 'account-1',
			id_token: fakeJwt({
				chatgpt_account_id: 'account-1',
				chatgpt_user_id: 'user-1',
				email: 'user@example.com'
			}),
			refresh_token: `refresh-${marker}`
		}
	})
}

function accessMarker(initialization: RequestInit | undefined): string | null {
	const authorization = new Headers(initialization?.headers).get('Authorization') ?? ''
	const token = authorization.replace(/^Bearer\s+/i, '')
	const payload = token.split('.')[1]
	return payload === undefined
		? null
		: ((JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { marker?: string })
				.marker ?? null)
}

async function managerWithVault(
	vault: CredentialVault,
	dependencies: { fetchImplementation?: FetchImplementation } = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'quotanaut-manager-test-'))
	temporaryDirectories.push(root)
	const paths = applicationPaths({ QUOTANAUT_HOME: root })
	const store = createStateStore(paths.database)
	return { manager: new AccountManager({ dependencies, paths, store, vault }), store }
}

describe('credential cleanup failures', () => {
	test('rolls an account replacement back so the caller can remove its provisional credential', async () => {
		const removed: string[] = []
		const values = new Map([['codex:previous', 'previous credential']])
		const vault: CredentialVault = {
			read: async reference => values.get(reference) ?? null,
			remove: async reference => {
				removed.push(reference)
				if (reference === 'codex:previous') {
					throw new Error('old credential is not removable')
				}
				values.delete(reference)
			},
			write: async (reference, value) => {
				values.set(reference, value)
			}
		}
		const { manager, store } = await managerWithVault(vault)
		const previous = account('codex:previous')
		store.saveAccount(previous)

		await expect(
			manager.saveAccount({
				serializedAuth: authJson('replacement')
			})
		).rejects.toThrow('old credential is not removable')
		expect(removed).toEqual(['codex:previous', `codex:${previous.id}`])
		expect(store.findAccount(previous.id)?.secretReference).toBe('codex:previous')
		expect(values).toEqual(new Map([['codex:previous', 'previous credential']]))
		store.close()
	})

	test('serializes concurrent replacements and keeps only the authoritative credential', async () => {
		const values = new Map([['codex:previous', 'previous credential']])
		const vault: CredentialVault = {
			read: async reference => values.get(reference) ?? null,
			remove: async reference => {
				values.delete(reference)
			},
			write: async (reference, value) => {
				values.set(reference, value)
			}
		}
		const { manager, store } = await managerWithVault(vault)
		const previous = account('codex:previous')
		store.saveAccount(previous)

		const results = await Promise.all(
			['first', 'second'].map(marker =>
				manager.saveAccount({
					serializedAuth: authJson(marker)
				})
			)
		)

		const authoritativeReference = `codex:${previous.id}`
		expect(results.map(result => result.secretReference)).toEqual([
			authoritativeReference,
			authoritativeReference
		])
		expect(store.findAccount(previous.id)?.secretReference).toBe(authoritativeReference)
		expect([...values.keys()]).toEqual([authoritativeReference])
		expect(values.get(authoritativeReference)).toContain('refresh-second')
		store.close()
	})

	test('keeps the database account when logout cannot remove its credential', async () => {
		const vault: CredentialVault = {
			read: async () => null,
			remove: async () => {
				throw new Error('credential is not removable')
			},
			write: async () => undefined
		}
		const { manager, store } = await managerWithVault(vault)
		const existing = account('codex:existing')
		store.saveAccount(existing)

		await expect(manager.removeAccount(existing.id)).rejects.toThrow('credential is not removable')
		expect(store.findAccount(existing.id)).toEqual(existing)
		store.close()
	})

	test('refresh re-reads the account after a queued replacement changes its credential reference', async () => {
		const fetchedMarkers: (string | null)[] = []
		const values = new Map([['codex:previous', authJson('old')]])
		let allowReplacementRemoval!: () => void
		let observeReplacementRemoval!: () => void
		const replacementRemovalReached = new Promise<void>(resolve => {
			observeReplacementRemoval = resolve
		})
		const replacementRemovalRelease = new Promise<void>(resolve => {
			allowReplacementRemoval = resolve
		})
		const vault: CredentialVault = {
			read: async reference => values.get(reference) ?? null,
			remove: async reference => {
				if (reference === 'codex:previous') {
					observeReplacementRemoval()
					await replacementRemovalRelease
				}
				values.delete(reference)
			},
			write: async (reference, value) => {
				values.set(reference, value)
			}
		}
		const { manager, store } = await managerWithVault(vault, {
			fetchImplementation: async (_input, initialization) => {
				fetchedMarkers.push(accessMarker(initialization))
				return usageResponse()
			}
		})
		const previous = account('codex:previous')
		store.saveAccount(previous)

		const replacement = manager.saveAccount({
			serializedAuth: authJson('replacement')
		})
		await replacementRemovalReached
		const refresh = manager.refreshAccount(previous)
		allowReplacementRemoval()
		await replacement
		await refresh

		expect(fetchedMarkers).toEqual(['replacement'])
		expect(store.findAccount(previous.id)?.secretReference).toBe(`codex:${previous.id}`)
		store.close()
	})

	test('logout re-reads the account after a queued replacement changes its credential reference', async () => {
		const values = new Map([['codex:previous', authJson('old')]])
		let allowReplacementRemoval!: () => void
		let observeReplacementRemoval!: () => void
		const replacementRemovalReached = new Promise<void>(resolve => {
			observeReplacementRemoval = resolve
		})
		const replacementRemovalRelease = new Promise<void>(resolve => {
			allowReplacementRemoval = resolve
		})
		const vault: CredentialVault = {
			read: async reference => values.get(reference) ?? null,
			remove: async reference => {
				if (reference === 'codex:previous') {
					observeReplacementRemoval()
					await replacementRemovalRelease
				}
				values.delete(reference)
			},
			write: async (reference, value) => {
				values.set(reference, value)
			}
		}
		const { manager, store } = await managerWithVault(vault)
		const previous = account('codex:previous')
		store.saveAccount(previous)

		const replacement = manager.saveAccount({
			serializedAuth: authJson('replacement')
		})
		await replacementRemovalReached
		const logout = manager.removeAccount(previous.id)
		allowReplacementRemoval()
		await replacement
		await logout

		expect(store.findAccount(previous.id)).toBeNull()
		expect([...values.keys()]).toEqual([])
		store.close()
	})
})
