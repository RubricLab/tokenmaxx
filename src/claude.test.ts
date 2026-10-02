import { describe, expect, test } from 'bun:test'
import {
	type ClaudeOauth,
	claudeUpstream,
	probeClaude,
	redeemClaudeReset,
	refreshClaudeCredential,
	registerClaudeAccount
} from './claude.ts'
import type { Account } from './domain.ts'
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

const stored: ClaudeOauth = {
	accessToken: 'old-access',
	expiresAt: 1_000,
	refreshToken: 'old-refresh',
	scopes: ['user:inference', 'user:profile'],
	subscriptionType: 'max'
}

const reference = 'claude:test'

function vaultWith(credential: ClaudeOauth) {
	return memoryVault({ [reference]: JSON.stringify(credential) })
}

describe('registerClaudeAccount', () => {
	test('the renamed profile field account.email is accepted as the identity', async () => {
		const vault = memoryVault({})
		const account = await registerClaudeAccount({
			dependencies: {
				captured: async command =>
					command[1] === 'find-generic-password'
						? { exitCode: 0, stdout: JSON.stringify({ claudeAiOauth: stored }) }
						: { exitCode: 0, stdout: '' },
				interactive: async () => ({ exitCode: 0, stderr: '' })
			},
			fetchImplementation: async () =>
				Response.json({
					account: {
						created_at: '2025-03-20T17:13:55.409225Z',
						display_name: 'Lennard',
						email: 'Lennard@Example.com',
						has_claude_max: true,
						has_claude_pro: false,
						uuid: 'account-uuid'
					},
					application: { name: 'Claude Code', slug: 'claude-code', uuid: 'app-uuid' },
					organization: { rate_limit_tier: 'default_claude_max_20x', uuid: 'org-uuid' }
				}),
			vault
		})
		expect(account.identity).toBe('lennard@example.com')
		expect(account.externalAccountId).toBe('org-uuid')
		expect(account.externalUserId).toBe('account-uuid')
		expect(vault.items.get(account.secretReference ?? '')).toBe(JSON.stringify(stored))
	})
})

