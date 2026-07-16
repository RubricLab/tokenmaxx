import type { Account, ProviderId, UsageSnapshot } from "../domain.ts";
import { ApplicationError } from "../errors.ts";

export interface ProviderProbeResult {
  account: Account;
  usage: UsageSnapshot;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  probe(account: Account): Promise<ProviderProbeResult>;
}

export function requireProvider<P extends ProviderId>(
  account: Account,
  provider: P,
): Extract<Account, { provider: P }> {
  if (account.provider !== provider) {
    throw new ApplicationError(
      "PROVIDER_MISMATCH",
      `${provider} adapter received a ${account.provider} account`,
    );
  }
  return account as Extract<Account, { provider: P }>;
}
