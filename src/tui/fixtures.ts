import {
	type Account,
	type AnalyticsSnapshot,
	AnalyticsSnapshotSchema,
	type AutomationPolicy,
	type ProviderId,
	type ProviderState,
	TIMEFRAMES,
	type TokenAnalytics,
	type UsageSnapshot,
	type UsageWindow
} from '../domain.ts'
import { costUsd } from '../pricing.ts'
import { clamp } from './format.ts'

function buildTokens(scale: number): TokenAnalytics {
	const timeframes = TIMEFRAMES.map((timeframe, seed) => {
		const hours = timeframe.ms / HOUR
		const raw = Array.from({ length: 120 }, (_, i) =>
			Math.max(
				0,
				Math.sin(i * 0.35 + seed) * 0.5 +
					Math.sin(i * 0.13 + seed * 2) * 0.5 +
					noise(i + seed * 50) * 0.4 -
					0.12
			)
		)
		const rawSum = raw.reduce((sum, value) => sum + value, 0) || 1
		const target = Math.round(150_000 * hours * 0.5 * scale)
		const buckets = raw.map(value => Math.round((value / rawSum) * target))
		const totalTokens = buckets.reduce((sum, value) => sum + value, 0)
		const totalCached = Math.round(totalTokens * 0.58)
		const totalCacheCreation = Math.round(totalTokens * 0.04)
		const totalInput = Math.round(totalTokens * 0.26)
		const codexTokens = Math.round(totalTokens * 0.55)
		const claudeTokens = totalTokens - codexTokens
		const split = (tokens: number, model: string) =>
			costUsd(
				model,
				Math.round(tokens * 0.24),
				Math.round(tokens * 0.12),
				Math.round(tokens * 0.6),
				Math.round(tokens * 0.04)
			)
		const codexCost = split(codexTokens, 'gpt-5.6-sol')
		const claudeCost = split(claudeTokens, 'claude-opus-4-8')
		const bucketMs = timeframe.ms / 120
		const peakBucket = buckets.reduce((max, value) => Math.max(max, value), 0)
		return {
			bucketMs,
			buckets,
			byProvider: {
				anthropic: { costUsd: claudeCost, tokens: claudeTokens },
				openai: { costUsd: codexCost, tokens: codexTokens }
			},
			costUsd: codexCost + claudeCost,
			key: timeframe.key,
			peakPerHour: Math.round(peakBucket * (3_600_000 / bucketMs)),
			topModels:
				totalTokens === 0
					? []
					: [
							{ costUsd: codexCost, model: 'gpt-5.6-sol', tokens: codexTokens },
							{ costUsd: claudeCost, model: 'claude-opus-4-8', tokens: claudeTokens }
						].sort((left, right) => right.tokens - left.tokens),
			totalCacheCreation,
			totalCached,
			totalInput,
			totalOutput: totalTokens - totalInput - totalCached - totalCacheCreation,
			totalTokens
		}
	})
	const hourly = timeframes[0]
	return {
		nowPerHour:
			hourly === undefined
				? 0
				: Math.round(Math.max(...hourly.buckets.slice(-6), 0) * (HOUR / hourly.bucketMs) * 0.85),
		timeframes
	}
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

export const FIXTURE_NOW = Date.parse('2026-07-15T16:42:00.000Z')

function uuid(n: number): string {
	return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
}

function noise(index: number): number {
	const x = Math.sin(index * 12.9898) * 43_758.5453
	return (x - Math.floor(x)) * 2 - 1
}

interface WindowSpec {
	id: string
	label: string
	period: number
	peak: number
	nowFrac: number
	fillFrac: number
	wobble: number
	seed: number
}

function valueAt(spec: WindowSpec, at: number, now: number): number {
	const origin = now - spec.nowFrac * spec.period
	const cycles = (at - origin) / spec.period
	const frac = cycles - Math.floor(cycles)
	const ramp = Math.min(1, frac / spec.fillFrac)
	return clamp(spec.peak * ramp + spec.wobble * noise(Math.floor(at / (10 * MINUTE)) + spec.seed))
}

function toWindow(spec: WindowSpec, now: number): UsageWindow {
	return {
		id: spec.id,
		kind: 'hard',
		label: spec.label,
		resetAt: new Date(now + (1 - spec.nowFrac) * spec.period).toISOString(),
		usedPercent: Math.round(valueAt(spec, now, now))
	}
}

interface AccountSeed {
	n: number
	provider: ProviderId
	email: string
	plan: string | null
	health?: Account['health']
	windows?: WindowSpec[]
}

function account(seed: AccountSeed, now: number): Account {
	const base = {
		createdAt: new Date(now - 34 * DAY).toISOString(),
		enabled: true,
		externalAccountId: `acct_${seed.n.toString().padStart(4, '0')}`,
		health: seed.health ?? 'ready',
		id: uuid(seed.n),
		identity: seed.email,
		label: seed.email,
		plan: seed.plan,
		updatedAt: new Date(now - 2 * MINUTE).toISOString()
	} as const
	return seed.provider === 'openai'
		? {
				...base,
				externalUserId: `user_${seed.n}`,
				profilePath: null,
				provider: 'openai',
				secretReference: `codex:${base.externalAccountId}`
			}
		: {
				...base,
				externalUserId: null,
				profilePath: `/tmp/tokenmaxx/claude/${seed.n}`,
				provider: 'anthropic',
				secretReference: null
			}
}

function usage(seed: AccountSeed, now: number): UsageSnapshot {
	const windows = (seed.windows ?? []).map(spec => toWindow(spec, now))
	// Usage is read off response headers as traffic flows, so a live system is
	// always seconds fresh.
	const base = {
		accountId: uuid(seed.n),
		hardLimitReached: windows.some(window => window.usedPercent >= 100),
		observedAt: new Date(now - 12_000).toISOString(),
		windows
	} as const
	return seed.provider === 'openai'
		? { ...base, provider: 'openai', source: 'codexUsageEndpoint' }
		: { ...base, provider: 'anthropic', source: 'claudeUsageEndpoint' }
}

function policy(provider: ProviderId, enabled: boolean, thresholdPercent = 90): AutomationPolicy {
	return {
		authorization: enabled ? 'confirmed' : 'notConfirmed',
		enabled,
		hysteresisPercent: 5,
		maximumSnapshotAgeMilliseconds: 420_000,
		minimumDwellMilliseconds: 300_000,
		provider,
		thresholdPercent
	}
}

interface ProviderSeed {
	provider: ProviderId
	activeN: number | null
	generation: number
	switchedMinutesAgo: number | null
	auto: boolean
	threshold?: number
}

function providerState(seed: ProviderSeed, now: number): ProviderState {
	return {
		activeAccountId: seed.activeN === null ? null : uuid(seed.activeN),
		generation: seed.generation,
		policy: policy(seed.provider, seed.auto, seed.threshold),
		provider: seed.provider,
		switchedAt:
			seed.switchedMinutesAgo === null
				? null
				: new Date(now - seed.switchedMinutesAgo * MINUTE).toISOString()
	}
}

function assemble(
	now: number,
	accounts: AccountSeed[],
	providers: ProviderSeed[],
	tokenScale = 1
): AnalyticsSnapshot {
	return AnalyticsSnapshotSchema.parse({
		snapshot: {
			accounts: accounts.map(seed => account(seed, now)),
			providers: providers.map(seed => providerState(seed, now)),
			sampledAt: new Date(now - 12_000).toISOString(),
			usage: accounts.map(seed => usage(seed, now))
		},
		tokens: buildTokens(tokenScale)
	})
}

const fiveHour = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
	fillFrac: 0.92,
	id: 'five-hour',
	label: '5 hour',
	nowFrac,
	peak,
	period: 5 * HOUR,
	seed,
	wobble: 4
})
const weekly = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
	fillFrac: 1,
	id: 'weekly',
	label: '7 day · all models',
	nowFrac,
	peak,
	period: 7 * DAY,
	seed,
	wobble: 2
})
const fable = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
	fillFrac: 1,
	id: 'weekly_scoped:fable',
	label: '7 day · Fable',
	nowFrac,
	peak,
	period: 7 * DAY,
	seed,
	wobble: 3
})
const claudeSession = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
	...fiveHour(peak, nowFrac, seed),
	label: '5h session'
})

