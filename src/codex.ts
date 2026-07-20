import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
	type Account,
	AccountEmailSchema,
	type FetchImplementation,
	type ProviderProbeResult,
	type ResetCreditsView,
	type ResetOutcome,
	type UsageSnapshot,
	type UsageWindow
} from './domain.ts'
import { ApplicationError } from './errors.ts'
import { type UpstreamInjection, upstreamFor } from './proxy.ts'
import { type CredentialVault, exclusive } from './vault.ts'

const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
const refreshEndpoint = 'https://auth.openai.com/oauth/token'
const usageEndpoint = 'https://chatgpt.com/backend-api/wham/usage'
const resetCreditsEndpoint = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const consumeResetEndpoint = `${resetCreditsEndpoint}/consume`

const CodexTokensSchema = z
	.object({
		access_token: z.string().min(1),
		account_id: z.string().min(1).optional(),
		id_token: z.string().min(1),
		refresh_token: z.string().min(1)
	})
	.passthrough()

const CodexAuthSchema = z
	.object({
		auth_mode: z.string().optional(),
		last_refresh: z.string().optional(),
		tokens: CodexTokensSchema
	})
	.passthrough()
export type CodexAuth = z.infer<typeof CodexAuthSchema>

const JwtClaimsSchema = z
	.object({
		chatgpt_account_id: z.string().optional(),
		chatgpt_user_id: z.string().optional(),
		email: z.string().email().optional(),
		exp: z.number().optional(),
		'https://api.openai.com/auth': z
			.object({
				chatgpt_account_id: z.string().optional(),
				chatgpt_plan_type: z.string().optional(),
				chatgpt_user_id: z.string().optional(),
				user_id: z.string().optional()
			})
			.passthrough()
			.optional(),
		sub: z.string().optional()
	})
	.passthrough()

const RefreshResponseSchema = z
	.object({
		access_token: z.string().min(1),
		id_token: z.string().min(1).optional(),
		refresh_token: z.string().min(1).optional()
	})
	.passthrough()

interface CodexIdentity {
	accountId: string
	userId: string | null
	email: string | null
	plan: string | null
	accessExpiresAt: string | null
}

interface CodexLoginDependencies {
	run(command: readonly string[], environment: Record<string, string | undefined>): Promise<number>
	createTemporaryDirectory(prefix: string): Promise<string>
	read(path: string): Promise<string>
	remove(path: string): Promise<void>
}

function base64UrlJson(segment: string): unknown {
	try {
		return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
	} catch (error) {
		throw new ApplicationError('INVALID_JWT', 'OAuth token contains an invalid JWT payload', {
			cause: error
		})
	}
}

function decodeJwtClaims(token: string): z.infer<typeof JwtClaimsSchema> {
	const segments = token.split('.')
	const payload = segments[1]
	if (segments.length !== 3 || payload === undefined) {
		throw new ApplicationError('INVALID_JWT', 'OAuth token is not a three-segment JWT')
	}
	return JwtClaimsSchema.parse(base64UrlJson(payload))
}

function codexIdentity(auth: CodexAuth): CodexIdentity {
	const parsed = CodexAuthSchema.parse(auth)
	const claims = decodeJwtClaims(parsed.tokens.id_token)
	const accessClaims = decodeJwtClaims(parsed.tokens.access_token)
	const namespaced = claims['https://api.openai.com/auth']
	const accountId =
		parsed.tokens.account_id ??
		claims.chatgpt_account_id ??
		namespaced?.chatgpt_account_id ??
		accessClaims.chatgpt_account_id
	if (accountId === undefined) {
		throw new ApplicationError('ACCOUNT_ID_MISSING', 'Codex credential has no ChatGPT account id')
	}
	const expiresAt =
		accessClaims.exp === undefined ? null : new Date(accessClaims.exp * 1000).toISOString()
	return {
		accessExpiresAt: expiresAt,
		accountId,
		email: claims.email ?? accessClaims.email ?? null,
		plan: namespaced?.chatgpt_plan_type ?? null,
		userId:
			claims.chatgpt_user_id ??
			namespaced?.chatgpt_user_id ??
			namespaced?.user_id ??
			claims.sub ??
			null
	}
}

