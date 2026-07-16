import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { z } from 'zod'
import { type Account, AccountEmailSchema } from '../../domain.ts'
import { ApplicationError } from '../../errors.ts'
import type { FetchImplementation } from '../../http.ts'
import type { ApplicationPaths } from '../../paths.ts'

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

export const ClaudeCredentialPayloadSchema = z
	.object({ claudeAiOauth: ClaudeOauthSchema })
	.passthrough()

const ClaudeAuthStatusSchema = z
	.object({
		authMethod: z.string().optional(),
		email: z.string().email().optional(),
		loggedIn: z.boolean(),
		subscriptionType: z.string().optional()
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

export interface ClaudeCommandRunner {
	interactive(
		command: readonly string[],
		environment: Record<string, string | undefined>
	): Promise<number>
	captured(
		command: readonly string[],
		environment: Record<string, string | undefined>
	): Promise<{
		exitCode: number
		stdout: string
		stderr: string
	}>
}

export interface ClaudeProfileCredentialReader {
	read(profilePath: string): Promise<ClaudeOauth>
}

function currentUser(): string {
	return process.env.USER ?? userInfo().username
}

export function canonicalClaudeProfilePath(profilePath: string): string {
	return normalize(resolve(profilePath)).normalize('NFC')
}

export function claudeKeychainService(profilePath: string): string {
	const canonical = canonicalClaudeProfilePath(profilePath)
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

export function defaultClaudeCommandRunner(): ClaudeCommandRunner {
	return {
		async captured(command, environment) {
			const processHandle = Bun.spawn([...command], {
				env: { ...process.env, ...environment },
				stderr: 'pipe',
				stdin: 'ignore',
				stdout: 'pipe'
			})
			const timeout = setTimeout(() => processHandle.kill('SIGTERM'), 30_000)
			const [exitCode, stdout, stderr] = await Promise.all([
				processHandle.exited,
				new Response(processHandle.stdout).text(),
				new Response(processHandle.stderr).text()
			])
			clearTimeout(timeout)
			return { exitCode, stderr, stdout }
		},
		async interactive(command, environment) {
			return Bun.spawn([...command], {
				env: { ...process.env, ...environment },
				stderr: 'inherit',
				stdin: 'inherit',
				stdout: 'inherit'
			}).exited
		}
	}
}

export function defaultClaudeCredentialReader(
	runner: ClaudeCommandRunner = defaultClaudeCommandRunner()
): ClaudeProfileCredentialReader {
	return {
		async read(profilePath) {
			const service = claudeKeychainService(profilePath)
			const result = await runner.captured(
				['security', 'find-generic-password', '-a', currentUser(), '-s', service, '-w'],
				{}
			)
			let serialized: string
			if (result.exitCode === 0) {
				serialized = decodeSecurityOutput(result.stdout)
			} else {
				try {
					const fallbackPath = join(profilePath, '.credentials.json')
					const metadata = await stat(fallbackPath)
					if ((metadata.mode & 0o077) !== 0) {
						throw new ApplicationError(
							'INSECURE_CREDENTIAL_FILE',
							`Claude fallback credential ${fallbackPath} must be mode 0600`
						)
					}
					serialized = await readFile(fallbackPath, 'utf8')
				} catch (error) {
					if (error instanceof ApplicationError) {
						throw error
					}
					throw new ApplicationError(
						'CREDENTIAL_MISSING',
						`Claude profile ${profilePath} has no credential`,
						{
							cause: error
						}
					)
				}
			}
			let decoded: unknown
			try {
				decoded = JSON.parse(serialized)
			} catch (error) {
				throw new ApplicationError(
					'CREDENTIAL_MISSING',
					`Claude profile ${profilePath} holds an unreadable credential`,
					{ cause: error instanceof Error ? error : undefined }
				)
			}
			const parsed = ClaudeCredentialPayloadSchema.safeParse(decoded)
			if (!parsed.success) {
				throw new ApplicationError(
					'CREDENTIAL_MISSING',
					`Claude profile ${profilePath} holds an unusable credential; sign in again`
				)
			}
			return parsed.data.claudeAiOauth
		}
	}
}

export async function fetchClaudeProfile(
	accessToken: string,
	fetchImplementation: FetchImplementation = fetch
): Promise<{ accountId: string; email: string | null }> {
	const response = await fetchImplementation('https://api.anthropic.com/api/oauth/profile', {
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
	email?: string
	paths: ApplicationPaths
	runner?: ClaudeCommandRunner
	credentialReader?: ClaudeProfileCredentialReader
	fetchImplementation?: FetchImplementation
}): Promise<Account> {
	const id = crypto.randomUUID()
	const profilePath = canonicalClaudeProfilePath(join(input.paths.claudeProfiles, id))
	const runner = input.runner ?? defaultClaudeCommandRunner()
	await mkdir(profilePath, { mode: 0o700, recursive: true })
	let registered = false
	try {
		const command = ['claude', 'auth', 'login', '--claudeai']
		if (input.email !== undefined) {
			command.push('--email', input.email)
		}
		const exitCode = await runner.interactive(command, { CLAUDE_CONFIG_DIR: profilePath })
		if (exitCode !== 0) {
			throw new ApplicationError('LOGIN_FAILED', `claude auth login exited with ${exitCode}`)
		}
		const statusResult = await runner.captured(['claude', 'auth', 'status', '--json'], {
			CLAUDE_CONFIG_DIR: profilePath
		})
		if (statusResult.exitCode !== 0) {
			throw new ApplicationError(
				'AUTH_STATUS_FAILED',
				statusResult.stderr.trim() || 'Claude auth status failed'
			)
		}
		const status = ClaudeAuthStatusSchema.parse(JSON.parse(statusResult.stdout))
		if (!status.loggedIn) {
			throw new ApplicationError(
				'LOGIN_FAILED',
				'Claude reported that the isolated profile is not logged in'
			)
		}
		const credentialReader = input.credentialReader ?? defaultClaudeCredentialReader(runner)
		const credential = await credentialReader.read(profilePath)
		const profile = await fetchClaudeProfile(
			credential.accessToken,
			input.fetchImplementation ?? fetch
		)
		const email = AccountEmailSchema.safeParse(profile.email ?? status.email)
		if (!email.success) {
			throw new ApplicationError(
				'ACCOUNT_EMAIL_MISSING',
				'Claude did not return a verified account email; the login was not stored'
			)
		}
		const now = new Date().toISOString()
		const account: Account = {
			createdAt: now,
			enabled: true,
			externalAccountId: profile.accountId,
			externalUserId: null,
			health: credential.expiresAt <= Date.now() ? 'refreshDue' : 'ready',
			id,
			identity: email.data,
			label: email.data,
			plan: claudePlanTier(credential),
			profilePath,
			provider: 'anthropic',
			secretReference: null,
			updatedAt: now
		}
		registered = true
		return account
	} finally {
		if (!registered) {
			await removeClaudeProfile(profilePath, runner)
		}
	}
}

export async function removeClaudeProfile(
	profilePath: string,
	runner: ClaudeCommandRunner = defaultClaudeCommandRunner()
): Promise<void> {
	const service = claudeKeychainService(profilePath)
	const result = await runner.captured(
		['security', 'delete-generic-password', '-a', currentUser(), '-s', service],
		{}
	)
	await rm(profilePath, { force: true, recursive: true })
	if (result.exitCode !== 0 && result.exitCode !== 44) {
		throw new ApplicationError(
			'KEYCHAIN_DELETE_FAILED',
			result.stderr.trim() || `Could not remove Claude Keychain service ${service}`
		)
	}
}

function serializedScopes(scopes: ClaudeOauth['scopes']): string | undefined {
	switch (true) {
		case Array.isArray(scopes):
			return scopes.join(' ')
		case typeof scopes === 'string':
			return scopes
		default:
			return undefined
	}
}

export async function refreshClaudeProfile(input: {
	profilePath: string
	runner?: ClaudeCommandRunner
	credentialReader?: ClaudeProfileCredentialReader
}): Promise<ClaudeOauth> {
	const runner = input.runner ?? defaultClaudeCommandRunner()
	const reader = input.credentialReader ?? defaultClaudeCredentialReader(runner)
	const credential = await reader.read(input.profilePath)
	await projectClaudeCredential({
		credential,
		runner,
		targetProfilePath: input.profilePath
	})
	return reader.read(input.profilePath)
}

export async function projectClaudeCredential(input: {
	credential: ClaudeOauth
	targetProfilePath: string
	runner?: ClaudeCommandRunner
}): Promise<void> {
	const runner = input.runner ?? defaultClaudeCommandRunner()
	const result = await runner.captured(['claude', 'auth', 'login', '--claudeai'], {
		CLAUDE_CODE_OAUTH_REFRESH_TOKEN: input.credential.refreshToken,
		CLAUDE_CODE_OAUTH_SCOPES: serializedScopes(input.credential.scopes),
		CLAUDE_CONFIG_DIR: input.targetProfilePath
	})
	if (result.exitCode !== 0) {
		throw new ApplicationError(
			'REAUTHENTICATION_REQUIRED',
			result.stderr.trim() || `Claude profile refresh exited with ${result.exitCode}`
		)
	}
}