type ScenarioBuilder = (now: number) => AnalyticsSnapshot

const cruising: ScenarioBuilder = now =>
	assemble(
		now,
		[
			{
				email: 'dexter@rubriclabs.com',
				n: 1,
				plan: 'pro',
				provider: 'openai',
				windows: [fiveHour(58, 0.62, 11), weekly(44, 0.63, 21)]
			},
			{
				email: 'ship@rubriclabs.com',
				n: 2,
				plan: 'pro',
				provider: 'openai',
				windows: [fiveHour(21, 0.3, 12), weekly(33, 0.61, 22)]
			},
			{
				email: 'dexter@rubriclabs.com',
				n: 3,
				plan: 'claude_max_20x',
				provider: 'anthropic',
				windows: [claudeSession(47, 0.55, 31), weekly(29, 0.5, 41), fable(38, 0.44, 51)]
			},
			{
				email: 'research@rubriclabs.com',
				n: 4,
				plan: 'claude_max_5x',
				provider: 'anthropic',
				windows: [claudeSession(18, 0.24, 32), weekly(22, 0.4, 42), fable(12, 0.2, 52)]
			}
		],
		[
			{ activeN: 1, auto: true, generation: 4, provider: 'openai', switchedMinutesAgo: 96 },
			{ activeN: 3, auto: true, generation: 2, provider: 'anthropic', switchedMinutesAgo: 210 }
		]
	)

