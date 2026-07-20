import { describe, expect, test } from 'bun:test'
import { probeCodex, probeCodexResetCredits, redeemCodexResetCredit } from './codex.ts'
import type { Account } from './domain.ts'
import type { CredentialVault } from './vault.ts'

function memoryVault(initial: Record<string, string>): CredentialVault {
	const items = new Map(Object.entries(initial))
	return {
		read: async reference => items.get(reference) ?? null,
		remove: async reference => {
			items.delete(reference)
		},
		write: async (reference, value) => {
			items.set(reference, value)
		}
	}
}

function fakeJwt(claims: object): string {
	const header = Buffer.from('{"alg":"none"}').toString('base64url')
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
	return `${header}.${payload}.signature`
}

const reference = 'codex:test'
const credential = JSON.stringify({
	tokens: {
		access_token: fakeJwt({
			exp: 4_102_444_800,
			'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' }
		}),
		account_id: 'acct-1',
		id_token: fakeJwt({
			chatgpt_account_id: 'acct-1',
			chatgpt_user_id: 'user-1',
			email: 'dexter@rubriclabs.com'
		}),
		refresh_token: 'refresh'
	}
})

const account: Extract<Account, { provider: 'openai' }> = {
	createdAt: '2026-07-01T00:00:00.000Z',
	enabled: true,
	externalAccountId: 'acct-1',
	externalUserId: 'user-1',
	health: 'ready',
	id: '00000000-0000-4000-8000-000000000001',
	identity: 'dexter@rubriclabs.com',
	label: 'dexter@rubriclabs.com',
	plan: 'pro',
	profilePath: null,
	provider: 'openai',
	secretReference: reference,
	updatedAt: '2026-07-01T00:00:00.000Z'
}

describe('codex reset credits on the wire', () => {
	test('the usage payload carries banked reset counts into the snapshot', async () => {
		const result = await probeCodex({
			account,
			fetchImplementation: async () =>
				Response.json({
					additional_rate_limits: [],
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: {
							limit_window_seconds: 604_800,
							reset_at: 1_785_131_424,
							used_percent: 96
						},
						secondary_window: null
					},
					rate_limit_reached_type: null,
					rate_limit_reset_credits: { applicable_available_count: 0, available_count: 3 }
				}),
			now: () => new Date('2026-07-20T12:00:00.000Z'),
			vault: memoryVault({ [reference]: credential })
		})
		expect(result.usage.provider).toBe('openai')
		expect(result.usage.provider === 'openai' && result.usage.resetCredits).toEqual({
			applicable: 0,
			available: 3
		})
	})

	test('the credits list keeps only available credits, soonest expiry first', async () => {
		const view = await probeCodexResetCredits({
			account,
			fetchImplementation: async () =>
				Response.json({
					available_count: 2,
					credits: [
						{
							expires_at: '2026-08-11T21:09:53.644193Z',
							granted_at: '2026-07-12T21:09:53.644193Z',
							id: 'RateLimitResetCredit_later',
							is_supported_by_plan: true,
							reset_type: 'codex_rate_limits',
							status: 'available',
							title: 'Full reset'
						},
						{
							expires_at: '2026-07-31T20:06:53.997918Z',
							granted_at: '2026-07-01T20:06:53.997918Z',
							id: 'RateLimitResetCredit_sooner',
							status: 'available',
							title: 'Full reset'
						},
						{
							expires_at: '2026-07-25T00:00:00.000000Z',
							granted_at: '2026-06-25T00:00:00.000000Z',
							id: 'RateLimitResetCredit_spent',
							status: 'redeemed',
							title: 'Full reset'
						}
					]
				}),
			vault: memoryVault({ [reference]: credential })
		})
		expect(view.available).toBe(2)
		expect(view.credits.map(credit => credit.id)).toEqual([
			'RateLimitResetCredit_sooner',
			'RateLimitResetCredit_later'
		])
		expect(view.credits[0]?.expiresAt).toBe('2026-07-31T20:06:53.997Z')
	})

	test('consuming sends the idempotency key and returns the server verdict', async () => {
		let requestBody: unknown
		const outcome = await redeemCodexResetCredit({
			account,
			fetchImplementation: async (_, initialization) => {
				requestBody = JSON.parse(String(initialization?.body))
				return Response.json({ code: 'reset', windows_reset: 2 })
			},
			redeemRequestId: 'idempotency-1',
			vault: memoryVault({ [reference]: credential })
		})
		expect(requestBody).toEqual({ redeem_request_id: 'idempotency-1' })
		expect(outcome).toEqual({ code: 'reset', windowsReset: 2 })
	})
})
