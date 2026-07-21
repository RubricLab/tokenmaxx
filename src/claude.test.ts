import { describe, expect, test } from 'bun:test'
import { type ClaudeOauth, refreshClaudeCredential, registerClaudeAccount } from './claude.ts'
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
		expect(account.externalAccountId).toBe('account-uuid')
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
