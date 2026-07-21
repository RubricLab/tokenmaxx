import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { z } from 'zod'
import {
	type Account,
	AccountEmailSchema,
	type FetchImplementation,
	type ProviderProbeResult,
	type UsageSnapshot,
	type UsageWindow
} from './domain.ts'
import { ApplicationError, loginFailureMessage } from './errors.ts'
import { type UpstreamInjection, upstreamFor } from './proxy.ts'
import { type CredentialVault, exclusive } from './vault.ts'

const clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const tokenEndpoint = 'https://console.anthropic.com/v1/oauth/token'
const profileEndpoint = 'https://api.anthropic.com/api/oauth/profile'
const usageEndpoint = 'https://api.anthropic.com/api/oauth/usage'
const oauthBeta = 'oauth-2025-04-20'

const ClaudeOauthSchema = z
	.object({
		accessToken: z.string().min(1),
		expiresAt: z.number().nonnegative(),
		rateLimitTier: z.string().optional(),
		refreshToken: z.string().min(1),
		refreshTokenExpiresAt: z.number().nonnegative().optional(),
		scopes: z.union([z.array(z.string()), z.string()]).optional(),
		subscriptionType: z.string().optional()
	})
	.passthrough()
export type ClaudeOauth = z.infer<typeof ClaudeOauthSchema>

const CliCredentialSchema = z.object({ claudeAiOauth: ClaudeOauthSchema }).passthrough()

const TokenResponseSchema = z
	.object({
		access_token: z.string().min(1),
		expires_in: z.number().positive(),
		refresh_token: z.string().min(1).optional(),
		scope: z.string().optional()
	})
	.passthrough()

const ProfileSchema = z
	.object({
		account: z
			.object({
				email_address: z.string().email().optional(),
				uuid: z.string().min(1)
			})
			.passthrough()
			.optional(),
		email_address: z.string().email().optional(),
		uuid: z.string().min(1).optional()
	})
	.passthrough()

function claudePlanTier(credential: {
	subscriptionType?: string
	rateLimitTier?: string
}): string | null {
	const tier = credential.rateLimitTier?.trim()
	if (tier !== undefined && tier.length > 0 && /\d+x|max|pro|team|enterprise/i.test(tier)) {
		return tier
	}
	const subscription = credential.subscriptionType?.trim()
	return subscription !== undefined && subscription.length > 0 ? subscription : null
}

interface ClaudeLoginDependencies {
	interactive(
		command: readonly string[],
		environment: Record<string, string | undefined>
	): Promise<{ exitCode: number; stderr: string }>
	captured(command: readonly string[]): Promise<{ exitCode: number; stdout: string }>
}

function defaultClaudeLoginDependencies(): ClaudeLoginDependencies {
	return {
		async captured(command) {
			const processHandle = Bun.spawn([...command], {
				stderr: 'ignore',
				stdin: 'ignore',
				stdout: 'pipe'
			})
			const timeout = setTimeout(() => processHandle.kill('SIGTERM'), 30_000)
			const [exitCode, stdout] = await Promise.all([
				processHandle.exited,
				new Response(processHandle.stdout).text()
			])
			clearTimeout(timeout)
			return { exitCode, stdout }
		},
		async interactive(command, environment) {
			const child = Bun.spawn([...command], {
				env: { ...process.env, ...environment },
				stderr: 'pipe',
				stdin: 'inherit',
				stdout: 'inherit'
			})
			const decoder = new TextDecoder()
			let stderr = ''
			for await (const chunk of child.stderr) {
				process.stderr.write(chunk)
				stderr = `${stderr}${decoder.decode(chunk, { stream: true })}`.slice(-4_096)
			}
			return { exitCode: await child.exited, stderr }
		}
	}
}

function currentUser(): string {
	return process.env.USER ?? userInfo().username
}

function cliKeychainService(profilePath: string): string {
	const canonical = normalize(resolve(profilePath)).normalize('NFC')
	const digest = new Bun.CryptoHasher('sha256').update(canonical).digest('hex')
	return `Claude Code-credentials-${digest.slice(0, 8)}`
}

function decodeSecurityOutput(output: string): string {
	const trimmed = output.replace(/\n$/, '')
	if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
		const decoded = Buffer.from(trimmed, 'hex').toString('utf8')
		if (decoded.trimStart().startsWith('{')) {
			return decoded
		}
	}
	return trimmed
}

