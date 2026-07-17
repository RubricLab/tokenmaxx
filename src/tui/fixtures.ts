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
		// A believable spread of models per provider, each split into token
		// classes and priced per class — the whole metrics view derives from this.
		const modelMix: { model: string; provider: ProviderId; share: number }[] = [
			{ model: 'gpt-5.6-sol', provider: 'openai', share: 0.42 },
			{ model: 'gpt-5.6-codex', provider: 'openai', share: 0.13 },
			{ model: 'claude-opus-4-8', provider: 'anthropic', share: 0.3 },
			{ model: 'claude-sonnet-4-6', provider: 'anthropic', share: 0.11 },
			{ model: 'claude-haiku-4-5', provider: 'anthropic', share: 0.04 }
		]
		const models = modelMix
			.map(entry => {
				const tokens = Math.round(totalTokens * entry.share)
				// Cache-read dominated, like real harness traffic: live captures price
				// out near $0.5/M blended (478M ≈ $254), which needs ~94% cache reads.
				const input = Math.round(tokens * 0.03)
				const output = Math.round(tokens * 0.012)
				const cacheCreation = Math.round(tokens * 0.02)
				const cached = tokens - input - output - cacheCreation
				return {
					cacheCreation,
					cached,
					costUsd: costUsd(entry.model, input, output, cached, cacheCreation),
					input,
					model: entry.model,
					output,
					provider: entry.provider,
					tokens
				}
			})
			.filter(entry => entry.tokens > 0)
		const sum = (pick: (m: (typeof models)[number]) => number) =>
			models.reduce((total, model) => total + pick(model), 0)
		const byProviderMap = new Map<ProviderId, (typeof models)[number][]>()
		for (const model of models) {
			byProviderMap.set(model.provider, [...(byProviderMap.get(model.provider) ?? []), model])
		}
		const byProvider = [...byProviderMap.entries()]
			.map(([provider, entries]) => ({
				cacheCreation: entries.reduce((t, m) => t + m.cacheCreation, 0),
				cached: entries.reduce((t, m) => t + m.cached, 0),
				costUsd: entries.reduce((t, m) => t + m.costUsd, 0),
				input: entries.reduce((t, m) => t + m.input, 0),
				output: entries.reduce((t, m) => t + m.output, 0),
				provider,
				tokens: entries.reduce((t, m) => t + m.tokens, 0)
			}))
			.sort((left, right) => right.costUsd - left.costUsd)
		const bucketMs = timeframe.ms / 120
		const peakBucket = buckets.reduce((max, value) => Math.max(max, value), 0)
		return {
			bucketMs,
			buckets,
			byProvider,
			costCacheCreation: models.reduce((t, m) => t + costUsd(m.model, 0, 0, 0, m.cacheCreation), 0),
			costCached: models.reduce((t, m) => t + costUsd(m.model, 0, 0, m.cached, 0), 0),
			costInput: models.reduce((t, m) => t + costUsd(m.model, m.input, 0, 0, 0), 0),
			costOutput: models.reduce((t, m) => t + costUsd(m.model, 0, m.output, 0, 0), 0),
			costUsd: sum(m => m.costUsd),
			key: timeframe.key,
			models: models.sort((left, right) => right.costUsd - left.costUsd),
			peakPerHour: Math.round(peakBucket * (3_600_000 / bucketMs)),
			totalCacheCreation: sum(m => m.cacheCreation),
			totalCached: sum(m => m.cached),
			totalInput: sum(m => m.input),
			totalOutput: sum(m => m.output),
			totalTokens: sum(m => m.tokens)
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
		externalAccountId:
			['b31c07d2', '9f4ae815', 'c8d2f6a1', '4e7b93c5', 'a25d18f4', '7c91e0b6', 'd48f2a91', '61e7c3b0'][
				seed.n - 1
			] ?? 'e0d94c72',
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
		observedAt: new Date(
			now - 8_000 - Math.round(Math.abs(noise(Math.floor(now / (5 * MINUTE)))) * 16_000)
		).toISOString(),
		windows
	} as const
	return seed.provider === 'openai'
		? { ...base, provider: 'openai', source: 'codexUsageEndpoint' }
		: { ...base, provider: 'anthropic', source: 'claudeUsageEndpoint' }
}

