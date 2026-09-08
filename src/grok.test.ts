import { describe, expect, test } from 'bun:test'
import type { Account, UsageSnapshot } from './domain.ts'
import {
	type GrokAuth,
	grokUpstream,
	probeGrok,
	refreshGrokCredential,
	registerGrokAccount
} from './grok.ts'
import { xaiLimitWindow } from './ratelimit.ts'
import type { CredentialVault } from './vault.ts'

function memoryVault(initial: Record<string, string>): CredentialVault & {
	items: Map<string, string>
} {
	const items = new Map(Object.entries(initial))
	return {
		items,
		read: async reference => items.get(reference) ?? null,
		remove: async reference => {
			items.delete(reference)
		},
		write: async (reference, value) => {
			items.set(reference, value)
		}
	}
}

const reference = 'grok:test'
const stored: GrokAuth = {
	auth_mode: 'oidc',
	email: 'Dexter@RubricLabs.com',
	expires_at: '2026-07-20T18:00:00.000Z',
	key: 'old-key',
	oidc_client_id: 'client-1',
	oidc_issuer: 'https://auth.x.ai',
	refresh_token: 'old-refresh',
	user_id: 'user-1'
}
const authFile = JSON.stringify({ 'https://auth.x.ai::client-1': stored })

const account: Extract<Account, { provider: 'xai' }> = {
	auth: 'oauth',
	createdAt: '2026-07-01T00:00:00.000Z',
	enabled: true,
	externalAccountId: 'user-1',
	externalUserId: null,
	health: 'ready',
	id: '00000000-0000-4000-8000-000000000001',
	identity: 'dexter@rubriclabs.com',
	label: 'dexter@rubriclabs.com',
	onThreshold: 'switch',
	plan: null,
	profilePath: null,
	provider: 'xai',
	secretReference: reference,
	updatedAt: '2026-07-01T00:00:00.000Z'
}

const tokenResponse = () =>
	Response.json({ access_token: 'new-key', expires_in: 21_600, refresh_token: 'new-refresh' })

function vaultWith(credential: GrokAuth = stored) {
	return memoryVault({ [reference]: JSON.stringify(credential) })
}

describe('registerGrokAccount', () => {
	test('imports the isolated login and stores the whole record', async () => {
		const vault = memoryVault({})
		const removed: string[] = []
		const account = await registerGrokAccount({
			dependencies: {
				createTemporaryDirectory: async () => '/tmp/grok-home',
				read: async path => {
					expect(path).toBe('/tmp/grok-home/auth.json')
					return authFile
				},
				remove: async path => {
					removed.push(path)
				},
				run: async (command, environment) => {
					expect(command).toEqual(['grok', 'login'])
					expect(environment.GROK_HOME).toBe('/tmp/grok-home')
					return { exitCode: 0, stderr: '' }
				}
			},
			vault
		})
		expect(account.provider).toBe('xai')
		expect(account.identity).toBe('dexter@rubriclabs.com')
		expect(account.externalAccountId).toBe('user-1')
		expect(account.secretReference).toBe(`grok:${account.id}`)
		expect(JSON.parse(vault.items.get(account.secretReference ?? '') ?? '{}')).toEqual(stored)
		expect(removed).toEqual(['/tmp/grok-home'])
	})

	test('a failed login surfaces the cli error', async () => {
		await expect(
			registerGrokAccount({
				dependencies: {
					createTemporaryDirectory: async () => '/tmp/grok-home',
					read: async () => authFile,
					remove: async () => undefined,
					run: async () => ({ exitCode: 1, stderr: 'error: subscription required\n' })
				},
				vault: memoryVault({})
			})
		).rejects.toThrow('grok login: error: subscription required')
	})
})

describe('refreshGrokCredential', () => {
	test('posts the refresh grant and stores the rotated tokens', async () => {
		const vault = vaultWith()
		let body = ''
		const refreshed = await refreshGrokCredential({
			fetchImplementation: async (input, initialization) => {
				expect(String(input)).toBe('https://auth.x.ai/oauth2/token')
				body = String(initialization?.body)
				return tokenResponse()
			},
			reference,
			vault
		})
		expect(new URLSearchParams(body).get('grant_type')).toBe('refresh_token')
		expect(new URLSearchParams(body).get('client_id')).toBe('client-1')
		expect(new URLSearchParams(body).get('refresh_token')).toBe('old-refresh')
		expect(refreshed.key).toBe('new-key')
		expect(refreshed.refresh_token).toBe('new-refresh')
		expect(refreshed.user_id).toBe('user-1')
		expect(JSON.parse(vault.items.get(reference) ?? '{}').key).toBe('new-key')
	})

	test('a rejected refresh token asks for a new login', async () => {
		await expect(
			refreshGrokCredential({
				fetchImplementation: async () => new Response('', { status: 401 }),
				reference,
				vault: vaultWith()
			})
		).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' })
	})

	test('a stale caller does not refresh a credential someone else already rotated', async () => {
		let calls = 0
		const refreshed = await refreshGrokCredential({
			fetchImplementation: async () => {
				calls += 1
				return tokenResponse()
			},
			reference,
			staleKey: 'not-the-current-key',
			vault: vaultWith()
		})
		expect(calls).toBe(0)
		expect(refreshed.key).toBe('old-key')
	})
})