async function importCliCredential(
	profilePath: string,
	dependencies: ClaudeLoginDependencies
): Promise<ClaudeOauth> {
	const keychain = await dependencies.captured([
		'security',
		'find-generic-password',
		'-a',
		currentUser(),
		'-s',
		cliKeychainService(profilePath),
		'-w'
	])
	const serialized =
		keychain.exitCode === 0
			? decodeSecurityOutput(keychain.stdout)
			: await readFile(join(profilePath, '.credentials.json'), 'utf8').catch(() => null)
	if (serialized === null) {
		throw new ApplicationError(
			'CREDENTIAL_MISSING',
			`Claude profile ${profilePath} has no credential`
		)
	}
	const parsed = CliCredentialSchema.safeParse(
		(() => {
			try {
				return JSON.parse(serialized)
			} catch {
				return null
			}
		})()
	)
	if (!parsed.success) {
		throw new ApplicationError(
			'CREDENTIAL_MISSING',
			`Claude profile ${profilePath} holds an unusable credential; sign in again`
		)
	}
	return parsed.data.claudeAiOauth
}

export async function removeClaudeProfile(
	profilePath: string,
	dependencies: ClaudeLoginDependencies = defaultClaudeLoginDependencies()
): Promise<void> {
	await dependencies.captured([
		'security',
		'delete-generic-password',
		'-a',
		currentUser(),
		'-s',
		cliKeychainService(profilePath)
	])
	await rm(profilePath, { force: true, recursive: true })
}

async function readClaudeCredential(
	vault: CredentialVault,
	reference: string
): Promise<ClaudeOauth> {
	const serialized = await vault.read(reference)
	if (serialized === null) {
		throw new ApplicationError('CREDENTIAL_MISSING', `Missing credential ${reference}`)
	}
	return ClaudeOauthSchema.parse(JSON.parse(serialized))
}

export async function refreshClaudeCredential(input: {
	reference: string
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
	staleAccessToken?: string
}): Promise<ClaudeOauth> {
	return exclusive(input.reference, async () => {
		const current = await readClaudeCredential(input.vault, input.reference)
		if (input.staleAccessToken !== undefined && current.accessToken !== input.staleAccessToken) {
			return current
		}
		const response = await (input.fetchImplementation ?? fetch)(tokenEndpoint, {
			body: JSON.stringify({
				client_id: clientId,
				grant_type: 'refresh_token',
				refresh_token: current.refreshToken
			}),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST',
			signal: AbortSignal.timeout(7_000)
		})
		if (response.status === 400 || response.status === 401) {
			throw new ApplicationError('REAUTHENTICATION_REQUIRED', 'Claude refresh token was rejected')
		}
		if (!response.ok) {
			throw new ApplicationError(
				'PROVIDER_UNREACHABLE',
				`Claude token refresh returned HTTP ${response.status}`
			)
		}
		const refreshed = TokenResponseSchema.parse(await response.json())
		const updated = ClaudeOauthSchema.parse({
			...current,
			accessToken: refreshed.access_token,
			expiresAt: Date.now() + refreshed.expires_in * 1000,
			refreshToken: refreshed.refresh_token ?? current.refreshToken,
			scopes: refreshed.scope === undefined ? current.scopes : refreshed.scope.split(' ')
		})
		await input.vault.write(input.reference, JSON.stringify(updated))
		return updated
	})
}

async function fetchClaudeProfile(
	accessToken: string,
	fetchImplementation: FetchImplementation = fetch
): Promise<{ accountId: string; email: string | null }> {
	const response = await fetchImplementation(profileEndpoint, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'anthropic-beta': oauthBeta
		},
		signal: AbortSignal.timeout(7_000)
	})
	if (response.status === 401) {
		throw new ApplicationError('REAUTHENTICATION_REQUIRED', 'Claude credential was rejected')
	}
	if (!response.ok) {
		throw new ApplicationError(
			'PROVIDER_UNREACHABLE',
			`Claude profile endpoint returned HTTP ${response.status}`
		)
	}
	const profile = ProfileSchema.parse(await response.json())
	const accountId = profile.account?.uuid ?? profile.uuid
	if (accountId === undefined) {
		throw new ApplicationError('ACCOUNT_ID_MISSING', 'Claude profile response has no account id')
	}
	return {
		accountId,
		email: profile.account?.email_address ?? profile.email_address ?? null
	}
}

