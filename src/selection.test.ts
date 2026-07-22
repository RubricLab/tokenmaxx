import { describe, expect, test } from 'bun:test'
import type { Account, ProviderState, UsageSnapshot } from './domain.ts'
import { selectRotation } from './selection.ts'

const NOW = new Date('2026-07-16T17:30:00.000Z')

function account(n: number, health: Account['health'] = 'ready'): Account {
	return {
		auth: 'oauth',
		createdAt: '2026-06-01T00:00:00.000Z',
		enabled: true,
		externalAccountId: `acct_${n}`,
		externalUserId: null,
		health,
		id: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
		identity: `user${n}@example.com`,
		label: `user${n}@example.com`,
		onThreshold: 'switch',
		plan: 'max',
		profilePath: `/tmp/profiles/${n}`,
		provider: 'anthropic',
		secretReference: null,
		updatedAt: '2026-07-16T17:00:00.000Z'
	}
}

function usage(
	n: number,
	usedPercent: number,
	options: { hardLimitReached?: boolean; ageMs?: number } = {}
): UsageSnapshot {
	return {
		accountId: account(n).id,
		extraUsage: null,
		hardLimitReached: options.hardLimitReached ?? false,
		measuredSpendUsd: null,
		observedAt: new Date(NOW.getTime() - (options.ageMs ?? 10_000)).toISOString(),
		provider: 'anthropic',
		source: 'proxyResponseHeaders',
		windows: [{ id: 'session', kind: 'hard', label: '5h session', resetAt: null, usedPercent }]
	}
}

function state(
	activeN: number,
	options: { switchedAgoMs?: number; threshold?: number } = {}
): ProviderState {
	return {
		activeAccountId: account(activeN).id,
		generation: 3,
		policy: {
			authorization: 'confirmed',
			enabled: true,
			hiddenWindowIds: [],
			hysteresisPercent: 5,
			maximumSnapshotAgeMilliseconds: 420_000,
			minimumDwellMilliseconds: 300_000,
			provider: 'anthropic',
			thresholdPercent: options.threshold ?? 90
		},
		provider: 'anthropic',
		switchedAt:
			options.switchedAgoMs === undefined
				? null
				: new Date(NOW.getTime() - options.switchedAgoMs).toISOString()
	}
}

describe('selectRotation', () => {
	test('rotates at the threshold onto the emptiest fresh candidate', () => {
		const decision = selectRotation({
			accounts: [account(1), account(2), account(3)],
			now: NOW,
			state: state(1),
			usage: [usage(1, 92), usage(2, 40), usage(3, 10)]
		})
		expect(decision).toMatchObject({
			reason: 'threshold',
			rotate: true,
			targetAccountId: account(3).id
		})
	})

	test('threshold rotation respects the dwell hold', () => {
		const decision = selectRotation({
			accounts: [account(1), account(2)],
			now: NOW,
			state: state(1, { switchedAgoMs: 60_000 }),
			usage: [usage(1, 95), usage(2, 10)]
		})
		expect(decision).toEqual({ reason: 'minimumDwell', rotate: false })
	})

	test('hard limit ignores the dwell hold', () => {
		const decision = selectRotation({
			accounts: [account(1), account(2)],
			now: NOW,
			state: state(1, { switchedAgoMs: 60_000 }),
			usage: [usage(1, 100, { hardLimitReached: true }), usage(2, 10)]
		})
		expect(decision).toMatchObject({ reason: 'hardLimit', rotate: true })
	})

	test('never rotates onto a hard-limited or over-ceiling candidate', () => {
		const decision = selectRotation({
			accounts: [account(1), account(2), account(3)],
			now: NOW,
			state: state(1),
			usage: [
				usage(1, 100, { hardLimitReached: true }),
				usage(2, 30, { hardLimitReached: true }),
				usage(3, 88)
			]
		})
		expect(decision).toEqual({ reason: 'noEligibleCandidate', rotate: false })
	})

	test('a candidate probed five minutes ago is still eligible', () => {
		const decision = selectRotation({
			accounts: [account(1), account(2)],
			now: NOW,
			state: state(1),
			usage: [usage(1, 96), usage(2, 15, { ageMs: 5 * 60_000 + 30_000 })]
		})
		expect(decision).toMatchObject({ rotate: true, targetAccountId: account(2).id })
	})

	test('stays put below the threshold', () => {
		const decision = selectRotation({
			accounts: [account(1), account(2)],
			now: NOW,
			state: state(1),
			usage: [usage(1, 62), usage(2, 5)]
		})
		expect(decision).toEqual({ reason: 'belowThreshold', rotate: false })
	})

	test('refuses to rotate on stale active usage', () => {
		const decision = selectRotation({
			accounts: [account(1), account(2)],
			now: NOW,
			state: state(1),
			usage: [usage(1, 99, { ageMs: 10 * 60_000 }), usage(2, 5)]
		})
		expect(decision).toEqual({ reason: 'activeUsageStale', rotate: false })
	})
})

describe('extra usage spill', () => {
	const extra = (exhausted: boolean) => ({
		balanceUsd: 20,
		enabled: true,
		exhausted,
		limitUsd: null,
		spentUsd: null,
		usedPercent: null
	})

	test('an account set to spill holds through the threshold while credits remain', () => {
		const spiller = { ...account(1), onThreshold: 'spill' as const }
		const decision = selectRotation({
			accounts: [spiller, account(2)],
			now: NOW,
			state: state(1),
			usage: [{ ...usage(1, 96), extraUsage: extra(false) }, usage(2, 10)]
		})
		expect(decision).toEqual({ reason: 'spillingIntoExtraUsage', rotate: false })
	})

	test('exhausted credits end the spill and rotation resumes', () => {
		const spiller = { ...account(1), onThreshold: 'spill' as const }
		const decision = selectRotation({
			accounts: [spiller, account(2)],
			now: NOW,
			state: state(1),
			usage: [{ ...usage(1, 96), extraUsage: extra(true) }, usage(2, 10)]
		})
		expect(decision.rotate).toBe(true)
	})
})
