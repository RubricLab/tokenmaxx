import { describe, expect, test } from 'bun:test'
import type { CredentialVault } from '../../vault.ts'
import { type ClaudeOauth, refreshClaudeCredential } from './auth.ts'

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
