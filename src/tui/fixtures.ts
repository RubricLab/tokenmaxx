import {
  type Account,
  type AnalyticsSnapshot,
  AnalyticsSnapshotSchema,
  type AutomationPolicy,
  type ProviderId,
  type ProviderState,
  TIMEFRAMES,
  type TokenAnalytics,
  type UsageHistory,
  type UsageHistoryPoint,
  type UsageSnapshot,
  type UsageWindow,
} from "../domain.ts";
import { costUsd } from "../pricing.ts";
import { clamp } from "./format.ts";

function buildTokens(scale: number): TokenAnalytics {
  const timeframes = TIMEFRAMES.map((timeframe, seed) => {
    const hours = timeframe.ms / HOUR;
    const raw = Array.from({ length: 120 }, (_, i) =>
      Math.max(
        0,
        Math.sin(i * 0.35 + seed) * 0.5 +
          Math.sin(i * 0.13 + seed * 2) * 0.5 +
          noise(i + seed * 50) * 0.4 -
          0.12,
      ),
    );
    const rawSum = raw.reduce((sum, value) => sum + value, 0) || 1;
    const target = Math.round(150_000 * hours * 0.5 * scale);
    const buckets = raw.map((value) => Math.round((value / rawSum) * target));
    const totalTokens = buckets.reduce((sum, value) => sum + value, 0);
    const totalInput = Math.round(totalTokens * 0.7);
    const codexTokens = Math.round(totalTokens * 0.55);
    const claudeTokens = totalTokens - codexTokens;
    const codexCost = costUsd(
      "gpt-5.6-sol",
      Math.round(codexTokens * 0.7),
      Math.round(codexTokens * 0.3),
    );
    const claudeCost = costUsd(
      "claude-opus-4-8",
      Math.round(claudeTokens * 0.7),
      Math.round(claudeTokens * 0.3),
    );
    const bucketMs = timeframe.ms / 120;
    const peakBucket = buckets.reduce((max, value) => Math.max(max, value), 0);
    return {
      key: timeframe.key,
      buckets,
      bucketMs,
      totalTokens,
      totalInput,
      totalOutput: totalTokens - totalInput,
      costUsd: codexCost + claudeCost,
      peakPerHour: Math.round(peakBucket * (3_600_000 / bucketMs)),
      topModel: totalTokens === 0 ? null : "claude-opus-4-8",
      byProvider: {
        openai: { tokens: codexTokens, costUsd: codexCost },
        anthropic: { tokens: claudeTokens, costUsd: claudeCost },
      },
    };
  });
  return { timeframes };
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FIXTURE_NOW = Date.parse("2026-07-15T16:42:00.000Z");

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

function noise(index: number): number {
  const x = Math.sin(index * 12.9898) * 43_758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

interface WindowSpec {
  id: string;
  label: string;
  period: number;
  peak: number;
  nowFrac: number;
  fillFrac: number;
  wobble: number;
  seed: number;
}

function valueAt(spec: WindowSpec, at: number, now: number): number {
  const origin = now - spec.nowFrac * spec.period;
  const cycles = (at - origin) / spec.period;
  const frac = cycles - Math.floor(cycles);
  const ramp = Math.min(1, frac / spec.fillFrac);
  return clamp(spec.peak * ramp + spec.wobble * noise(Math.floor(at / (10 * MINUTE)) + spec.seed));
}

function toWindow(spec: WindowSpec, now: number): UsageWindow {
  return {
    id: spec.id,
    label: spec.label,
    usedPercent: Math.round(valueAt(spec, now, now)),
    resetAt: new Date(now + (1 - spec.nowFrac) * spec.period).toISOString(),
    kind: "hard",
  };
}

function toHistory(spec: WindowSpec, now: number): UsageHistory {
  const points: UsageHistoryPoint[] = [];
  const start = now - 31 * DAY;
  const fine = now - DAY;
  for (let at = start; at < fine; at += HOUR) {
    points.push({ at, usedPercent: Math.round(valueAt(spec, at, now)) });
  }
  for (let at = fine; at <= now; at += 10 * MINUTE) {
    points.push({ at, usedPercent: Math.round(valueAt(spec, at, now)) });
  }
  return { windowId: spec.id, label: spec.label, points };
}

interface AccountSeed {
  n: number;
  provider: ProviderId;
  email: string;
  plan: string | null;
  health?: Account["health"];
  windows?: WindowSpec[];
}

function account(seed: AccountSeed, now: number): Account {
  const base = {
    id: uuid(seed.n),
    label: seed.email,
    identity: seed.email,
    externalAccountId: `acct_${seed.n.toString().padStart(4, "0")}`,
    plan: seed.plan,
    health: seed.health ?? "ready",
    enabled: true,
    createdAt: new Date(now - 34 * DAY).toISOString(),
    updatedAt: new Date(now - 40 * MINUTE).toISOString(),
  } as const;
  return seed.provider === "openai"
    ? {
        ...base,
        provider: "openai",
        externalUserId: `user_${seed.n}`,
        secretReference: `codex:${base.externalAccountId}`,
        profilePath: null,
      }
    : {
        ...base,
        provider: "anthropic",
        externalUserId: null,
        secretReference: null,
        profilePath: `/tmp/tokenmaxx/claude/${seed.n}`,
      };
}

function usage(seed: AccountSeed, now: number): UsageSnapshot {
  const windows = (seed.windows ?? []).map((spec) => toWindow(spec, now));
  const base = {
    accountId: uuid(seed.n),
    observedAt: new Date(now - 40 * MINUTE).toISOString(),
    windows,
    hardLimitReached: windows.some((window) => window.usedPercent >= 100),
  } as const;
  return seed.provider === "openai"
    ? { ...base, provider: "openai", source: "codexUsageEndpoint" }
    : { ...base, provider: "anthropic", source: "claudeUsageEndpoint" };
}

function policy(provider: ProviderId, enabled: boolean, thresholdPercent = 95): AutomationPolicy {
  return {
    provider,
    enabled,
    thresholdPercent,
    hysteresisPercent: 5,
    minimumDwellMilliseconds: 300_000,
    maximumSnapshotAgeMilliseconds: 120_000,
    authorization: enabled ? "confirmed" : "notConfirmed",
  };
}

interface ProviderSeed {
  provider: ProviderId;
  activeN: number | null;
  generation: number;
  switchedMinutesAgo: number | null;
  auto: boolean;
  threshold?: number;
}

function providerState(seed: ProviderSeed, now: number): ProviderState {
  return {
    provider: seed.provider,
    activeAccountId: seed.activeN === null ? null : uuid(seed.activeN),
    generation: seed.generation,
    switchedAt:
      seed.switchedMinutesAgo === null
        ? null
        : new Date(now - seed.switchedMinutesAgo * MINUTE).toISOString(),
    policy: policy(seed.provider, seed.auto, seed.threshold),
  };
}

function assemble(
  now: number,
  accounts: AccountSeed[],
  providers: ProviderSeed[],
  tokenScale = 1,
): AnalyticsSnapshot {
  return AnalyticsSnapshotSchema.parse({
    snapshot: {
      accounts: accounts.map((seed) => account(seed, now)),
      usage: accounts.map((seed) => usage(seed, now)),
      providers: providers.map((seed) => providerState(seed, now)),
      sampledAt: new Date(now - 40 * MINUTE).toISOString(),
    },
    history: accounts.map((seed) => ({
      accountId: uuid(seed.n),
      windows: (seed.windows ?? []).map((spec) => toHistory(spec, now)),
    })),
    tokens: buildTokens(tokenScale),
  });
}

const fiveHour = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
  id: "five-hour",
  label: "5 hour",
  period: 5 * HOUR,
  peak,
  nowFrac,
  fillFrac: 0.92,
  wobble: 4,
  seed,
});
const weekly = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
  id: "weekly",
  label: "7 day · all models",
  period: 7 * DAY,
  peak,
  nowFrac,
  fillFrac: 1,
  wobble: 2,
  seed,
});
const fable = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
  id: "weekly_scoped:fable",
  label: "7 day · Fable",
  period: 7 * DAY,
  peak,
  nowFrac,
  fillFrac: 1,
  wobble: 3,
  seed,
});
const claudeSession = (peak: number, nowFrac: number, seed: number): WindowSpec => ({
  ...fiveHour(peak, nowFrac, seed),
  label: "5h session",
});