function defaultCodexLoginDependencies(): CodexLoginDependencies {
	return {
		createTemporaryDirectory: prefix => mkdtemp(join(tmpdir(), prefix)),
		read: path => readFile(path, 'utf8'),
		remove: path => rm(path, { force: true, recursive: true }),
		async run(command, environment) {
			const child = Bun.spawn([...command], {
				env: { ...process.env, ...environment },
				stderr: 'inherit',
				stdin: 'inherit',
				stdout: 'inherit'
			})
			return child.exited
		}
	}
}

export async function registerCodexAccount(input: {
	vault: CredentialVault
	dependencies?: CodexLoginDependencies
}): Promise<Account> {
	const dependencies = input.dependencies ?? defaultCodexLoginDependencies()
	const temporaryHome = await dependencies.createTemporaryDirectory('tokenmaxx-register-')
	try {
		const exitCode = await dependencies.run(
			['codex', 'login', '-c', 'cli_auth_credentials_store="file"'],
			{
				CODEX_HOME: temporaryHome
			}
		)
		if (exitCode !== 0) {
			throw new ApplicationError('LOGIN_FAILED', `codex login exited with ${exitCode}`)
		}
		const serialized = await dependencies.read(join(temporaryHome, 'auth.json'))
		const auth = CodexAuthSchema.parse(JSON.parse(serialized))
		const identity = codexIdentity(auth)
		const email = AccountEmailSchema.safeParse(identity.email)
		if (!email.success) {
			throw new ApplicationError(
				'ACCOUNT_EMAIL_MISSING',
				'Codex did not return a verified account email; the login was not stored'
			)
		}
		const id = crypto.randomUUID()
		const secretReference = `codex:${id}`
		await input.vault.write(secretReference, JSON.stringify(auth))
		const now = new Date().toISOString()
		return {
			createdAt: now,
			enabled: true,
			externalAccountId: identity.accountId,
			externalUserId: identity.userId,
			health: 'ready',
			id,
			identity: email.data,
			label: email.data,
			plan: identity.plan,
			profilePath: null,
			provider: 'openai',
			secretReference,
			updatedAt: now
		}
	} finally {
		await dependencies.remove(temporaryHome)
	}
}

async function readCodexCredential(vault: CredentialVault, reference: string): Promise<CodexAuth> {
	const serialized = await vault.read(reference)
	if (serialized === null) {
		throw new ApplicationError('CREDENTIAL_MISSING', `Missing credential ${reference}`)
	}
	return CodexAuthSchema.parse(JSON.parse(serialized))
}

async function refreshCodexCredential(input: {
	reference: string
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
}): Promise<CodexAuth> {
	return exclusive(input.reference, async () => {
		const current = await readCodexCredential(input.vault, input.reference)
		const response = await (input.fetchImplementation ?? fetch)(refreshEndpoint, {
			body: JSON.stringify({
				client_id: clientId,
				grant_type: 'refresh_token',
				refresh_token: current.tokens.refresh_token
			}),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST',
			signal: AbortSignal.timeout(7_000)
		})
		if (response.status === 400 || response.status === 401) {
			throw new ApplicationError('REAUTHENTICATION_REQUIRED', 'Codex refresh token was rejected')
		}
		if (!response.ok) {
			throw new ApplicationError(
				'PROVIDER_UNREACHABLE',
				`Codex token refresh returned HTTP ${response.status}`
			)
		}
		const refreshed = RefreshResponseSchema.parse(await response.json())
		const updated = CodexAuthSchema.parse({
			...current,
			last_refresh: new Date().toISOString(),
			tokens: {
				...current.tokens,
				access_token: refreshed.access_token,
				id_token: refreshed.id_token ?? current.tokens.id_token,
				refresh_token: refreshed.refresh_token ?? current.tokens.refresh_token
			}
		})
		const priorIdentity = codexIdentity(current)
		const updatedIdentity = codexIdentity(updated)
		if (priorIdentity.accountId !== updatedIdentity.accountId) {
			throw new ApplicationError(
				'IDENTITY_CHANGED',
				'Refreshed credential belongs to a different account'
			)
		}
		await input.vault.write(input.reference, JSON.stringify(updated))
		return updated
	})
}

