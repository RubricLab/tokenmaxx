import { z } from "zod";

export const ProviderIdSchema = z.enum(["openai", "anthropic"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const AccountEmailSchema = z.string().trim().toLowerCase().email();

export const HealthStateSchema = z.enum([
  "unchecked",
  "ready",
  "refreshDue",
  "refreshing",
  "loginExpiring",
  "scopeMissing",
  "reauthenticationRequired",
  "temporarilyUnreachable",
  "usageRateLimited",
  "disabled",
]);
export type HealthState = z.infer<typeof HealthStateSchema>;

const AccountFieldsSchema = z.object({
  id: z.uuid(),
  label: AccountEmailSchema,
  identity: AccountEmailSchema,
  externalAccountId: z.string().trim().min(1).nullable(),
  plan: z.string().trim().min(1).nullish(),
  health: HealthStateSchema,
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const AccountSchema = z
  .discriminatedUnion("provider", [
    AccountFieldsSchema.extend({
      provider: z.literal("openai"),
      externalUserId: z.string().trim().min(1).nullable().default(null),
      secretReference: z.string().trim().min(1),
      profilePath: z.null(),
    }).strict(),
    AccountFieldsSchema.extend({
      provider: z.literal("anthropic"),
      externalUserId: z.null().default(null),
      secretReference: z.null(),
      profilePath: z.string().trim().min(1),
    }).strict(),
  ])
  .refine((account) => account.label === account.identity, {
    message: "Account label must equal its authenticated email identity",
    path: ["label"],
  });
export type Account = z.infer<typeof AccountSchema>;

export const UsageWindowSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    usedPercent: z.number().min(0).max(100),
    resetAt: z.iso.datetime().nullable(),
    kind: z.enum(["hard", "soft", "spend"]),
  })
  .strict();
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

const UsageSnapshotFieldsSchema = z.object({
  accountId: z.uuid(),
  observedAt: z.iso.datetime(),
  windows: z.array(UsageWindowSchema),
  hardLimitReached: z.boolean(),
});

export const UsageSnapshotSchema = z.discriminatedUnion("provider", [
  UsageSnapshotFieldsSchema.extend({
    provider: z.literal("openai"),
    source: z.literal("codexUsageEndpoint"),
  }).strict(),
  UsageSnapshotFieldsSchema.extend({
    provider: z.literal("anthropic"),
    source: z.literal("claudeUsageEndpoint"),
  }).strict(),
]);
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const AuthorizationStateSchema = z.enum(["notConfirmed", "confirmed"]);

export const AutomationPolicySchema = z
  .object({
    provider: ProviderIdSchema,
    enabled: z.boolean(),
    thresholdPercent: z.number().min(1).max(100).default(95),
    hysteresisPercent: z.number().min(0).max(25).default(5),
    minimumDwellMilliseconds: z.number().int().min(0).default(300_000),
    maximumSnapshotAgeMilliseconds: z.number().int().positive().default(120_000),
    authorization: AuthorizationStateSchema.default("notConfirmed"),
  })
  .strict()
  .refine((policy) => policy.hysteresisPercent < policy.thresholdPercent, {
    message: "hysteresisPercent must be lower than thresholdPercent",
    path: ["hysteresisPercent"],
  });
export type AutomationPolicy = z.infer<typeof AutomationPolicySchema>;

export const ProviderStateSchema = z
  .object({
    provider: ProviderIdSchema,
    activeAccountId: z.uuid().nullable(),
    generation: z.number().int().nonnegative(),
    switchedAt: z.iso.datetime().nullable(),
    policy: AutomationPolicySchema,
  })
  .strict()
  .refine((state) => state.provider === state.policy.provider, {
    message: "Provider state and automation policy must target the same provider",
    path: ["policy", "provider"],
  });
export type ProviderState = z.infer<typeof ProviderStateSchema>;

export const SwitchPhaseSchema = z.enum([
  "prepared",
  "draining",
  "synchronizing",
  "activating",
  "verifying",
  "committed",
  "rolledBack",
  "failed",
]);
export type SwitchPhase = z.infer<typeof SwitchPhaseSchema>;

export const SwitchRecordSchema = z
  .object({
    id: z.uuid(),
    provider: ProviderIdSchema,
    sourceAccountId: z.uuid().nullable(),
    targetAccountId: z.uuid(),
    phase: SwitchPhaseSchema,
    reason: z.string().trim().min(1),
    generation: z.number().int().positive(),
    message: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type SwitchRecord = z.infer<typeof SwitchRecordSchema>;

export const DashboardSnapshotSchema = z
  .object({
    accounts: z.array(AccountSchema),
    usage: z.array(UsageSnapshotSchema),
    providers: z.array(ProviderStateSchema),
    sampledAt: z.iso.datetime(),
  })
  .strict();
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;

export const UsageHistoryPointSchema = z
  .object({ at: z.number().int().nonnegative(), usedPercent: z.number().min(0).max(100) })
  .strict();
export type UsageHistoryPoint = z.infer<typeof UsageHistoryPointSchema>;

export const UsageHistorySchema = z
  .object({
    windowId: z.string().min(1),
    label: z.string().min(1),
    points: z.array(UsageHistoryPointSchema),
  })
  .strict();
export type UsageHistory = z.infer<typeof UsageHistorySchema>;

export interface Timeframe {
  key: string;
  label: string;
  ms: number;
}
export const TIMEFRAMES: readonly Timeframe[] = [
  { key: "1h", label: "1h", ms: 3_600_000 },
  { key: "5h", label: "5h", ms: 5 * 3_600_000 },
  { key: "24h", label: "24h", ms: 24 * 3_600_000 },
  { key: "7d", label: "7d", ms: 7 * 24 * 3_600_000 },
  { key: "31d", label: "31d", ms: 31 * 24 * 3_600_000 },
];

export const TokenEventSchema = z
  .object({
    at: z.number().int().nonnegative(),
    provider: ProviderIdSchema,
    accountId: z.uuid().nullable(),
    model: z.string().min(1).nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type TokenEvent = z.infer<typeof TokenEventSchema>;

const TokenProviderTotalSchema = z
  .object({ tokens: z.number().nonnegative(), costUsd: z.number().nonnegative() })
  .strict();

export const TokenTimeframeSchema = z
  .object({
    key: z.string(),
    buckets: z.array(z.number().nonnegative()),
    bucketMs: z.number().positive(),
    totalTokens: z.number().nonnegative(),
    totalInput: z.number().nonnegative(),
    totalOutput: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    peakPerHour: z.number().nonnegative(),
    topModel: z.string().nullable(),
    byProvider: z
      .object({ openai: TokenProviderTotalSchema, anthropic: TokenProviderTotalSchema })
      .strict(),
  })
  .strict();
export type TokenTimeframe = z.infer<typeof TokenTimeframeSchema>;

export const TokenAnalyticsSchema = z
  .object({ timeframes: z.array(TokenTimeframeSchema) })
  .strict();
export type TokenAnalytics = z.infer<typeof TokenAnalyticsSchema>;

export const AnalyticsSnapshotSchema = z
  .object({
    snapshot: DashboardSnapshotSchema,
    history: z.array(
      z.object({ accountId: z.uuid(), windows: z.array(UsageHistorySchema) }).strict(),
    ),
    tokens: TokenAnalyticsSchema.nullish(),
  })
  .strict();
export type AnalyticsSnapshot = z.infer<typeof AnalyticsSnapshotSchema>;