type ScenarioBuilder = (now: number) => AnalyticsSnapshot;

const cruising: ScenarioBuilder = (now) =>
  assemble(
    now,
    [
      {
        n: 1,
        provider: "openai",
        email: "dexter@rubriclabs.com",
        plan: "pro",
        windows: [fiveHour(58, 0.62, 11), weekly(44, 0.63, 21)],
      },
      {
        n: 2,
        provider: "openai",
        email: "ship@rubriclabs.com",
        plan: "pro",
        windows: [fiveHour(21, 0.3, 12), weekly(33, 0.61, 22)],
      },
      {
        n: 3,
        provider: "anthropic",
        email: "dexter@rubriclabs.com",
        plan: "claude_max_20x",
        windows: [claudeSession(47, 0.55, 31), weekly(29, 0.5, 41), fable(38, 0.44, 51)],
      },
      {
        n: 4,
        provider: "anthropic",
        email: "research@rubriclabs.com",
        plan: "claude_max_5x",
        windows: [claudeSession(18, 0.24, 32), weekly(22, 0.4, 42), fable(12, 0.2, 52)],
      },
    ],
    [
      { provider: "openai", activeN: 1, generation: 4, switchedMinutesAgo: 96, auto: true },
      { provider: "anthropic", activeN: 3, generation: 2, switchedMinutesAgo: 210, auto: true },
    ],
  );