describe('grokUpstream', () => {
	test('a session account carries the cli token header to the chat proxy', async () => {
		const injection = await grokUpstream({
			account,
			forceRefresh: false,
			now: () => Date.parse('2026-07-20T12:00:00.000Z'),
			vault: vaultWith()
		})
		expect(injection.baseUrl).toBe('https://cli-chat-proxy.grok.com')
		expect(injection.headers.authorization).toBe('Bearer old-key')
		expect(injection.headers['x-xai-token-auth']).toBe('xai-grok-cli')
	})

	test('a token inside the refresh margin is refreshed first', async () => {
		const injection = await grokUpstream({
			account,
			fetchImplementation: async () => tokenResponse(),
			forceRefresh: false,
			now: () => Date.parse('2026-07-20T17:59:00.000Z'),
			vault: vaultWith()
		})
		expect(injection.headers.authorization).toBe('Bearer new-key')
	})

	test('an api key account routes to the public api with its key', async () => {
		const injection = await grokUpstream({
			account: { ...account, auth: 'apiKey', secretReference: 'grok-key:1' },
			forceRefresh: false,
			vault: memoryVault({ 'grok-key:1': 'xai-test-123' })
		})
		expect(injection.baseUrl).toBe('https://api.x.ai')
		expect(injection.headers.authorization).toBe('Bearer xai-test-123')
		expect(injection.stripHeaders).toContain('x-xai-token-auth')
	})
})

describe('probeGrok', () => {
	const userinfo = async () => Response.json({ email: 'dexter@rubriclabs.com', sub: 'user-1' })
	const now = () => new Date('2026-07-20T12:00:00.000Z')
	const existing = (window: UsageSnapshot['windows'][number]): UsageSnapshot => ({
		accountId: account.id,
		extraUsage: null,
		hardLimitReached: true,
		measuredSpendUsd: null,
		observedAt: '2026-07-20T11:59:00.000Z',
		provider: 'xai',
		source: 'proxyResponseHeaders',
		windows: [window]
	})

	test('reports an empty limit window when nothing is held', async () => {
		const result = await probeGrok({
			account,
			existing: null,
			fetchImplementation: userinfo,
			now,
			vault: vaultWith()
		})
		expect(result.account.health).toBe('ready')
		expect(result.usage.source).toBe('grokProbe')
		expect(result.usage.hardLimitReached).toBe(false)
		expect(result.usage.windows).toEqual([xaiLimitWindow(0, null)])
	})

	test('keeps a limit whose reset is still ahead', async () => {
		const held = xaiLimitWindow(100, '2026-07-20T12:30:00.000Z')
		const result = await probeGrok({
			account,
			existing: existing(held),
			fetchImplementation: userinfo,
			now,
			vault: vaultWith()
		})
		expect(result.usage.hardLimitReached).toBe(true)
		expect(result.usage.windows).toEqual([held])
	})

	test('clears a limit once its reset has passed, and one with no reset at all', async () => {
		for (const resetAt of ['2026-07-20T11:00:00.000Z', null]) {
			const result = await probeGrok({
				account,
				existing: existing(xaiLimitWindow(100, resetAt)),
				fetchImplementation: userinfo,
				now,
				vault: vaultWith()
			})
			expect(result.usage.hardLimitReached).toBe(false)
			expect(result.usage.windows).toEqual([xaiLimitWindow(0, null)])
		}
	})

	test('a rejected token is refreshed once and the identity re-verified', async () => {
		let userinfoCalls = 0
		const vault = memoryVault({ 'grok:rejected': JSON.stringify(stored) })
		const result = await probeGrok({
			account: { ...account, secretReference: 'grok:rejected' },
			existing: null,
			fetchImplementation: async input => {
				if (String(input).endsWith('/oauth2/token')) {
					return tokenResponse()
				}
				userinfoCalls += 1
				return userinfoCalls === 1 ? new Response('', { status: 401 }) : userinfo()
			},
			now,
			vault
		})
		expect(result.account.health).toBe('ready')
		expect(userinfoCalls).toBe(2)
		expect(JSON.parse(vault.items.get('grok:rejected') ?? '{}').key).toBe('new-key')
	})

	test('a credential for another account is refused', async () => {
		await expect(
			probeGrok({
				account: { ...account, secretReference: 'grok:other' },
				existing: null,
				fetchImplementation: async () => Response.json({ email: 'someone@else.com' }),
				now,
				vault: memoryVault({ 'grok:other': JSON.stringify(stored) })
			})
		).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' })
	})

	test('an api key account is validated against the models endpoint', async () => {
		const result = await probeGrok({
			account: { ...account, auth: 'apiKey', secretReference: 'grok-key:1' },
			existing: null,
			fetchImplementation: async input => {
				expect(String(input)).toBe('https://api.x.ai/v1/models')
				return Response.json({ data: [] })
			},
			now,
			vault: memoryVault({ 'grok-key:1': 'xai-test-123' })
		})
		expect(result.usage.source).toBe('apiKeyProbe')
		expect(result.usage.windows).toEqual([])
	})
})
