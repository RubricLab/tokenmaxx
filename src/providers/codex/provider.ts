import { type Account, AccountEmailSchema } from '../../domain.ts'
import { ApplicationError } from '../../errors.ts'
import type { FetchImplementation } from '../../http.ts'
import { type ProviderAdapter, type ProviderProbeResult, requireProvider } from '../provider.ts'
import {
	type CredentialVault,
	codexIdentity,
	readCodexCredential,
	refreshCodexCredential
} from './auth.ts'
import { fetchCodexUsage } from './usage.ts'

export interface OpenAiProviderDependencies {
	fetchImplementation: FetchImplementation
	now(): Date
}

export class OpenAiProviderAdapter implements ProviderAdapter {
	public readonly provider = 'openai' as const
	readonly #vault: CredentialVault
	readonly #dependencies: OpenAiProviderDependencies

	public constructor(input: { vault: CredentialVault; dependencies: OpenAiProviderDependencies }) {
		this.#vault = input.vault
		this.#dependencies = input.dependencies
	}

	public async probe(account: Account): Promise<ProviderProbeResult> {
		const openAiAccount = requireProvider(account, 'openai')
		if (openAiAccount.secretReference === null) {
			throw new ApplicationError('CREDENTIAL_MISSING', `${account.label} has no stored credential`)
		}
		let credential = await readCodexCredential(this.#vault, openAiAccount.secretReference)
		let identity = codexIdentity(credential)
		if (
			openAiAccount.externalAccountId !== null &&
			openAiAccount.externalAccountId !== identity.accountId
		) {
			throw new ApplicationError(
				'IDENTITY_CHANGED',
				'Stored OpenAI credential belongs to a different account'
			)
		}
		if (openAiAccount.externalUserId !== null && openAiAccount.externalUserId !== identity.userId) {
			throw new ApplicationError(
				'IDENTITY_CHANGED',
				'Stored OpenAI credential belongs to a different user'
			)
		}
		const usage = await fetchCodexUsage({
			accountId: openAiAccount.id,
			credential,
			fetchImplementation: this.#dependencies.fetchImplementation
		}).catch(async error => {
			if (!(error instanceof ApplicationError) || error.code !== 'ACCESS_TOKEN_REJECTED') {
				throw error
			}
			credential = await refreshCodexCredential({
				fetchImplementation: this.#dependencies.fetchImplementation,
				reference: openAiAccount.secretReference,
				vault: this.#vault
			})
			identity = codexIdentity(credential)
			return fetchCodexUsage({
				accountId: openAiAccount.id,
				credential,
				fetchImplementation: this.#dependencies.fetchImplementation
			})
		})
		const email = AccountEmailSchema.safeParse(identity.email)
		return {
			account: {
				...openAiAccount,
				externalAccountId: identity.accountId,
				externalUserId: identity.userId,
				health: 'ready',
				identity: email.success ? email.data : openAiAccount.identity,
				label: email.success ? email.data : openAiAccount.label,
				plan: identity.plan ?? openAiAccount.plan ?? null,
				updatedAt: this.#dependencies.now().toISOString()
			},
			usage
		}
	}
}
