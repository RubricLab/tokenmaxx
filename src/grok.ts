import { join } from 'node:path'
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
import { defaultIsolatedLoginDependencies, type IsolatedLoginDependencies } from './login.ts'
import { type UpstreamInjection, upstreamFor } from './proxy.ts'
import { xaiLimitWindow, xaiLimitWindowId } from './ratelimit.ts'
import { type CredentialVault, exclusive, readApiKey } from './vault.ts'

const tokenEndpoint = 'https://auth.x.ai/oauth2/token'
const userinfoEndpoint = 'https://auth.x.ai/oauth2/userinfo'
const xaiApiBase = 'https://api.x.ai'
const sessionAuthHeaders = { 'x-xai-token-auth': 'xai-grok-cli' }
const refreshMarginMilliseconds = 120_000

const GrokAuthSchema = z
	.object({
		email: z.string().min(1),
		expires_at: z.iso.datetime(),
		key: z.string().min(1),
		oidc_client_id: z.string().min(1),
		refresh_token: z.string().min(1),
		user_id: z.string().min(1)
	})
	.passthrough()
export type GrokAuth = z.infer<typeof GrokAuthSchema>

const GrokAuthFileSchema = z.record(z.string(), z.unknown())

const TokenResponseSchema = z
	.object({
		access_token: z.string().min(1),
		expires_in: z.number().positive(),
		refresh_token: z.string().min(1).optional()
	})
	.passthrough()

const UserinfoSchema = z.object({ email: z.string().optional() }).passthrough()

function grokAuthFromFile(serialized: string): GrokAuth {
	const entries = Object.values(GrokAuthFileSchema.parse(JSON.parse(serialized)))
	for (const entry of entries) {
		const parsed = GrokAuthSchema.safeParse(entry)
		if (parsed.success) {
			return parsed.data
		}
	}
	throw new ApplicationError(
		'CREDENTIAL_MISSING',
		'grok login left no usable credential in auth.json'
	)
}

export async function registerGrokAccount(input: {
	vault: CredentialVault
	dependencies?: IsolatedLoginDependencies
}): Promise<Account> {
	const dependencies = input.dependencies ?? defaultIsolatedLoginDependencies()
	const temporaryHome = await dependencies.createTemporaryDirectory('tokenmaxx-grok-')
	try {
		const login = await dependencies.run(['grok', 'login'], { GROK_HOME: temporaryHome })
		if (login.exitCode !== 0) {
			throw new ApplicationError('LOGIN_FAILED', loginFailureMessage('grok login', login))
		}
		const auth = grokAuthFromFile(await dependencies.read(join(temporaryHome, 'auth.json')))
		const email = AccountEmailSchema.safeParse(auth.email)
		if (!email.success) {
			throw new ApplicationError(
				'ACCOUNT_EMAIL_MISSING',
				'Grok did not return a verified account email; the login was not stored'
			)
		}
		const id = crypto.randomUUID()
		const secretReference = `grok:${id}`
		await input.vault.write(secretReference, JSON.stringify(auth))
		const now = new Date().toISOString()
		return {
			auth: 'oauth',
			createdAt: now,
			enabled: true,
			externalAccountId: auth.user_id,
			externalUserId: null,
			health: 'ready',
			id,
			identity: email.data,
			label: email.data,
			onThreshold: 'switch',
			plan: null,
			profilePath: null,
			provider: 'xai',
			secretReference,
			updatedAt: now
		}
	} finally {
		await dependencies.remove(temporaryHome)
	}
}

async function readGrokCredential(vault: CredentialVault, reference: string): Promise<GrokAuth> {
	const serialized = await vault.read(reference)
	if (serialized === null) {
		throw new ApplicationError('CREDENTIAL_MISSING', `Missing credential ${reference}`)
	}
	return GrokAuthSchema.parse(JSON.parse(serialized))
}

export async function refreshGrokCredential(input: {
	reference: string
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
	staleKey?: string
}): Promise<GrokAuth> {
	return exclusive(input.reference, async () => {
		const current = await readGrokCredential(input.vault, input.reference)
		if (input.staleKey !== undefined && current.key !== input.staleKey) {
			return current
		}
		const response = await (input.fetchImplementation ?? fetch)(tokenEndpoint, {
			body: new URLSearchParams({
				client_id: current.oidc_client_id,
				grant_type: 'refresh_token',
				refresh_token: current.refresh_token
			}),
			method: 'POST',
			signal: AbortSignal.timeout(7_000)
		})
		if (response.status === 400 || response.status === 401) {
			throw new ApplicationError('REAUTHENTICATION_REQUIRED', 'Grok refresh token was rejected')
		}
		if (!response.ok) {
			throw new ApplicationError(
				'PROVIDER_UNREACHABLE',
				`Grok token refresh returned HTTP ${response.status}`
			)
		}
		const refreshed = TokenResponseSchema.parse(await response.json())
		const updated = GrokAuthSchema.parse({
			...current,
			expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
			key: refreshed.access_token,
			refresh_token: refreshed.refresh_token ?? current.refresh_token
		})
		await input.vault.write(input.reference, JSON.stringify(updated))
		return updated
	})
}

async function validateXaiApiKey(
	key: string,
	fetchImplementation: FetchImplementation
): Promise<void> {
	const response = await fetchImplementation(`${xaiApiBase}/v1/models`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(10_000)
	})
	if (response.status === 401 || response.status === 403) {
		throw new ApplicationError('ACCESS_TOKEN_REJECTED', 'xAI rejected this API key')
	}
	if (!response.ok && response.status !== 429) {
		throw new ApplicationError('PROVIDER_UNREACHABLE', `xAI API returned HTTP ${response.status}`)
	}
}

