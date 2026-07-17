import { z } from 'zod'

export const ProviderIdSchema = z.enum(['openai', 'anthropic'])
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const AccountEmailSchema = z.string().trim().toLowerCase().email()

export const HealthStateSchema = z.enum([
	'unchecked',
	'ready',
	'refreshDue',
	'refreshing',
	'loginExpiring',
	'scopeMissing',
	'reauthenticationRequired',
	'temporarilyUnreachable',
	'usageRateLimited',
	'disabled'
])
export type HealthState = z.infer<typeof HealthStateSchema>

const AccountFieldsSchema = z.object({
	createdAt: z.iso.datetime(),
	enabled: z.boolean(),
	externalAccountId: z.string().trim().min(1).nullable(),
	health: HealthStateSchema,
	id: z.uuid(),
	identity: AccountEmailSchema,
	label: AccountEmailSchema,
	plan: z.string().trim().min(1).nullish(),
	updatedAt: z.iso.datetime()
})

export const AccountSchema = z
	.discriminatedUnion('provider', [
		AccountFieldsSchema.extend({
			externalUserId: z.string().trim().min(1).nullable().default(null),
			profilePath: z.null(),
			provider: z.literal('openai'),
			secretReference: z.string().trim().min(1)
		}).strict(),
		AccountFieldsSchema.extend({
			externalUserId: z.null().default(null),
			profilePath: z.string().trim().min(1),
			provider: z.literal('anthropic'),
			secretReference: z.null()
		}).strict()
	])
	.refine(account => account.label === account.identity, {
		message: 'Account label must equal its authenticated email identity',
		path: ['label']
	})
export type Account = z.infer<typeof AccountSchema>

export const UsageWindowSchema = z
	.object({
		id: z.string().trim().min(1),
		kind: z.enum(['hard', 'soft', 'spend']),
		label: z.string().trim().min(1),
		resetAt: z.iso.datetime().nullable(),
		usedPercent: z.number().min(0).max(100)
	})
	.strict()
export type UsageWindow = z.infer<typeof UsageWindowSchema>

const UsageSnapshotFieldsSchema = z.object({
	accountId: z.uuid(),
	hardLimitReached: z.boolean(),
	observedAt: z.iso.datetime(),
	windows: z.array(UsageWindowSchema)
})

export const UsageSnapshotSchema = z.discriminatedUnion('provider', [
	UsageSnapshotFieldsSchema.extend({
		provider: z.literal('openai'),
		source: z.enum(['codexUsageEndpoint', 'proxyResponseHeaders'])
	}).strict(),
	UsageSnapshotFieldsSchema.extend({
		provider: z.literal('anthropic'),
		source: z.enum(['claudeUsageEndpoint', 'proxyResponseHeaders'])
	}).strict()
])
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>

export const AuthorizationStateSchema = z.enum(['notConfirmed', 'confirmed'])

export const AutomationPolicySchema = z
	.object({
		authorization: AuthorizationStateSchema.default('notConfirmed'),
		enabled: z.boolean(),
		// Rate-limit windows the operator has chosen to hide from the dashboard,
		// keyed by UsageWindow.id (display-only; never affects rotation). Defaulted
		// so every policy persisted before this field parses unchanged.
		hiddenWindowIds: z.array(z.string()).default([]),
		hysteresisPercent: z.number().min(0).max(25).default(5),
		maximumSnapshotAgeMilliseconds: z.number().int().positive().default(420_000),
		minimumDwellMilliseconds: z.number().int().min(0).default(300_000),
		provider: ProviderIdSchema,
		thresholdPercent: z.number().min(1).max(100).default(90)
	})
	.strict()
	.refine(policy => policy.hysteresisPercent < policy.thresholdPercent, {
		message: 'hysteresisPercent must be lower than thresholdPercent',
		path: ['hysteresisPercent']
	})
export type AutomationPolicy = z.infer<typeof AutomationPolicySchema>

export const ProviderStateSchema = z
	.object({
		activeAccountId: z.uuid().nullable(),
		generation: z.number().int().nonnegative(),
		policy: AutomationPolicySchema,
		provider: ProviderIdSchema,
		switchedAt: z.iso.datetime().nullable()
	})
	.strict()
	.refine(state => state.provider === state.policy.provider, {
		message: 'Provider state and automation policy must target the same provider',
		path: ['policy', 'provider']
	})
export type ProviderState = z.infer<typeof ProviderStateSchema>