function policy(
	provider: ProviderId,
	enabled: boolean,
	thresholdPercent = 90,
	minimumDwellMilliseconds = 300_000,
	hiddenWindowIds: string[] = []
): AutomationPolicy {
	return {
		authorization: enabled ? 'confirmed' : 'notConfirmed',
		enabled,
		hiddenWindowIds,
		hysteresisPercent: 5,
		maximumSnapshotAgeMilliseconds: 420_000,
		minimumDwellMilliseconds,
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
	dwellMs?: number
}

function providerState(seed: ProviderSeed, now: number): ProviderState {
	return {
		activeAccountId: seed.activeN === null ? null : uuid(seed.activeN),
		generation: seed.generation,
		policy: policy(seed.provider, seed.auto, seed.threshold, seed.dwellMs),
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

// A full day compressed: every account's 5h window saws (fill to the
// threshold, rotate away, refresh) while the 7d windows climb monotonically
// until, one by one, whole accounts burn out for the week. A pure function of
// the clock: accounts take ~95-minute shifts round-robin among those whose
// week is still alive; a shift ramps the 5h window toward the threshold, the
// window holds hot for the rest of its five hours, then resets.
const blitz: ScenarioBuilder = now => {
	const t0 = Date.parse('2026-07-15T11:00:00.000Z') // 7:00 AM in New York
	const minutes = Math.max(0, (now - t0) / MINUTE)
	const shiftLength = 95
	interface Runner {
		n: number
		provider: ProviderId
		email: string
		// Weekly budget already used when the day starts, and how many minutes of
		// ACTIVE burning it takes to go from there to the 90% threshold. Meters are
		// functions of active time, never of wall-clock time.
		sevenStart: number
		burnMinutes: number
	}
	const runners: Runner[] = [
		{ burnMinutes: 380, email: 'dexter@rubriclabs.com', n: 1, provider: 'openai', sevenStart: 34 },
		{ burnMinutes: 380, email: 'ship@rubriclabs.com', n: 2, provider: 'openai', sevenStart: 22 },
		{ burnMinutes: 600, email: 'ops@rubriclabs.com', n: 6, provider: 'openai', sevenStart: 11 },
		{ burnMinutes: 700, email: 'dexter@rubriclabs.com', n: 3, provider: 'anthropic', sevenStart: 44 },
		{
			burnMinutes: 750,
			email: 'research@rubriclabs.com',
			n: 4,
			provider: 'anthropic',
			sevenStart: 34
		},
		{ burnMinutes: 700, email: 'zero@rubriclabs.com', n: 5, provider: 'anthropic', sevenStart: 25 },
		{
			burnMinutes: 850,
			email: 'design@rubriclabs.com',
			n: 7,
			provider: 'anthropic',
			sevenStart: 15
		},
		{
			burnMinutes: 900,
			email: 'agents@rubriclabs.com',
			n: 8,
			provider: 'anthropic',
			sevenStart: 6
		}
	]
	const burnRate = (runner: Runner) => (90 - runner.sevenStart) / runner.burnMinutes
	// ——— Codex: a strict threshold relay. One account holds the baton and burns
	// its 7-day budget; the baton passes at exactly 90%, and idle meters never
	// move. Boundaries fall mid-way between Claude's handoffs so the two
	// providers never flash "switched" together.
	const codexRunners = runners.filter(runner => runner.provider === 'openai')
	const codexBoundaries: number[] = []
	{
		let at = 0
		for (const runner of codexRunners.slice(0, -1)) {
			at += runner.burnMinutes
			codexBoundaries.push(at)
		}
	}
	const codexLeg = (m: number) =>
		Math.min(codexBoundaries.filter(boundary => boundary <= m).length, codexRunners.length - 1)
	const codexWeekly = (runner: Runner, m: number): number => {
		const index = codexRunners.indexOf(runner)
		const legStart = index === 0 ? 0 : (codexBoundaries[index - 1] ?? Number.POSITIVE_INFINITY)
		if (m <= legStart) {
			return clamp(runner.sevenStart)
		}
		const activeMinutes = Math.min(m - legStart, runner.burnMinutes)
		return clamp(runner.sevenStart + burnRate(runner) * activeMinutes)
	}
	// ——— Claude: five accounts rotate the 5h session round-robin on a shift
	// clock offset half a shift from nothing-in-particular — what matters is its
	// handoffs sit far from the Codex boundaries. The active session ramps to
	// ~92% by the end of its shift, so a switch always shows a maxed meter. The
	// Fable weekly climbs only while its account holds the baton.
	const claudeRunners = runners.filter(runner => runner.provider === 'anthropic')
	const claudePhase = Math.round(shiftLength / 2)
	const claudeShiftIndex = (m: number) => Math.floor((m - claudePhase) / shiftLength)
	const claudeShiftStart = (k: number) => k * shiftLength + claudePhase
	const claudeActive = (k: number): Runner | undefined =>
		claudeRunners[((k % claudeRunners.length) + claudeRunners.length) % claudeRunners.length]
	const lastShiftStart = (runner: Runner): number | null => {
		const kNow = claudeShiftIndex(minutes)
		for (let k = kNow; k >= kNow - claudeRunners.length; k -= 1) {
			if (claudeActive(k)?.n === runner.n) {
				return claudeShiftStart(k)
			}
		}
		return null
	}
	const five = (runner: Runner): number => {
		const shiftStart = lastShiftStart(runner)
		if (shiftStart === null) {
			return clamp(4 + Math.abs(noise(runner.n * 7)) * 5)
		}
		const sinceStart = minutes - shiftStart
		if (sinceStart <= shiftLength) {
			return clamp(7 + (85 * sinceStart) / shiftLength)
		}
		// The window stays hot for the rest of its five hours, then refreshes.
		return sinceStart < 300 ? 92 : clamp(2 + Math.abs(noise(runner.n * 13)) * 4)
	}
	const claudeActiveMinutes = (runner: Runner, m: number): number => {
		let total = 0
		for (let k = -1, kNow = claudeShiftIndex(m); k <= kNow; k += 1) {
			if (claudeActive(k)?.n !== runner.n) {
				continue
			}
			const start = Math.max(0, claudeShiftStart(k))
			const end = Math.min(m, claudeShiftStart(k) + shiftLength)
			total += Math.max(0, end - start)
		}
		return total
	}
	const fableWeekly = (runner: Runner, m: number): number =>
		clamp(runner.sevenStart + burnRate(runner) * claudeActiveMinutes(runner, m))
	const seeds: AccountSeed[] = runners.map(runner => ({
		email: runner.email,
		n: runner.n,
		plan: runner.provider === 'openai' ? 'pro' : 'claude_max_20x',
		provider: runner.provider,
		// Codex shows just its weekly window; Claude shows the 5-hour session
		// cycling plus the Fable scoped weekly — a calm, legible story where a
		// meter only moves while its account is doing the work.
		windows:
			runner.provider === 'openai'
				? [
						{
							fillFrac: 0.5,
							id: 'weekly',
							label: '7 day · all models',
							nowFrac: 0.5,
							peak: codexWeekly(runner, minutes),
							period: 7 * DAY,
							seed: runner.n + 20,
							wobble: 0
						}
					]
				: [
						{
							fillFrac: 0.5,
							id: 'session',
							label: '5h session',
							nowFrac: 0.5,
							peak: five(runner),
							period: 5 * HOUR,
							seed: runner.n,
							wobble: 0
						},
						{
							fillFrac: 0.5,
							id: 'weekly_scoped:fable',
							label: '7 day · Fable',
							nowFrac: 0.5,
							peak: fableWeekly(runner, minutes),
							period: 7 * DAY,
							seed: runner.n + 40,
							wobble: 0
						}
					]
	}))
	const providerSeed = (provider: ProviderId): ProviderSeed => {
		if (provider === 'openai') {
			const leg = codexLeg(minutes)
			const lastBoundary = codexBoundaries[leg - 1]
			return {
				activeN: codexRunners[leg]?.n ?? null,
				auto: true,
				dwellMs: 300_000,
				generation: leg + 2,
				provider,
				// Before the first threshold crossing nothing has switched today.
				switchedMinutesAgo: lastBoundary === undefined ? null : Math.max(0.2, minutes - lastBoundary),
				threshold: 90
			}
		}
		const k = claudeShiftIndex(minutes)
		return {
			activeN: claudeActive(k)?.n ?? null,
			auto: true,
			dwellMs: 300_000,
			generation: k + 2,
			provider,
			switchedMinutesAgo: Math.max(0.2, minutes - claudeShiftStart(k)),
			threshold: 90
		}
	}
	// Scale the throughput to what a real 8-account fleet burns: live captures
	// show ~478M tokens over a 5h window, so target that magnitude (not a toy
	// number that undersells the value story).
	return assemble(now, seeds, [providerSeed('openai'), providerSeed('anthropic')], 1250)
}

// The cruising accounts with visibly different per-provider policies, for the
// settings shot: its claim is that tuning is per provider.
const tuned: ScenarioBuilder = now => {
	const snapshot = cruising(now)
	const codex = snapshot.snapshot.providers.find(state => state.provider === 'openai')
	if (codex !== undefined) {
		codex.policy = policy('openai', true, 85, 480_000)
	}
	return snapshot
}

const scenarios: Record<string, ScenarioBuilder> = {
	blitz,
	cruising,
	onboarding,
	oneHot,
	relay,
	rotated,
	tuned
}

export const SCENARIO_NAMES = Object.keys(scenarios)

export function buildScenario(name: string, now: number = FIXTURE_NOW): AnalyticsSnapshot {
	const builder = scenarios[name]
	if (builder === undefined) {
		throw new Error(`Unknown fixture scenario: ${name} (have ${SCENARIO_NAMES.join(', ')})`)
	}
	return builder(now)
}