const oneHot: ScenarioBuilder = now =>
	assemble(
		now,
		[
			{
				email: 'dexter@rubriclabs.com',
				n: 1,
				plan: 'pro',
				provider: 'openai',
				windows: [fiveHour(99, 0.87, 11), weekly(72, 0.7, 21)]
			},
			{
				email: 'ship@rubriclabs.com',
				n: 2,
				plan: 'pro',
				provider: 'openai',
				windows: [fiveHour(23, 0.28, 12), weekly(41, 0.6, 22)]
			},
			{
				email: 'dexter@rubriclabs.com',
				n: 3,
				plan: 'claude_max_20x',
				provider: 'anthropic',
				windows: [claudeSession(63, 0.6, 31), weekly(48, 0.62, 41), fable(97, 0.9, 51)]
			},
			{
				email: 'research@rubriclabs.com',
				n: 4,
				plan: 'claude_max_5x',
				provider: 'anthropic',
				windows: [claudeSession(31, 0.35, 32), weekly(27, 0.45, 42), fable(19, 0.3, 52)]
			}
		],
		[
			{ activeN: 1, auto: true, generation: 7, provider: 'openai', switchedMinutesAgo: 288 },
			{ activeN: 3, auto: true, generation: 3, provider: 'anthropic', switchedMinutesAgo: 420 }
		]
	)

const rotated: ScenarioBuilder = now =>
	assemble(
		now,
		[
			{
				email: 'ship@rubriclabs.com',
				n: 2,
				plan: 'pro',
				provider: 'openai',
				windows: [fiveHour(19, 0.22, 12), weekly(38, 0.58, 22)]
			},
			{
				email: 'dexter@rubriclabs.com',
				n: 1,
				plan: 'pro',
				provider: 'openai',
				windows: [fiveHour(96, 0.95, 11), weekly(74, 0.72, 21)]
			},
			{
				email: 'dexter@rubriclabs.com',
				n: 3,
				plan: 'claude_max_20x',
				provider: 'anthropic',
				windows: [claudeSession(44, 0.5, 31), weekly(46, 0.6, 41), fable(52, 0.55, 51)]
			},
			{
				email: 'research@rubriclabs.com',
				n: 4,
				plan: 'claude_max_5x',
				provider: 'anthropic',
				windows: [claudeSession(16, 0.2, 32), weekly(24, 0.42, 42), fable(14, 0.24, 52)]
			}
		],
		[
			{ activeN: 2, auto: true, generation: 8, provider: 'openai', switchedMinutesAgo: 2 },
			{ activeN: 3, auto: true, generation: 3, provider: 'anthropic', switchedMinutesAgo: 420 }
		]
	)

const onboarding: ScenarioBuilder = now =>
	assemble(
		now,
		[],
		[
			{ activeN: null, auto: false, generation: 0, provider: 'openai', switchedMinutesAgo: null },
			{
				activeN: null,
				auto: false,
				generation: 0,
				provider: 'anthropic',
				switchedMinutesAgo: null
			}
		],
		0
	)