describe('refreshClaudeCredential', () => {
	test('a rejected grant demands re-login and leaves the vault untouched', async () => {
		const vault = vaultWith(stored)
		expect(
			refreshClaudeCredential({
				fetchImplementation: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
				reference,
				vault
			})
		).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' })
		expect(vault.items.get(reference)).toBe(JSON.stringify(stored))
	})

	test('an upstream failure is retryable, never a re-login', async () => {
		const vault = vaultWith(stored)
		expect(
			refreshClaudeCredential({
				fetchImplementation: async () => new Response('overloaded', { status: 529 }),
				reference,
				vault
			})
		).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' })
		expect(vault.items.get(reference)).toBe(JSON.stringify(stored))
	})

	test('a successful exchange persists the rotated tokens before returning', async () => {
		const vault = vaultWith(stored)
		const before = Date.now()
		const updated = await refreshClaudeCredential({
			fetchImplementation: async () =>
				Response.json({
					access_token: 'new-access',
					expires_in: 3_600,
					refresh_token: 'new-refresh'
				}),
			reference,
			vault
		})
		expect(updated.accessToken).toBe('new-access')
		expect(updated.refreshToken).toBe('new-refresh')
		expect(updated.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
		expect(updated.subscriptionType).toBe('max')
		expect(JSON.parse(vault.items.get(reference) ?? '{}')).toEqual(updated)
	})

	test('a caller holding an already-rotated token gets the current credential without a second exchange', async () => {
		const vault = vaultWith({ ...stored, accessToken: 'rotated-access' })
		let exchanges = 0
		const result = await refreshClaudeCredential({
			fetchImplementation: async () => {
				exchanges += 1
				return Response.json({ access_token: 'x', expires_in: 3_600 })
			},
			reference,
			staleAccessToken: 'old-access',
			vault
		})
		expect(exchanges).toBe(0)
		expect(result.accessToken).toBe('rotated-access')
	})
})

describe('api key accounts', () => {
	test('an api key account injects x-api-key and strips the oauth header', async () => {
		const vault = memoryVault({ 'claude-key:1': 'sk-ant-test' })
		const injection = await claudeUpstream({
			account: {
				auth: 'apiKey',
				createdAt: '2026-07-01T00:00:00.000Z',
				enabled: true,
				externalAccountId: null,
				externalUserId: null,
				health: 'ready',
				id: '00000000-0000-4000-8000-000000000201',
				identity: 'work api key',
				label: 'work api key',
				onThreshold: 'switch',
				plan: 'api',
				profilePath: null,
				provider: 'anthropic',
				secretReference: 'claude-key:1',
				updatedAt: '2026-07-01T00:00:00.000Z'
			},
			forceRefresh: false,
			vault
		})
		expect(injection.baseUrl).toBe('https://api.anthropic.com')
		expect(injection.headers['x-api-key']).toBe('sk-ant-test')
		expect(injection.stripHeaders).toContain('authorization')
	})
})

describe('claude banked resets on the wire', () => {
	const oauthAccount: Extract<Account, { provider: 'anthropic' }> = {
		auth: 'oauth',
		createdAt: '2026-09-01T00:00:00.000Z',
		enabled: true,
		externalAccountId: 'account-uuid',
		externalUserId: null,
		health: 'ready',
		id: '00000000-0000-4000-8000-000000000301',
		identity: 'max@example.com',
		label: 'max@example.com',
		onThreshold: 'switch',
		plan: null,
		profilePath: null,
		provider: 'anthropic',
		secretReference: reference,
		updatedAt: '2026-09-01T00:00:00.000Z'
	}
	const fresh = { ...stored, expiresAt: Date.now() + 3_600_000 }
	const profile = {
		account: { email: 'max@example.com', uuid: 'account-uuid' },
		organization: { rate_limit_tier: 'default_claude_max_20x', uuid: 'org-uuid' }
	}
	const usage = {
		cedar_ember: {
			at_limit: false,
			cooldown_until: null,
			eligible: true,
			exhausted: [],
			grants: [
				{
					ends_at: '2026-10-22T16:00:00+00:00',
					id: 'opus55-launch-promax-20260921',
					label: 'Claude Opus 5.5 launch: one usage-limit reset for Pro and Max',
					paused: false,
					resets_left: 1,
					resets_total: 1,
					usable_now: true,
					use_requires_limit: false
				}
			],
			ineligible_reason: null,
			next_grant_id: 'opus55-launch-promax-20260921'
		},
		five_hour: { resets_at: '2026-10-01T06:10:00.137634+00:00', utilization: 17 },
		seven_day: { resets_at: '2026-10-01T13:00:00.137657+00:00', utilization: 16 }
	}

	test('the cedar_ember grants on the usage payload become the banked reset count', async () => {
		const requested: string[] = []
		const result = await probeClaude({
			account: oauthAccount,
			fetchImplementation: async request => {
				requested.push(String(request))
				return Response.json(String(request).includes('/profile') ? profile : usage)
			},
			now: () => new Date(),
			vault: vaultWith(fresh)
		})
		expect(requested).toContain('https://api.anthropic.com/api/oauth/usage?cedar_ember=1')
		expect(result.usage.resetCredits).toEqual({ applicable: 1, available: 1 })
	})

	test('redeeming claims the next grant for the profile organization', async () => {
		let claim: unknown = null
		const outcome = await redeemClaudeReset({
			account: oauthAccount,
			fetchImplementation: async (request, initialization) => {
				const url = String(request)
				if (initialization?.method === 'POST') {
					claim = { body: JSON.parse(String(initialization.body)), url }
					return Response.json({
						cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'],
						resets_left: 0,
						result: 'reset'
					})
				}
				return Response.json(url.includes('/profile') ? profile : usage)
			},
			requestId: 'request-1',
			vault: vaultWith(fresh)
		})
		expect(claim).toEqual({
			body: {
				grant_id: 'opus55-launch-promax-20260921',
				program: 'cedar_ember',
				request_id: 'request-1'
			},
			url: 'https://api.anthropic.com/api/organizations/org-uuid/reset_rate_limits'
		})
		expect(outcome).toEqual({ code: 'reset', windowsReset: 3 })
	})
})

describe('one claude login with a personal and a team subscription', () => {
	// a fresh access token per probe, so the verified-identity cache never answers for another test
	const fresh = { ...stored, expiresAt: Date.now() + 3_600_000 }
	const usage = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }
	const teamAccount: Extract<Account, { provider: 'anthropic' }> = {
		auth: 'oauth',
		createdAt: '2026-09-01T00:00:00.000Z',
		enabled: true,
		externalAccountId: 'team-org',
		externalUserId: 'user-uuid',
		health: 'ready',
		id: '00000000-0000-4000-8000-000000000401',
		identity: 'dev@example.com',
		label: 'dev@example.com (team)',
		onThreshold: 'switch',
		plan: 'team',
		profilePath: null,
		provider: 'anthropic',
		secretReference: reference,
		updatedAt: '2026-09-01T00:00:00.000Z'
	}
	const probe = (account: Extract<Account, { provider: 'anthropic' }>, organization: string) =>
		probeClaude({
			account,
			fetchImplementation: async request =>
				Response.json(
					String(request).includes('/profile')
						? {
								account: { email: 'dev@example.com', uuid: 'user-uuid' },
								organization: { uuid: organization }
							}
						: usage
				),
			now: () => new Date(),
			vault: memoryVault({
				[reference]: JSON.stringify({ ...fresh, accessToken: crypto.randomUUID() })
			})
		})

	test('a row saved before organizations were recorded gets its organization on the next probe', async () => {
		const legacy = { ...teamAccount, externalAccountId: 'user-uuid', externalUserId: null }
		const result = await probe({ ...legacy, label: 'dev@example.com' }, 'personal-org')
		expect(result.account.externalAccountId).toBe('personal-org')
		expect(result.account.externalUserId).toBe('user-uuid')
		expect(result.account.label).toBe('dev@example.com')
	})

	test('a probe keeps the qualified label of the second subscription', async () => {
		const result = await probe(teamAccount, 'team-org')
		expect(result.account.label).toBe('dev@example.com (team)')
		expect(result.account.identity).toBe('dev@example.com')
	})

	test('a credential that now answers for another organization is flagged', async () => {
		await expect(probe(teamAccount, 'personal-org')).rejects.toMatchObject({
			code: 'IDENTITY_CHANGED'
		})
	})
})
