import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { z } from 'zod'
import { type Account, AccountEmailSchema } from '../../domain.ts'
import { ApplicationError } from '../../errors.ts'
import type { FetchImplementation } from '../../http.ts'
import { type CredentialVault, exclusive } from '../../vault.ts'

const anthropicClientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const tokenEndpoint = 'https://console.anthropic.com/v1/oauth/token'
const profileEndpoint = 'https://api.anthropic.com/api/oauth/profile'

export const ClaudeOauthSchema = z
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

const ClaudeProfileSchema = z
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

export function claudePlanTier(credential: {
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

export interface ClaudeLoginDependencies {
	interactive(
		command: readonly string[],
		environment: Record<string, string | undefined>
	): Promise<number>
	captured(command: readonly string[]): Promise<{ exitCode: number; stdout: string }>
}

export function defaultClaudeLoginDependencies(): ClaudeLoginDependencies {
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
		interactive(command, environment) {
			return Bun.spawn([...command], {
				env: { ...process.env, ...environment },
				stderr: 'inherit',
				stdin: 'inherit',
				stdout: 'inherit'
			}).exited
		}
	}
}

function currentUser(): string {
	return process.env.USER ?? userInfo().username
}

function claudeKeychainService(profilePath: string): string {
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

async function importClaudeOauth(
	profilePath: string,
	dependencies: ClaudeLoginDependencies
): Promise<ClaudeOauth> {
	const keychain = await dependencies.captured([
		'security',
		'find-generic-password',
		'-a',
		currentUser(),
		'-s',
		claudeKeychainService(profilePath),
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
		claudeKeychainService(profilePath)
	])
	await rm(profilePath, { force: true, recursive: true })
}

export async function readClaudeCredential(
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
				client_id: anthropicClientId,
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

export async function fetchClaudeProfile(
	accessToken: string,
	fetchImplementation: FetchImplementation = fetch
): Promise<{ accountId: string; email: string | null }> {
	const response = await fetchImplementation(profileEndpoint, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'anthropic-beta': 'oauth-2025-04-20'
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
	const profile = ClaudeProfileSchema.parse(await response.json())
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
		const exitCode = await dependencies.interactive(['claude', 'auth', 'login', '--claudeai'], {
			CLAUDE_CONFIG_DIR: profilePath
		})
		if (exitCode !== 0) {
			throw new ApplicationError('LOGIN_FAILED', `claude auth login exited with ${exitCode}`)
		}
		const credential = await importClaudeOauth(profilePath, dependencies)
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
	const credential = await importClaudeOauth(account.profilePath, dependencies)
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