const refreshMarginMilliseconds = 120_000

export async function codexUpstream(input: {
	account: Extract<Account, { provider: 'openai' }>
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
	now?: () => number
	forceRefresh: boolean
}): Promise<UpstreamInjection> {
	const reference = input.account.secretReference
	let auth = await readCodexCredential(input.vault, reference)
	const now = input.now ?? (() => Date.now())
	const expiresAt = codexIdentity(auth).accessExpiresAt
	const expiry = expiresAt === null ? null : Date.parse(expiresAt)
	const stale = expiry !== null && expiry - now() <= refreshMarginMilliseconds
	if (input.forceRefresh || stale) {
		auth = await refreshCodexCredential({
			fetchImplementation: input.fetchImplementation,
			reference,
			vault: input.vault
		})
	}
	return {
		accountId: input.account.id,
		baseUrl: upstreamFor('openai'),
		headers: {
			authorization: `Bearer ${auth.tokens.access_token}`,
			'chatgpt-account-id': codexIdentity(auth).accountId
		}
	}
}

const WindowSchema = z
	.object({
		limit_window_seconds: z.number().nonnegative().optional(),
		reset_at: z.number().nonnegative().optional(),
		used_percent: z.number().min(0).max(100)
	})
	.passthrough()

const LimitDetailsSchema = z
	.object({
		allowed: z.boolean().optional(),
		limit_reached: z.boolean().optional(),
		primary_window: WindowSchema.nullish(),
		secondary_window: WindowSchema.nullish()
	})
	.passthrough()

const AdditionalLimitSchema = z
	.object({
		limit_name: z.string().min(1),
		metered_feature: z.string().min(1),
		rate_limit: LimitDetailsSchema.nullish()
	})
	.passthrough()

const UsageResponseSchema = z
	.object({
		additional_rate_limits: z.array(AdditionalLimitSchema).nullish(),
		rate_limit: LimitDetailsSchema.nullish(),
		rate_limit_reached_type: z.unknown().nullish(),
		rate_limit_reset_credits: z
			.object({
				applicable_available_count: z.number().int().nonnegative(),
				available_count: z.number().int().nonnegative()
			})
			.passthrough()
			.nullish()
	})
	.passthrough()

type UsageResponse = z.infer<typeof UsageResponseSchema>

function durationLabel(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined || seconds === 0) {
		return fallback
	}
	const hours = seconds / 3_600
	if (Number.isInteger(hours) && hours < 24) {
		return `${hours} hour`
	}
	const days = hours / 24
	if (Number.isInteger(days)) {
		return `${days} day`
	}
	return fallback
}

function toWindow(
	id: string,
	scope: string,
	fallback: string,
	window: z.infer<typeof WindowSchema>
): UsageWindow {
	const duration = durationLabel(window.limit_window_seconds, fallback)
	return {
		id,
		kind: 'hard',
		label: scope === 'Codex' ? duration : `${scope} · ${duration}`,
		resetAt: window.reset_at === undefined ? null : new Date(window.reset_at * 1000).toISOString(),
		usedPercent: window.used_percent
	}
}