export async function registerClaudeAccount(input: {
	vault: CredentialVault
	dependencies?: ClaudeLoginDependencies
	fetchImplementation?: FetchImplementation
}): Promise<Account> {
	const dependencies = input.dependencies ?? defaultClaudeLoginDependencies()
	const profilePath = await mkdtemp(join(tmpdir(), 'tokenmaxx-claude-'))
	try {
		const login = await dependencies.interactive(['claude', 'auth', 'login', '--claudeai'], {
			CLAUDE_CONFIG_DIR: profilePath
		})
		if (login.exitCode !== 0) {
			throw new ApplicationError('LOGIN_FAILED', loginFailureMessage('claude auth login', login))
		}
		const credential = await importCliCredential(profilePath, dependencies)
		const profile = await fetchClaudeProfile(
			credential.accessToken,
			input.fetchImplementation ?? fetch
		)
		const email = AccountEmailSchema.safeParse(profile.email)
		if (!email.success) {
			throw new ApplicationError(
				'ACCOUNT_EMAIL_MISSING',
				'Claude did not return a verified account email; the login was not stored'
			)
		}
		const id = crypto.randomUUID()
		const secretReference = `claude:${id}`
		await input.vault.write(secretReference, JSON.stringify(credential))
		const now = new Date().toISOString()
		return {
			createdAt: now,
			enabled: true,
			externalAccountId: profile.accountId,
			externalUserId: null,
			health: 'ready',
			id,
			identity: email.data,
			label: email.data,
			plan: claudePlanTier(credential),
			profilePath: null,
			provider: 'anthropic',
			secretReference,
			updatedAt: now
		}
	} finally {
		await removeClaudeProfile(profilePath, dependencies).catch(() => undefined)
	}
}

export async function migrateClaudeAccount(input: {
	account: Extract<Account, { provider: 'anthropic' }>
	vault: CredentialVault
	dependencies?: ClaudeLoginDependencies
}): Promise<Account> {
	const { account } = input
	if (account.secretReference !== null || account.profilePath === null) {
		return account
	}
	const dependencies = input.dependencies ?? defaultClaudeLoginDependencies()
	const credential = await importCliCredential(account.profilePath, dependencies)
	const secretReference = `claude:${account.id}`
	await input.vault.write(secretReference, JSON.stringify(credential))
	await removeClaudeProfile(account.profilePath, dependencies).catch(() => undefined)
	return {
		...account,
		profilePath: null,
		secretReference,
		updatedAt: new Date().toISOString()
	}
}

const refreshMarginMilliseconds = 120_000

export async function claudeUpstream(input: {
	account: Extract<Account, { provider: 'anthropic' }>
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
	now?: () => number
	forceRefresh: boolean
}): Promise<UpstreamInjection> {
	const reference = input.account.secretReference
	if (reference === null) {
		throw new ApplicationError(
			'CREDENTIAL_MISSING',
			`${input.account.label} has no stored credential`
		)
	}
	let credential = await readClaudeCredential(input.vault, reference)
	const now = input.now ?? (() => Date.now())
	const stale = credential.expiresAt - now() <= refreshMarginMilliseconds
	if (input.forceRefresh || stale) {
		credential = await refreshClaudeCredential({
			fetchImplementation: input.fetchImplementation,
			reference,
			staleAccessToken: credential.accessToken,
			vault: input.vault
		})
	}
	return {
		accountId: input.account.id,
		appendHeaders: { 'anthropic-beta': oauthBeta },
		baseUrl: upstreamFor('anthropic'),
		headers: { authorization: `Bearer ${credential.accessToken}` },
		stripHeaders: ['x-api-key']
	}
}

const UsageWindowResponseSchema = z
	.object({
		limit_dollars: z.number().nonnegative().nullish(),
		remaining_dollars: z.number().nonnegative().nullish(),
		resets_at: z.union([z.string(), z.number()]).nullish(),
		used_dollars: z.number().nonnegative().nullish(),
		utilization: z.number().min(0)
	})
	.passthrough()

const LimitScopeSchema = z
	.object({
		model: z
			.object({ display_name: z.string().nullish(), id: z.string().nullish() })
			.passthrough()
			.nullish(),
		surface: z
			.union([
				z.string(),
				z.object({ display_name: z.string().nullish(), id: z.string().nullish() }).passthrough()
			])
			.nullish()
	})
	.passthrough()

const LimitSchema = z
	.object({
		group: z.string().nullish(),
		is_active: z.boolean().nullish(),
		kind: z.string().min(1),
		percent: z.number().min(0),
		resets_at: z.union([z.string(), z.number()]).nullish(),
		scope: LimitScopeSchema.nullish(),
		severity: z.string().nullish()
	})
	.passthrough()