// The demo screenplay: a relay race across accounts, written as a pure
// function of the clock. Each account's 5h window climbs a linear ramp; the
// active account is whichever hasn't crossed the 90% threshold yet, so playing
// this scenario with an accelerated clock (TOKENMAXX_TIMEWARP) shows meters
// filling and the active dot hopping — the product's whole story in one take.
const relay: ScenarioBuilder = now => {
	const t0 = Date.parse('2026-07-15T13:30:00.000Z')
	const elapsedMinutes = Math.max(0, (now - t0) / MINUTE)
	const ramp = (start: number, perMinute: number) =>
		clamp(start + perMinute * elapsedMinutes + noise(Math.floor(now / (5 * MINUTE))) * 1.5)
	const crossing = (start: number, perMinute: number) => (90 - start) / perMinute

	// Claude: A starts hot and crosses 90% quickly; B carries the middle; C is fresh.
	const claudeRamps = [
		{ n: 3, rate: 0.75, start: 62 },
		{ n: 4, rate: 0.55, start: 24 },
		{ n: 5, rate: 0.3, start: 6 }
	]
	const codexRamps = [
		{ n: 1, rate: 0.62, start: 55 },
		{ n: 2, rate: 0.42, start: 14 },
		{ n: 6, rate: 0.24, start: 5 }
	]
	const activeIndex = (ramps: { start: number; rate: number }[]) => {
		for (let index = 0; index < ramps.length; index += 1) {
			const spec = ramps[index]
			if (spec !== undefined && ramp(spec.start, spec.rate) < 90) {
				return index
			}
		}
		return ramps.length - 1
	}
	const claudeActive = activeIndex(claudeRamps)
	const codexActive = activeIndex(codexRamps)
	const switchedMinutesAgo = (ramps: { start: number; rate: number }[], active: number) => {
		if (active === 0) {
			return 480
		}
		const previous = ramps[active - 1]
		return previous === undefined
			? 480
			: Math.max(0.2, elapsedMinutes - crossing(previous.start, previous.rate))
	}
	// fillFrac === nowFrac makes valueAt(now) return the peak exactly, so the
	// meter reads the ramp value with no cyclical scaling.
	const sessionWindow = (spec: { start: number; rate: number }, id: string, label: string) => ({
		fillFrac: 0.5,
		id,
		label,
		nowFrac: 0.5,
		peak: ramp(spec.start, spec.rate),
		period: 5 * HOUR,
		seed: spec.start,
		wobble: 0
	})
	const emails = {
		1: 'dexter@rubriclabs.com',
		2: 'ship@rubriclabs.com',
		3: 'dexter@rubriclabs.com',
		4: 'research@rubriclabs.com',
		5: 'zero@rubriclabs.com',
		6: 'ops@rubriclabs.com'
	} as const
	return assemble(
		now,
		[
			...codexRamps.map((spec, index) => ({
				email: emails[spec.n as keyof typeof emails],
				n: spec.n,
				plan: 'pro',
				provider: 'openai' as const,
				windows: [
					sessionWindow(spec, 'five-hour', '5 hour'),
					weekly(30 + index * 9 + elapsedMinutes * 0.04, 0.6, 20 + spec.n)
				]
			})),
			...claudeRamps.map((spec, index) => ({
				email: emails[spec.n as keyof typeof emails],
				n: spec.n,
				plan: 'claude_max_20x',
				provider: 'anthropic' as const,
				windows: [
					sessionWindow(spec, 'session', '5h session'),
					weekly(26 + index * 7 + elapsedMinutes * 0.05, 0.55, 40 + spec.n)
				]
			}))
		],
		[
			{
				activeN: codexRamps[codexActive]?.n ?? 1,
				auto: true,
				generation: 5 + codexActive,
				provider: 'openai',
				switchedMinutesAgo: switchedMinutesAgo(codexRamps, codexActive),
				threshold: 90
			},
			{
				activeN: claudeRamps[claudeActive]?.n ?? 3,
				auto: true,
				generation: 2 + claudeActive,
				provider: 'anthropic',
				switchedMinutesAgo: switchedMinutesAgo(claudeRamps, claudeActive),
				threshold: 90
			}
		]
	)
}

const scenarios: Record<string, ScenarioBuilder> = { cruising, onboarding, oneHot, relay, rotated }

export const SCENARIO_NAMES = Object.keys(scenarios)

export function buildScenario(name: string, now: number = FIXTURE_NOW): AnalyticsSnapshot {
	const builder = scenarios[name]
	if (builder === undefined) {
		throw new Error(`Unknown fixture scenario: ${name} (have ${SCENARIO_NAMES.join(', ')})`)
	}
	return builder(now)
}
