import { z } from 'zod'
import {
	type Account,
	type ProviderState,
	type UsageSnapshot,
	UsageSnapshotSchema
} from './domain.ts'

export const RotationDecisionSchema = z.discriminatedUnion('rotate', [
	z.object({
		reason: z.enum(['threshold', 'hardLimit']),
		rotate: z.literal(true),
		sourceAccountId: z.uuid(),
		sourcePressure: z.number().min(0).max(100),
		targetAccountId: z.uuid(),
		targetPressure: z.number().min(0).max(100)
	}),
	z.object({
		reason: z.enum([
			'disabled',
			'authorizationRequired',
			'noActiveAccount',
			'activeUsageUnknown',
			'activeUsageStale',
			'belowThreshold',
			'minimumDwell',
			'noEligibleCandidate'
		]),
		rotate: z.literal(false)
	})
])
export type RotationDecision = z.infer<typeof RotationDecisionSchema>

export interface RotationInput {
	accounts: readonly Account[]
	usage: readonly UsageSnapshot[]
	state: ProviderState
	now: Date
}

function hardPressure(snapshot: UsageSnapshot): number | null {
	const pressures = snapshot.windows
		.filter(window => window.kind === 'hard')
		.map(window => window.usedPercent)
	return pressures.length === 0 ? null : Math.max(...pressures)
}

function isFresh(snapshot: UsageSnapshot, now: Date, maximumAgeMilliseconds: number): boolean {
	const observedAt = Date.parse(snapshot.observedAt)
	const age = now.getTime() - observedAt
	return Number.isFinite(observedAt) && age >= -5_000 && age <= maximumAgeMilliseconds
}

function eligibleHealth(account: Account): boolean {
	switch (account.health) {
		case 'ready':
		case 'loginExpiring':
			return account.enabled
		default:
			return false
	}
}

export function selectRotation(input: RotationInput): RotationDecision {
	const { policy } = input.state
	if (!policy.enabled) {
		return { reason: 'disabled', rotate: false }
	}
	if (policy.authorization !== 'confirmed') {
		return { reason: 'authorizationRequired', rotate: false }
	}
	if (input.state.activeAccountId === null) {
		return { reason: 'noActiveAccount', rotate: false }
	}

	const snapshotByAccount = new Map(
		input.usage.map(snapshot => {
			const parsed = UsageSnapshotSchema.parse(snapshot)
			return [parsed.accountId, parsed] as const
		})
	)
	const activeSnapshot = snapshotByAccount.get(input.state.activeAccountId)
	if (activeSnapshot === undefined) {
		return { reason: 'activeUsageUnknown', rotate: false }
	}
	if (!isFresh(activeSnapshot, input.now, policy.maximumSnapshotAgeMilliseconds)) {
		return { reason: 'activeUsageStale', rotate: false }
	}
	const activePressure = hardPressure(activeSnapshot)
	if (activePressure === null) {
		return { reason: 'activeUsageUnknown', rotate: false }
	}
	if (!activeSnapshot.hardLimitReached && activePressure < policy.thresholdPercent) {
		return { reason: 'belowThreshold', rotate: false }
	}
	// Dwell prevents threshold-driven flapping. A hard-limited account is
	// unusable right now — every request on it fails — so dwell must not pin
	// traffic to it.
	if (!activeSnapshot.hardLimitReached && input.state.switchedAt !== null) {
		const dwell = input.now.getTime() - Date.parse(input.state.switchedAt)
		if (dwell < policy.minimumDwellMilliseconds) {
			return { reason: 'minimumDwell', rotate: false }
		}
	}

	const targetCeiling = policy.thresholdPercent - policy.hysteresisPercent
	const candidates = input.accounts
		.filter(
			account =>
				account.provider === input.state.provider &&
				account.id !== input.state.activeAccountId &&
				eligibleHealth(account)
		)
		.flatMap(account => {
			const snapshot = snapshotByAccount.get(account.id)
			if (
				snapshot === undefined ||
				snapshot.provider !== account.provider ||
				snapshot.hardLimitReached ||
				!isFresh(snapshot, input.now, policy.maximumSnapshotAgeMilliseconds)
			) {
				return []
			}
			const pressure = hardPressure(snapshot)
			if (pressure === null || pressure > targetCeiling) {
				return []
			}
			return [{ account, pressure }]
		})
		.sort(
			(left, right) =>
				left.pressure - right.pressure || left.account.id.localeCompare(right.account.id)
		)

	const target = candidates[0]
	if (target === undefined) {
		return { reason: 'noEligibleCandidate', rotate: false }
	}

	return {
		reason: activeSnapshot.hardLimitReached ? 'hardLimit' : 'threshold',
		rotate: true,
		sourceAccountId: input.state.activeAccountId,
		sourcePressure: activePressure,
		targetAccountId: target.account.id,
		targetPressure: target.pressure
	}
}