function appendLimitWindows(
	windows: UsageWindow[],
	prefix: string,
	label: string,
	details: z.infer<typeof LimitDetailsSchema> | null | undefined
): void {
	if (details?.primary_window != null) {
		windows.push(toWindow(`${prefix}:primary`, label, 'primary', details.primary_window))
	}
	if (details?.secondary_window != null) {
		windows.push(toWindow(`${prefix}:secondary`, label, 'secondary', details.secondary_window))
	}
}

function normalizeResponse(accountId: string, body: UsageResponse): UsageSnapshot {
	const windows: UsageWindow[] = []
	appendLimitWindows(windows, 'codex', 'Codex', body.rate_limit)
	for (const additional of body.additional_rate_limits ?? []) {
		appendLimitWindows(
			windows,
			additional.metered_feature,
			additional.limit_name,
			additional.rate_limit
		)
	}
	return {
		accountId,
		hardLimitReached:
			body.rate_limit?.limit_reached === true ||
			body.rate_limit?.allowed === false ||
			body.rate_limit_reached_type != null ||
			(body.additional_rate_limits ?? []).some(
				additional =>
					additional.rate_limit?.limit_reached === true || additional.rate_limit?.allowed === false
			),
		observedAt: new Date().toISOString(),
		provider: 'openai',
		resetCredits:
			body.rate_limit_reset_credits == null
				? null
				: {
						applicable: body.rate_limit_reset_credits.applicable_available_count,
						available: body.rate_limit_reset_credits.available_count
					},
		source: 'codexUsageEndpoint',
		windows
	}
}

function codexBackendHeaders(credential: CodexAuth): Record<string, string> {
	return {
		Authorization: `Bearer ${credential.tokens.access_token}`,
		'ChatGPT-Account-Id': codexIdentity(credential).accountId,
		'User-Agent': 'codex-cli'
	}
}

function assertCodexBackendStatus(response: Response, what: string): void {
	if (response.status === 401) {
		throw new ApplicationError('ACCESS_TOKEN_REJECTED', `Codex ${what} rejected the access token`)
	}
	if (response.status === 429) {
		throw new ApplicationError('USAGE_RATE_LIMITED', `Codex ${what} rate-limited the request`)
	}
	if (!response.ok) {
		throw new ApplicationError(
			'PROVIDER_UNREACHABLE',
			`Codex ${what} returned HTTP ${response.status}`
		)
	}
}

async function fetchCodexUsage(input: {
	accountId: string
	credential: CodexAuth
	fetchImplementation?: FetchImplementation
}): Promise<UsageSnapshot> {
	const fetchImplementation = input.fetchImplementation ?? fetch
	const response = await fetchImplementation(usageEndpoint, {
		headers: codexBackendHeaders(input.credential),
		signal: AbortSignal.timeout(10_000)
	})
	assertCodexBackendStatus(response, 'usage endpoint')
	return normalizeResponse(input.accountId, UsageResponseSchema.parse(await response.json()))
}

const ResetCreditsResponseSchema = z
	.object({
		available_count: z.number().int().nonnegative(),
		credits: z.array(
			z
				.object({
					expires_at: z.string().nullish(),
					id: z.string().min(1),
					status: z.string(),
					title: z.string().nullish()
				})
				.passthrough()
		)
	})
	.passthrough()

