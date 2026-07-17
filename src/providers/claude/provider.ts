import { type Account, AccountEmailSchema } from '../../domain.ts'
import { ApplicationError } from '../../errors.ts'
import type { FetchImplementation } from '../../http.ts'
import type { CredentialVault } from '../../vault.ts'
import { type ProviderAdapter, type ProviderProbeResult, requireProvider } from '../provider.ts'
import {
	claudePlanTier,
	fetchClaudeProfile,
	readClaudeCredential,
	refreshClaudeCredential
} from './auth.ts'
import { fetchClaudeUsage } from './usage.ts'

export interface AnthropicProviderDependencies {
	fetchImplementation: FetchImplementation
	now(): Date
}

function scopesPermitUsage(scopes: string | string[] | undefined): boolean {
	if (scopes === undefined) {
		return true
	}
	const values = Array.isArray(scopes) ? scopes : scopes.split(/[ ,]+/)
	return values.includes('user:profile')
}

function health(refreshTokenExpiresAt: number | undefined, now: Date): Account['health'] {
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

export class AnthropicProviderAdapter implements ProviderAdapter {
	public readonly provider = 'anthropic' as const
	readonly #dependencies: AnthropicProviderDependencies
	readonly #vault: CredentialVault
	readonly #verifiedIdentities = new Map<
		string,
		{ accessToken: string; accountId: string; email: string | null }
	>()

	public constructor(input: {
		dependencies: AnthropicProviderDependencies
		vault: CredentialVault
	}) {
		this.#dependencies = input.dependencies
		this.#vault = input.vault
	}

	public async probe(account: Account): Promise<ProviderProbeResult> {
		const anthropicAccount = requireProvider(account, 'anthropic')
		const reference = anthropicAccount.secretReference
		if (reference === null) {
			throw new ApplicationError('CREDENTIAL_MISSING', `${account.label} has no stored credential`)
		}
		const refresh = (staleAccessToken: string) =>
			refreshClaudeCredential({
				fetchImplementation: this.#dependencies.fetchImplementation,
				reference,
				staleAccessToken,
				vault: this.#vault
			})
		let credential = await readClaudeCredential(this.#vault, reference)
		if (credential.expiresAt <= this.#dependencies.now().getTime() + 300_000) {
			credential = await refresh(credential.accessToken)
		}
		if (!scopesPermitUsage(credential.scopes)) {
			throw new ApplicationError(
				'SCOPE_MISSING',
				'Claude credential does not include the user:profile scope required for usage'
			)
		}
		const verifyIdentity = async (): Promise<{ accountId: string; email: string | null }> => {
			const cached = this.#verifiedIdentities.get(reference)
			if (cached !== undefined && cached.accessToken === credential.accessToken) {
				return { accountId: cached.accountId, email: cached.email }
			}
			const fetched = await fetchClaudeProfile(
				credential.accessToken,
				this.#dependencies.fetchImplementation
			)
			this.#verifiedIdentities.set(reference, {
				accessToken: credential.accessToken,
				...fetched
			})
			return fetched
		}
		let profile = await verifyIdentity().catch(async error => {
			if (!(error instanceof ApplicationError) || error.code !== 'REAUTHENTICATION_REQUIRED') {
				throw error
			}
			credential = await refresh(credential.accessToken)
			return verifyIdentity()
		})
		assertIdentity(anthropicAccount, profile.accountId)
		const usage = await fetchClaudeUsage({
			accessToken: credential.accessToken,
			accountId: anthropicAccount.id,
			fetchImplementation: this.#dependencies.fetchImplementation
		}).catch(async error => {
			if (!(error instanceof ApplicationError) || error.code !== 'ACCESS_TOKEN_REJECTED') {
				throw error
			}
			credential = await refresh(credential.accessToken)
			profile = await verifyIdentity()
			return fetchClaudeUsage({
				accessToken: credential.accessToken,
				accountId: anthropicAccount.id,
				fetchImplementation: this.#dependencies.fetchImplementation
			})
		})
		assertIdentity(anthropicAccount, profile.accountId)
		const email = AccountEmailSchema.safeParse(profile.email)
		return {
			account: {
				...anthropicAccount,
				health: health(credential.refreshTokenExpiresAt, this.#dependencies.now()),
				identity: email.success ? email.data : anthropicAccount.identity,
				label: email.success ? email.data : anthropicAccount.label,
				plan: claudePlanTier(credential) ?? anthropicAccount.plan ?? null,
				updatedAt: this.#dependencies.now().toISOString()
			},
			usage
		}
	}
}