export async function registerXaiApiKeyAccount(input: {
	vault: CredentialVault
	key: string
	label: string
	fetchImplementation?: FetchImplementation
}): Promise<Account> {
	const key = input.key.trim()
	if (key.length === 0) {
		throw new ApplicationError('USAGE', 'The API key is empty')
	}
	await validateXaiApiKey(key, input.fetchImplementation ?? fetch)
	const id = crypto.randomUUID()
	const secretReference = `grok-key:${id}`
	await input.vault.write(secretReference, key)
	const now = new Date().toISOString()
	return {
		auth: 'apiKey',
		createdAt: now,
		enabled: true,
		externalAccountId: null,
		externalUserId: null,
		health: 'ready',
		id,
		identity: input.label,
		label: input.label,
		onThreshold: 'switch',
		plan: null,
		profilePath: null,
		provider: 'xai',
		secretReference,
		updatedAt: now
	}
}

export async function grokUpstream(input: {
	account: Extract<Account, { provider: 'xai' }>
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
	now?: () => number
	forceRefresh: boolean
}): Promise<UpstreamInjection> {
	const reference = input.account.secretReference
	if (input.account.auth === 'apiKey') {
		return {
			accountId: input.account.id,
			baseUrl: xaiApiBase,
			headers: { authorization: `Bearer ${await readApiKey(input.vault, reference)}` },
			stripHeaders: ['x-xai-token-auth']
		}
	}
	let auth = await readGrokCredential(input.vault, reference)
	const now = input.now ?? (() => Date.now())
	const stale = Date.parse(auth.expires_at) - now() <= refreshMarginMilliseconds
	if (input.forceRefresh || stale) {
		auth = await refreshGrokCredential({
			fetchImplementation: input.fetchImplementation,
			reference,
			vault: input.vault
		})
	}
	return {
		accountId: input.account.id,
		baseUrl: upstreamFor('xai'),
		headers: { authorization: `Bearer ${auth.key}`, ...sessionAuthHeaders }
	}
}

async function fetchGrokEmail(
	key: string,
	fetchImplementation: FetchImplementation
): Promise<string | null> {
	const response = await fetchImplementation(userinfoEndpoint, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(7_000)
	})
	if (response.status === 401) {
		throw new ApplicationError('REAUTHENTICATION_REQUIRED', 'Grok credential was rejected')
	}
	if (!response.ok) {
		throw new ApplicationError(
			'PROVIDER_UNREACHABLE',
			`Grok userinfo endpoint returned HTTP ${response.status}`
		)
	}
	return UserinfoSchema.parse(await response.json()).email ?? null
}

const verifiedIdentities = new Map<string, { key: string; email: string | null }>()

function heldLimit(existing: UsageSnapshot | null, now: Date): UsageWindow | null {
	const held = existing?.windows.find(window => window.id === xaiLimitWindowId)
	return held !== undefined && held.resetAt !== null && Date.parse(held.resetAt) > now.getTime()
		? held
		: null
}

export async function probeGrok(input: {
	account: Extract<Account, { provider: 'xai' }>
	vault: CredentialVault
	fetchImplementation: FetchImplementation
	now(): Date
	existing: UsageSnapshot | null
}): Promise<ProviderProbeResult> {
	const { account, vault, fetchImplementation } = input
	const reference = account.secretReference
	if (account.auth === 'apiKey') {
		await validateXaiApiKey(await readApiKey(vault, reference), fetchImplementation)
		return {
			account: { ...account, health: 'ready', updatedAt: input.now().toISOString() },
			usage: {
				accountId: account.id,
				extraUsage: null,
				hardLimitReached: false,
				measuredSpendUsd: null,
				observedAt: input.now().toISOString(),
				provider: 'xai',
				resetCredits: null,
				source: 'apiKeyProbe',
				windows: []
			}
		}
	}
	const refresh = (staleKey: string) =>
		refreshGrokCredential({ fetchImplementation, reference, staleKey, vault })
	let credential = await readGrokCredential(vault, reference)
	if (Date.parse(credential.expires_at) <= input.now().getTime() + 300_000) {
		credential = await refresh(credential.key)
	}
	const verifyIdentity = async (): Promise<string | null> => {
		const cached = verifiedIdentities.get(reference)
		if (cached !== undefined && cached.key === credential.key) {
			return cached.email
		}
		const email = await fetchGrokEmail(credential.key, fetchImplementation)
		verifiedIdentities.set(reference, { email, key: credential.key })
		return email
	}
	const email = await verifyIdentity().catch(async error => {
		if (!(error instanceof ApplicationError) || error.code !== 'REAUTHENTICATION_REQUIRED') {
			throw error
		}
		credential = await refresh(credential.key)
		return verifyIdentity()
	})
	const verified = AccountEmailSchema.safeParse(email)
	if (verified.success && verified.data !== account.identity) {
		throw new ApplicationError(
			'IDENTITY_CHANGED',
			'Stored Grok credential belongs to a different account'
		)
	}
	const held = heldLimit(input.existing, input.now())
	return {
		account: { ...account, health: 'ready', updatedAt: input.now().toISOString() },
		usage: {
			accountId: account.id,
			extraUsage: null,
			hardLimitReached: held !== null,
			measuredSpendUsd: null,
			observedAt: input.now().toISOString(),
			provider: 'xai',
			resetCredits: null,
			source: 'grokProbe',
			windows: [held ?? xaiLimitWindow(0, null)]
		}
	}
}
