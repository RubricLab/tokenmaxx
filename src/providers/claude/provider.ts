import { type Account, AccountEmailSchema } from "../../domain.ts";
import { ApplicationError } from "../../errors.ts";
import type { FetchImplementation } from "../../http.ts";
import { type ProviderAdapter, type ProviderProbeResult, requireProvider } from "../provider.ts";
import {
  claudePlanTier,
  defaultClaudeCredentialReader,
  fetchClaudeProfile,
  refreshClaudeProfile,
} from "./auth.ts";
import { fetchClaudeUsage } from "./usage.ts";

export interface AnthropicProviderDependencies {
  fetchImplementation: FetchImplementation;
  now(): Date;
}

function scopesPermitUsage(scopes: string | string[] | undefined): boolean {
  if (scopes === undefined) {
    return true;
  }
  const values = Array.isArray(scopes) ? scopes : scopes.split(/[ ,]+/);
  return values.includes("user:profile");
}

function health(refreshTokenExpiresAt: number | undefined, now: Date): Account["health"] {
  if (refreshTokenExpiresAt === undefined) {
    return "ready";
  }
  if (refreshTokenExpiresAt <= now.getTime()) {
    return "reauthenticationRequired";
  }
  return refreshTokenExpiresAt <= now.getTime() + 5 * 24 * 60 * 60 * 1000
    ? "loginExpiring"
    : "ready";
}

function assertIdentity(
  account: Extract<Account, { provider: "anthropic" }>,
  accountId: string,
): void {
  if (account.externalAccountId !== null && account.externalAccountId !== accountId) {
    throw new ApplicationError(
      "IDENTITY_CHANGED",
      "Stored Claude credential belongs to a different account",
    );
  }
}

export class AnthropicProviderAdapter implements ProviderAdapter {
  public readonly provider = "anthropic" as const;
  readonly #dependencies: AnthropicProviderDependencies;
  readonly #verifiedIdentities = new Map<
    string,
    { accessToken: string; accountId: string; email: string | null }
  >();

  public constructor(input: { dependencies: AnthropicProviderDependencies }) {
    this.#dependencies = input.dependencies;
  }

  public async probe(account: Account): Promise<ProviderProbeResult> {
    const anthropicAccount = requireProvider(account, "anthropic");
    const profilePath = anthropicAccount.profilePath;
    if (profilePath === null) {
      throw new ApplicationError("CREDENTIAL_MISSING", `${account.label} has no stored profile`);
    }
    const reader = defaultClaudeCredentialReader();
    let credential = await reader.read(profilePath);
    if (credential.expiresAt <= this.#dependencies.now().getTime() + 300_000) {
      credential = await refreshClaudeProfile({ profilePath, credentialReader: reader });
    }
    if (!scopesPermitUsage(credential.scopes)) {
      throw new ApplicationError(
        "SCOPE_MISSING",
        "Claude credential does not include the user:profile scope required for usage",
      );
    }
    const verifyIdentity = async (): Promise<{ accountId: string; email: string | null }> => {
      const cached = this.#verifiedIdentities.get(profilePath);
      if (cached !== undefined && cached.accessToken === credential.accessToken) {
        return { accountId: cached.accountId, email: cached.email };
      }
      const fetched = await fetchClaudeProfile(
        credential.accessToken,
        this.#dependencies.fetchImplementation,
      );
      this.#verifiedIdentities.set(profilePath, {
        accessToken: credential.accessToken,
        ...fetched,
      });
      return fetched;
    };
    let profile = await verifyIdentity().catch(async (error) => {
      if (!(error instanceof ApplicationError) || error.code !== "REAUTHENTICATION_REQUIRED") {
        throw error;
      }
      credential = await refreshClaudeProfile({ profilePath, credentialReader: reader });
      return verifyIdentity();
    });
    assertIdentity(anthropicAccount, profile.accountId);
    const usage = await fetchClaudeUsage({
      accountId: anthropicAccount.id,
      accessToken: credential.accessToken,
      fetchImplementation: this.#dependencies.fetchImplementation,
    }).catch(async (error) => {
      if (!(error instanceof ApplicationError) || error.code !== "ACCESS_TOKEN_REJECTED") {
        throw error;
      }
      credential = await refreshClaudeProfile({ profilePath, credentialReader: reader });
      profile = await verifyIdentity();
      return fetchClaudeUsage({
        accountId: anthropicAccount.id,
        accessToken: credential.accessToken,
        fetchImplementation: this.#dependencies.fetchImplementation,
      });
    });
    assertIdentity(anthropicAccount, profile.accountId);
    const email = AccountEmailSchema.safeParse(profile.email);
    return {
      account: {
        ...anthropicAccount,
        plan: claudePlanTier(credential) ?? anthropicAccount.plan ?? null,
        label: email.success ? email.data : anthropicAccount.label,
        identity: email.success ? email.data : anthropicAccount.identity,
        health: health(credential.refreshTokenExpiresAt, this.#dependencies.now()),
        updatedAt: this.#dependencies.now().toISOString(),
      },
      usage,
    };
  }
}
