import { z } from "zod";
import {
  type Account,
  type ProviderState,
  type UsageSnapshot,
  UsageSnapshotSchema,
} from "./domain.ts";

export const RotationDecisionSchema = z.discriminatedUnion("rotate", [
  z.object({
    rotate: z.literal(true),
    sourceAccountId: z.uuid(),
    targetAccountId: z.uuid(),
    sourcePressure: z.number().min(0).max(100),
    targetPressure: z.number().min(0).max(100),
    reason: z.enum(["threshold", "hardLimit"]),
  }),
  z.object({
    rotate: z.literal(false),
    reason: z.enum([
      "disabled",
      "authorizationRequired",
      "noActiveAccount",
      "activeUsageUnknown",
      "activeUsageStale",
      "belowThreshold",
      "minimumDwell",
      "noEligibleCandidate",
    ]),
  }),
]);
export type RotationDecision = z.infer<typeof RotationDecisionSchema>;

export interface RotationInput {
  accounts: readonly Account[];
  usage: readonly UsageSnapshot[];
  state: ProviderState;
  now: Date;
}

function hardPressure(snapshot: UsageSnapshot): number | null {
  const pressures = snapshot.windows
    .filter((window) => window.kind === "hard")
    .map((window) => window.usedPercent);
  return pressures.length === 0 ? null : Math.max(...pressures);
}

function isFresh(snapshot: UsageSnapshot, now: Date, maximumAgeMilliseconds: number): boolean {
  const observedAt = Date.parse(snapshot.observedAt);
  const age = now.getTime() - observedAt;
  return Number.isFinite(observedAt) && age >= -5_000 && age <= maximumAgeMilliseconds;
}

function eligibleHealth(account: Account): boolean {
  switch (account.health) {
    case "ready":
    case "loginExpiring":
      return account.enabled;
    default:
      return false;
  }
}

export function selectRotation(input: RotationInput): RotationDecision {
  const { policy } = input.state;
  if (!policy.enabled) {
    return { rotate: false, reason: "disabled" };
  }
  if (policy.authorization !== "confirmed") {
    return { rotate: false, reason: "authorizationRequired" };
  }
  if (input.state.activeAccountId === null) {
    return { rotate: false, reason: "noActiveAccount" };
  }

  const snapshotByAccount = new Map(
    input.usage.map((snapshot) => {
      const parsed = UsageSnapshotSchema.parse(snapshot);
      return [parsed.accountId, parsed] as const;
    }),
  );
  const activeSnapshot = snapshotByAccount.get(input.state.activeAccountId);
  if (activeSnapshot === undefined) {
    return { rotate: false, reason: "activeUsageUnknown" };
  }
  if (!isFresh(activeSnapshot, input.now, policy.maximumSnapshotAgeMilliseconds)) {
    return { rotate: false, reason: "activeUsageStale" };
  }
  const activePressure = hardPressure(activeSnapshot);
  if (activePressure === null) {
    return { rotate: false, reason: "activeUsageUnknown" };
  }
  if (!activeSnapshot.hardLimitReached && activePressure < policy.thresholdPercent) {
    return { rotate: false, reason: "belowThreshold" };
  }
  if (input.state.switchedAt !== null) {
    const dwell = input.now.getTime() - Date.parse(input.state.switchedAt);
    if (dwell < policy.minimumDwellMilliseconds) {
      return { rotate: false, reason: "minimumDwell" };
    }
  }

  const targetCeiling = policy.thresholdPercent - policy.hysteresisPercent;
  const candidates = input.accounts
    .filter(
      (account) =>
        account.provider === input.state.provider &&
        account.id !== input.state.activeAccountId &&
        eligibleHealth(account),
    )
    .flatMap((account) => {
      const snapshot = snapshotByAccount.get(account.id);
      if (
        snapshot === undefined ||
        snapshot.provider !== account.provider ||
        snapshot.hardLimitReached ||
        !isFresh(snapshot, input.now, policy.maximumSnapshotAgeMilliseconds)
      ) {
        return [];
      }
      const pressure = hardPressure(snapshot);
      if (pressure === null || pressure > targetCeiling) {
        return [];
      }
      return [{ account, pressure }];
    })
    .sort(
      (left, right) =>
        left.pressure - right.pressure || left.account.id.localeCompare(right.account.id),
    );

  const target = candidates[0];
  if (target === undefined) {
    return { rotate: false, reason: "noEligibleCandidate" };
  }

  return {
    rotate: true,
    sourceAccountId: input.state.activeAccountId,
    targetAccountId: target.account.id,
    sourcePressure: activePressure,
    targetPressure: target.pressure,
    reason: activeSnapshot.hardLimitReached ? "hardLimit" : "threshold",
  };
}