const UsageResponseSchema = z
	.object({
		five_hour: UsageWindowResponseSchema.nullish(),
		limits: z.array(LimitSchema).nullish(),
		seven_day: UsageWindowResponseSchema.nullish(),
		seven_day_oauth_apps: UsageWindowResponseSchema.nullish(),
		seven_day_opus: UsageWindowResponseSchema.nullish(),
		seven_day_sonnet: UsageWindowResponseSchema.nullish()
	})
	.passthrough()

function resetTimestamp(value: string | number | null | undefined): string | null {
	if (value == null) {
		return null
	}
	const timestamp =
		typeof value === 'number' ? (value > 1_000_000_000_000 ? value : value * 1000) : Date.parse(value)
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function normalizePercent(utilization: number): number {
	const percent = utilization <= 1 ? utilization * 100 : utilization
	return Math.min(100, percent)
}

function titleCase(identifier: string): string {
	return identifier
		.split('_')
		.filter(part => part.length > 0)
		.map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
		.join(' ')
}

function normalizeWindow(
	id: string,
	label: string,
	source: z.infer<typeof UsageWindowResponseSchema>
): UsageWindow {
	return {
		id,
		kind:
			id.includes('oauth_apps') || id.includes('extra_usage') || source.limit_dollars != null
				? 'spend'
				: 'hard',
		label,
		resetAt: resetTimestamp(source.resets_at),
		usedPercent: normalizePercent(source.utilization)
	}
}

function limitScopeName(limit: z.infer<typeof LimitSchema>): string | null {
	const surface = limit.scope?.surface
	const surfaceName = typeof surface === 'string' ? surface : surface?.display_name
	return limit.scope?.model?.display_name ?? surfaceName ?? limit.scope?.model?.id ?? null
}

function limitWindow(limit: z.infer<typeof LimitSchema>): UsageWindow {
	const scopeName = limitScopeName(limit)
	const labels: Record<string, string> = {
		session: '5h session',
		weekly_all: '7 day · all models',
		weekly_scoped: `7 day · ${scopeName ?? 'scoped'}`
	}
	const fallbackLabel = titleCase(limit.kind)
	return {
		id: scopeName === null ? limit.kind : `${limit.kind}:${scopeName.toLowerCase()}`,
		kind: 'hard',
		label:
			labels[limit.kind] ?? (scopeName === null ? fallbackLabel : `${fallbackLabel} · ${scopeName}`),
		resetAt: resetTimestamp(limit.resets_at),
		usedPercent: Math.min(100, limit.percent)
	}
}

const exhaustedSeverities = new Set(['exceeded', 'blocked', 'at_limit'])

async function fetchClaudeUsage(input: {
	accountId: string
	accessToken: string
	fetchImplementation?: FetchImplementation
}): Promise<UsageSnapshot> {
	const response = await (input.fetchImplementation ?? fetch)(usageEndpoint, {
		headers: {
			Authorization: `Bearer ${input.accessToken}`,
			'anthropic-beta': oauthBeta,
			'Content-Type': 'application/json'
		},
		signal: AbortSignal.timeout(10_000)
	})
	if (response.status === 401) {
		throw new ApplicationError(
			'ACCESS_TOKEN_REJECTED',
			'Claude usage endpoint rejected the access token'
		)
	}
	if (response.status === 429) {
		throw new ApplicationError('USAGE_RATE_LIMITED', 'Claude usage endpoint rate-limited the probe')
	}
	if (!response.ok) {
		throw new ApplicationError(
			'PROVIDER_UNREACHABLE',
			`Claude usage endpoint returned HTTP ${response.status}`
		)
	}
	const body = UsageResponseSchema.parse(await response.json())
	const limits = body.limits ?? []
	const windows: UsageWindow[] = limits.map(limitWindow)
	const coveredIds = new Set(windows.map(window => window.id))
	const definitions = [
		['five_hour', '5 hour', 'session', body.five_hour],
		['seven_day', '7 day', 'weekly_all', body.seven_day],
		['seven_day_opus', '7 day · Opus', null, body.seven_day_opus],
		['seven_day_sonnet', '7 day · Sonnet', null, body.seven_day_sonnet],
		['seven_day_oauth_apps', '7 day · OAuth apps', null, body.seven_day_oauth_apps]
	] as const
	for (const [id, label, limitEquivalent, window] of definitions) {
		if (window == null || (limitEquivalent !== null && coveredIds.has(limitEquivalent))) {
			continue
		}
		windows.push(normalizeWindow(id, label, window))
	}
	const knownWindowIds = new Set<string>([...definitions.map(([id]) => id), 'limits'])
	for (const [id, value] of Object.entries(body)) {
		if (knownWindowIds.has(id)) {
			continue
		}
		const additional = UsageWindowResponseSchema.safeParse(value)
		if (additional.success) {
			windows.push(normalizeWindow(id, titleCase(id), additional.data))
		}
	}
	return {
		accountId: input.accountId,
		hardLimitReached:
			windows.some(window => window.kind === 'hard' && window.usedPercent >= 100) ||
			limits.some(
				limit => limit.severity != null && exhaustedSeverities.has(limit.severity.toLowerCase())
			),
		observedAt: new Date().toISOString(),
		provider: 'anthropic',
		source: 'claudeUsageEndpoint',
		windows
	}
}

function scopesPermitUsage(scopes: string | string[] | undefined): boolean {
	if (scopes === undefined) {
		return true
	}
	const values = Array.isArray(scopes) ? scopes : scopes.split(/[ ,]+/)
	return values.includes('user:profile')
}

function refreshTokenHealth(
	refreshTokenExpiresAt: number | undefined,
	now: Date
): Account['health'] {
	if (refreshTokenExpiresAt === undefined) {
		return 'ready'
	}
	if (refreshTokenExpiresAt <= now.getTime()) {
		return 'reauthenticationRequired'
	}
	return refreshTokenExpiresAt <= now.getTime() + 5 * 24 * 60 * 60 * 1000 ? 'loginExpiring' : 'ready'
}

function assertIdentity(
	account: Extract<Account, { provider: 'anthropic' }>,
	accountId: string
): void {
	if (account.externalAccountId !== null && account.externalAccountId !== accountId) {
		throw new ApplicationError(
			'IDENTITY_CHANGED',
			'Stored Claude credential belongs to a different account'
		)
	}
}

const verifiedIdentities = new Map<
	string,
	{ accessToken: string; accountId: string; email: string | null }
>()

export async function probeClaude(input: {
	account: Extract<Account, { provider: 'anthropic' }>
	vault: CredentialVault
	fetchImplementation: FetchImplementation
	now(): Date
}): Promise<ProviderProbeResult> {
	const { account, vault, fetchImplementation } = input
	const reference = account.secretReference
	if (reference === null) {
		throw new ApplicationError('CREDENTIAL_MISSING', `${account.label} has no stored credential`)
	}
	const refresh = (staleAccessToken: string) =>
		refreshClaudeCredential({
			fetchImplementation,
			reference,
			staleAccessToken,
			vault
		})
	let credential = await readClaudeCredential(vault, reference)
	if (credential.expiresAt <= input.now().getTime() + 300_000) {
		credential = await refresh(credential.accessToken)
	}
	if (!scopesPermitUsage(credential.scopes)) {
		throw new ApplicationError(
			'SCOPE_MISSING',
			'Claude credential does not include the user:profile scope required for usage'
		)
	}
	const verifyIdentity = async (): Promise<{ accountId: string; email: string | null }> => {
		const cached = verifiedIdentities.get(reference)
		if (cached !== undefined && cached.accessToken === credential.accessToken) {
			return { accountId: cached.accountId, email: cached.email }
		}
		const fetched = await fetchClaudeProfile(credential.accessToken, fetchImplementation)
		verifiedIdentities.set(reference, { accessToken: credential.accessToken, ...fetched })
		return fetched
	}
	let profile = await verifyIdentity().catch(async error => {
		if (!(error instanceof ApplicationError) || error.code !== 'REAUTHENTICATION_REQUIRED') {
			throw error
		}
		credential = await refresh(credential.accessToken)
		return verifyIdentity()
	})
	assertIdentity(account, profile.accountId)
	const usage = await fetchClaudeUsage({
		accessToken: credential.accessToken,
		accountId: account.id,
		fetchImplementation
	}).catch(async error => {
		if (!(error instanceof ApplicationError) || error.code !== 'ACCESS_TOKEN_REJECTED') {
			throw error
		}
		credential = await refresh(credential.accessToken)
		profile = await verifyIdentity()
		return fetchClaudeUsage({
			accessToken: credential.accessToken,
			accountId: account.id,
			fetchImplementation
		})
	})
	assertIdentity(account, profile.accountId)
	const email = AccountEmailSchema.safeParse(profile.email)
	return {
		account: {
			...account,
			health: refreshTokenHealth(credential.refreshTokenExpiresAt, input.now()),
			identity: email.success ? email.data : account.identity,
			label: email.success ? email.data : account.label,
			plan: claudePlanTier(credential) ?? account.plan ?? null,
			updatedAt: input.now().toISOString()
		},
		usage
	}
}