const oneHot: ScenarioBuilder = (now) =>
  assemble(
    now,
    [
      {
        n: 1,
        provider: "openai",
        email: "dexter@rubriclabs.com",
        plan: "pro",
        windows: [fiveHour(99, 0.87, 11), weekly(72, 0.7, 21)],
      },
      {
        n: 2,
        provider: "openai",
        email: "ship@rubriclabs.com",
        plan: "pro",
        windows: [fiveHour(23, 0.28, 12), weekly(41, 0.6, 22)],
      },
      {
        n: 3,
        provider: "anthropic",
        email: "dexter@rubriclabs.com",
        plan: "claude_max_20x",
        windows: [claudeSession(63, 0.6, 31), weekly(48, 0.62, 41), fable(97, 0.9, 51)],
      },
      {
        n: 4,
        provider: "anthropic",
        email: "research@rubriclabs.com",
        plan: "claude_max_5x",
        windows: [claudeSession(31, 0.35, 32), weekly(27, 0.45, 42), fable(19, 0.3, 52)],
      },
    ],
    [
      { provider: "openai", activeN: 1, generation: 7, switchedMinutesAgo: 288, auto: true },
      { provider: "anthropic", activeN: 3, generation: 3, switchedMinutesAgo: 420, auto: true },
    ],
  );

const rotated: ScenarioBuilder = (now) =>
  assemble(
    now,
    [
      {
        n: 2,
        provider: "openai",
        email: "ship@rubriclabs.com",
        plan: "pro",
        windows: [fiveHour(19, 0.22, 12), weekly(38, 0.58, 22)],
      },
      {
        n: 1,
        provider: "openai",
        email: "dexter@rubriclabs.com",
        plan: "pro",
        windows: [fiveHour(96, 0.95, 11), weekly(74, 0.72, 21)],
      },
      {
        n: 3,
        provider: "anthropic",
        email: "dexter@rubriclabs.com",
        plan: "claude_max_20x",
        windows: [claudeSession(44, 0.5, 31), weekly(46, 0.6, 41), fable(52, 0.55, 51)],
      },
      {
        n: 4,
        provider: "anthropic",
        email: "research@rubriclabs.com",
        plan: "claude_max_5x",
        windows: [claudeSession(16, 0.2, 32), weekly(24, 0.42, 42), fable(14, 0.24, 52)],
      },
    ],
    [
      { provider: "openai", activeN: 2, generation: 8, switchedMinutesAgo: 2, auto: true },
      { provider: "anthropic", activeN: 3, generation: 3, switchedMinutesAgo: 420, auto: true },
    ],
  );

const onboarding: ScenarioBuilder = (now) =>
  assemble(
    now,
    [],
    [
      { provider: "openai", activeN: null, generation: 0, switchedMinutesAgo: null, auto: false },
      {
        provider: "anthropic",
        activeN: null,
        generation: 0,
        switchedMinutesAgo: null,
        auto: false,
      },
    ],
    0,
  );

const scenarios: Record<string, ScenarioBuilder> = { cruising, oneHot, rotated, onboarding };

export const SCENARIO_NAMES = Object.keys(scenarios);

export function buildScenario(name: string, now: number = FIXTURE_NOW): AnalyticsSnapshot {
  const builder = scenarios[name];
  if (builder === undefined) {
    throw new Error(`Unknown fixture scenario: ${name} (have ${SCENARIO_NAMES.join(", ")})`);
  }
  return builder(now);
}