export const SwitchPhaseSchema = z.enum([
	'prepared',
	'draining',
	'synchronizing',
	'activating',
	'verifying',
	'committed',
	'rolledBack',
	'failed'
])
export type SwitchPhase = z.infer<typeof SwitchPhaseSchema>

export const SwitchRecordSchema = z
	.object({
		createdAt: z.iso.datetime(),
		generation: z.number().int().positive(),
		id: z.uuid(),
		message: z.string().nullable(),
		phase: SwitchPhaseSchema,
		provider: ProviderIdSchema,
		reason: z.string().trim().min(1),
		sourceAccountId: z.uuid().nullable(),
		targetAccountId: z.uuid(),
		updatedAt: z.iso.datetime()
	})
	.strict()
export type SwitchRecord = z.infer<typeof SwitchRecordSchema>

export const DashboardSnapshotSchema = z
	.object({
		accounts: z.array(AccountSchema),
		providers: z.array(ProviderStateSchema),
		sampledAt: z.iso.datetime(),
		usage: z.array(UsageSnapshotSchema)
	})
	.strict()
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>

export interface Timeframe {
	key: string
	label: string
	ms: number
}
export const TIMEFRAMES: readonly Timeframe[] = [
	{ key: '1h', label: '1h', ms: 3_600_000 },
	{ key: '5h', label: '5h', ms: 5 * 3_600_000 },
	{ key: '24h', label: '24h', ms: 24 * 3_600_000 },
	{ key: '7d', label: '7d', ms: 7 * 24 * 3_600_000 },
	{ key: '31d', label: '31d', ms: 31 * 24 * 3_600_000 }
]

export const TokenEventSchema = z
	.object({
		accountId: z.uuid().nullable(),
		at: z.number().int().nonnegative(),
		cacheCreationTokens: z.number().int().nonnegative(),
		cacheReadTokens: z.number().int().nonnegative(),
		inputTokens: z.number().int().nonnegative(),
		model: z.string().min(1).nullable(),
		outputTokens: z.number().int().nonnegative(),
		provider: ProviderIdSchema
	})
	.strict()
export type TokenEvent = z.infer<typeof TokenEventSchema>

// A model or provider row in the metrics view: token counts split by class,
// with the dollar value already priced at each class's own rate.
export const TokenBreakdownSchema = z
	.object({
		cacheCreation: z.number().nonnegative(),
		cached: z.number().nonnegative(),
		costUsd: z.number().nonnegative(),
		input: z.number().nonnegative(),
		output: z.number().nonnegative(),
		tokens: z.number().nonnegative()
	})
	.strict()
export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>

export const TokenTimeframeSchema = z
	.object({
		bucketMs: z.number().positive(),
		buckets: z.array(z.number().nonnegative()),
		// Per-provider rollup, each priced per token class, for the metrics table.
		byProvider: z.array(TokenBreakdownSchema.extend({ provider: ProviderIdSchema }).strict()),
		// The grand total split by cost class, so the value is auditable per type.
		costCacheCreation: z.number().nonnegative(),
		costCached: z.number().nonnegative(),
		costInput: z.number().nonnegative(),
		costOutput: z.number().nonnegative(),
		costUsd: z.number().nonnegative(),
		key: z.string(),
		// Every model that saw traffic in the window, richest first — the metrics
		// view scrolls through them rather than truncating to a top-N.
		models: z.array(
			TokenBreakdownSchema.extend({ model: z.string(), provider: ProviderIdSchema }).strict()
		),
		peakPerHour: z.number().nonnegative(),
		totalCacheCreation: z.number().nonnegative(),
		totalCached: z.number().nonnegative(),
		totalInput: z.number().nonnegative(),
		totalOutput: z.number().nonnegative(),
		totalTokens: z.number().nonnegative()
	})
	.strict()
export type TokenTimeframe = z.infer<typeof TokenTimeframeSchema>

export const TokenAnalyticsSchema = z
	.object({
		// Trailing five-minute throughput in tokens/hour — timeframe-independent, so
		// the "now" figure never depends on a partially-filled chart bucket.
		nowPerHour: z.number().nonnegative(),
		timeframes: z.array(TokenTimeframeSchema)
	})
	.strict()
export type TokenAnalytics = z.infer<typeof TokenAnalyticsSchema>

export const AnalyticsSnapshotSchema = z
	.object({
		snapshot: DashboardSnapshotSchema,
		tokens: TokenAnalyticsSchema.nullish()
	})
	.strict()
export type AnalyticsSnapshot = z.infer<typeof AnalyticsSnapshotSchema>