const ConsumeResetResponseSchema = z
	.object({
		code: z.enum(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']),
		windows_reset: z.number().int().nonnegative().default(0)
	})
	.passthrough()

async function withCodexCredential<Result>(
	input: {
		account: Extract<Account, { provider: 'openai' }>
		vault: CredentialVault
		fetchImplementation?: FetchImplementation
	},
	operation: (credential: CodexAuth) => Promise<Result>
): Promise<Result> {
	const credential = await readCodexCredential(input.vault, input.account.secretReference)
	try {
		return await operation(credential)
	} catch (error) {
		if (!(error instanceof ApplicationError) || error.code !== 'ACCESS_TOKEN_REJECTED') {
			throw error
		}
		const refreshed = await refreshCodexCredential({
			fetchImplementation: input.fetchImplementation,
			reference: input.account.secretReference,
			vault: input.vault
		})
		return operation(refreshed)
	}
}

function isoOrNull(value: string | null | undefined): string | null {
	if (value == null) {
		return null
	}
	const millis = Date.parse(value)
	return Number.isFinite(millis) ? new Date(millis).toISOString() : null
}

export async function probeCodexResetCredits(input: {
	account: Extract<Account, { provider: 'openai' }>
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
}): Promise<ResetCreditsView> {
	return withCodexCredential(input, async credential => {
		const response = await (input.fetchImplementation ?? fetch)(resetCreditsEndpoint, {
			headers: codexBackendHeaders(credential),
			signal: AbortSignal.timeout(10_000)
		})
		assertCodexBackendStatus(response, 'reset credits endpoint')
		const body = ResetCreditsResponseSchema.parse(await response.json())
		const credits = body.credits
			.filter(credit => credit.status === 'available')
			.map(credit => ({
				expiresAt: isoOrNull(credit.expires_at),
				id: credit.id,
				title: credit.title ?? null
			}))
			.sort((left, right) => (left.expiresAt ?? '~').localeCompare(right.expiresAt ?? '~'))
		return { available: body.available_count, credits }
	})
}

export async function redeemCodexResetCredit(input: {
	account: Extract<Account, { provider: 'openai' }>
	vault: CredentialVault
	redeemRequestId: string
	fetchImplementation?: FetchImplementation
}): Promise<ResetOutcome> {
	return withCodexCredential(input, async credential => {
		const response = await (input.fetchImplementation ?? fetch)(consumeResetEndpoint, {
			body: JSON.stringify({ redeem_request_id: input.redeemRequestId }),
			headers: { ...codexBackendHeaders(credential), 'Content-Type': 'application/json' },
			method: 'POST',
			signal: AbortSignal.timeout(15_000)
		})
		assertCodexBackendStatus(response, 'reset consume endpoint')
		const body = ConsumeResetResponseSchema.parse(await response.json())
		return { code: body.code, windowsReset: body.windows_reset }
	})
}

export async function probeCodex(input: {
	account: Extract<Account, { provider: 'openai' }>
	vault: CredentialVault
	fetchImplementation: FetchImplementation
	now(): Date
}): Promise<ProviderProbeResult> {
	const { account, vault, fetchImplementation } = input
	let credential = await readCodexCredential(vault, account.secretReference)
	let identity = codexIdentity(credential)
	if (account.externalAccountId !== null && account.externalAccountId !== identity.accountId) {
		throw new ApplicationError(
			'IDENTITY_CHANGED',
			'Stored OpenAI credential belongs to a different account'
		)
	}
	if (account.externalUserId !== null && account.externalUserId !== identity.userId) {
		throw new ApplicationError(
			'IDENTITY_CHANGED',
			'Stored OpenAI credential belongs to a different user'
		)
	}
	const usage = await fetchCodexUsage({
		accountId: account.id,
		credential,
		fetchImplementation
	}).catch(async error => {
		if (!(error instanceof ApplicationError) || error.code !== 'ACCESS_TOKEN_REJECTED') {
			throw error
		}
		credential = await refreshCodexCredential({
			fetchImplementation,
			reference: account.secretReference,
			vault
		})
		identity = codexIdentity(credential)
		return fetchCodexUsage({ accountId: account.id, credential, fetchImplementation })
	})
	const email = AccountEmailSchema.safeParse(identity.email)
	return {
		account: {
			...account,
			externalAccountId: identity.accountId,
			externalUserId: identity.userId,
			health: 'ready',
			identity: email.success ? email.data : account.identity,
			label: email.success ? email.data : account.label,
			plan: identity.plan ?? account.plan ?? null,
			updatedAt: input.now().toISOString()
		},
		usage
	}
}
