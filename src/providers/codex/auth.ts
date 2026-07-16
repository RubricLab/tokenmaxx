import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Account, AccountEmailSchema } from "../../domain.ts";
import { ApplicationError } from "../../errors.ts";
import type { FetchImplementation } from "../../http.ts";

const openAiClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const refreshEndpoint = "https://auth.openai.com/oauth/token";

export const CodexTokensSchema = z
  .object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1).optional(),
  })
  .passthrough();
export type CodexTokens = z.infer<typeof CodexTokensSchema>;

export const CodexAuthSchema = z
  .object({
    auth_mode: z.string().optional(),
    tokens: CodexTokensSchema,
    last_refresh: z.string().optional(),
  })
  .passthrough();
export type CodexAuth = z.infer<typeof CodexAuthSchema>;

const JwtClaimsSchema = z
  .object({
    exp: z.number().optional(),
    sub: z.string().optional(),
    email: z.string().email().optional(),
    chatgpt_account_id: z.string().optional(),
    chatgpt_user_id: z.string().optional(),
    "https://api.openai.com/auth": z
      .object({
        chatgpt_account_id: z.string().optional(),
        chatgpt_user_id: z.string().optional(),
        chatgpt_plan_type: z.string().optional(),
        user_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const RefreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
  })
  .passthrough();

export interface CodexIdentity {
  accountId: string;
  userId: string | null;
  email: string | null;
  plan: string | null;
  accessExpiresAt: string | null;
}

export interface CredentialVault {
  read(reference: string): Promise<string | null>;
  write(reference: string, value: string): Promise<void>;
  remove(reference: string): Promise<void>;
}

export interface CodexLoginDependencies {
  run(command: readonly string[], environment: Record<string, string | undefined>): Promise<number>;
  createTemporaryDirectory(prefix: string): Promise<string>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

const refreshLocks = new Map<string, Promise<void>>();

function base64UrlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch (error) {
    throw new ApplicationError("INVALID_JWT", "OAuth token contains an invalid JWT payload", {
      cause: error,
    });
  }
}

export function decodeJwtClaims(token: string): z.infer<typeof JwtClaimsSchema> {
  const segments = token.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) {
    throw new ApplicationError("INVALID_JWT", "OAuth token is not a three-segment JWT");
  }
  return JwtClaimsSchema.parse(base64UrlJson(payload));
}

export function codexIdentity(auth: CodexAuth): CodexIdentity {
  const parsed = CodexAuthSchema.parse(auth);
  const claims = decodeJwtClaims(parsed.tokens.id_token);
  const accessClaims = decodeJwtClaims(parsed.tokens.access_token);
  const namespaced = claims["https://api.openai.com/auth"];
  const accountId =
    parsed.tokens.account_id ??
    claims.chatgpt_account_id ??
    namespaced?.chatgpt_account_id ??
    accessClaims.chatgpt_account_id;
  if (accountId === undefined) {
    throw new ApplicationError("ACCOUNT_ID_MISSING", "Codex credential has no ChatGPT account id");
  }
  const expiresAt =
    accessClaims.exp === undefined ? null : new Date(accessClaims.exp * 1000).toISOString();
  return {
    accountId,
    userId:
      claims.chatgpt_user_id ??
      namespaced?.chatgpt_user_id ??
      namespaced?.user_id ??
      claims.sub ??
      null,
    email: claims.email ?? accessClaims.email ?? null,
    plan: namespaced?.chatgpt_plan_type ?? null,
    accessExpiresAt: expiresAt,
  };
}

export function defaultCodexLoginDependencies(): CodexLoginDependencies {
  return {
    async run(command, environment) {
      const child = Bun.spawn([...command], {
        env: { ...process.env, ...environment },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return child.exited;
    },
    createTemporaryDirectory: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    read: (path) => readFile(path, "utf8"),
    remove: (path) => rm(path, { recursive: true, force: true }),
  };
}

export async function registerCodexAccount(input: {
  vault: CredentialVault;
  dependencies?: CodexLoginDependencies;
}): Promise<Account> {
  const dependencies = input.dependencies ?? defaultCodexLoginDependencies();
  const temporaryHome = await dependencies.createTemporaryDirectory("tokenmaxx-register-");
  try {
    const exitCode = await dependencies.run(
      ["codex", "login", "-c", 'cli_auth_credentials_store="file"'],
      {
        CODEX_HOME: temporaryHome,
      },
    );
    if (exitCode !== 0) {
      throw new ApplicationError("LOGIN_FAILED", `codex login exited with ${exitCode}`);
    }
    const serialized = await dependencies.read(join(temporaryHome, "auth.json"));
    const auth = CodexAuthSchema.parse(JSON.parse(serialized));
    const identity = codexIdentity(auth);
    const email = AccountEmailSchema.safeParse(identity.email);
    if (!email.success) {
      throw new ApplicationError(
        "ACCOUNT_EMAIL_MISSING",
        "Codex did not return a verified account email; the login was not stored",
      );
    }
    const id = crypto.randomUUID();
    const secretReference = `codex:${id}`;
    await input.vault.write(secretReference, JSON.stringify(auth));
    const now = new Date().toISOString();
    return {
      id,
      provider: "openai",
      label: email.data,
      identity: email.data,
      externalAccountId: identity.accountId,
      externalUserId: identity.userId,
      plan: identity.plan,
      secretReference,
      profilePath: null,
      health: "ready",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  } finally {
    await dependencies.remove(temporaryHome);
  }
}

async function exclusive<Result>(
  reference: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = refreshLocks.get(reference) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  refreshLocks.set(reference, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (refreshLocks.get(reference) === queued) {
      refreshLocks.delete(reference);
    }
  }
}

export async function readCodexCredential(
  vault: CredentialVault,
  reference: string,
): Promise<CodexAuth> {
  const serialized = await vault.read(reference);
  if (serialized === null) {
    throw new ApplicationError("CREDENTIAL_MISSING", `Missing credential ${reference}`);
  }
  return CodexAuthSchema.parse(JSON.parse(serialized));
}

export async function refreshCodexCredential(input: {
  reference: string;
  vault: CredentialVault;
  fetchImplementation?: FetchImplementation;
}): Promise<CodexAuth> {
  return exclusive(input.reference, async () => {
    const current = await readCodexCredential(input.vault, input.reference);
    const response = await (input.fetchImplementation ?? fetch)(refreshEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: openAiClientId,
        grant_type: "refresh_token",
        refresh_token: current.tokens.refresh_token,
      }),
      signal: AbortSignal.timeout(7_000),
    });
    if (response.status === 400 || response.status === 401) {
      throw new ApplicationError("REAUTHENTICATION_REQUIRED", "Codex refresh token was rejected");
    }
    if (!response.ok) {
      throw new ApplicationError(
        "PROVIDER_UNREACHABLE",
        `Codex token refresh returned HTTP ${response.status}`,
      );
    }
    const refreshed = RefreshResponseSchema.parse(await response.json());
    const updated = CodexAuthSchema.parse({
      ...current,
      tokens: {
        ...current.tokens,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? current.tokens.refresh_token,
        id_token: refreshed.id_token ?? current.tokens.id_token,
      },
      last_refresh: new Date().toISOString(),
    });
    const priorIdentity = codexIdentity(current);
    const updatedIdentity = codexIdentity(updated);
    if (priorIdentity.accountId !== updatedIdentity.accountId) {
      throw new ApplicationError(
        "IDENTITY_CHANGED",
        "Refreshed credential belongs to a different account",
      );
    }
    await input.vault.write(input.reference, JSON.stringify(updated));
    return updated;
  });
}
