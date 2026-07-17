import type { Account, ProviderId } from './domain.ts'
import { ApplicationError, errorMessage, isNetworkFailure } from './errors.ts'
import type { FetchImplementation } from './http.ts'
import { readClaudeCredential, refreshClaudeCredential } from './providers/claude/auth.ts'
import {
	type CodexAuth,
	codexIdentity,
	readCodexCredential,
	refreshCodexCredential
} from './providers/codex/auth.ts'
import { type ProxyCredentialSource, type UpstreamInjection, upstreamFor } from './proxy.ts'
import type { CredentialVault } from './vault.ts'

export interface RuntimeSourceStore {
	activeAccount(provider: ProviderId): Account | null
}

export interface RuntimeSourceDependencies {
	store: RuntimeSourceStore
	vault: CredentialVault
	fetchImplementation?: FetchImplementation
	now?: () => number
}

const refreshMarginMilliseconds = 120_000

function accessExpiry(auth: CodexAuth): number | null {
	const identity = codexIdentity(auth)
	return identity.accessExpiresAt === null ? null : Date.parse(identity.accessExpiresAt)
}

export function createRuntimeCredentialSource(
	dependencies: RuntimeSourceDependencies
): ProxyCredentialSource {
	const now = dependencies.now ?? (() => Date.now())
	const fetchImplementation = dependencies.fetchImplementation

	async function openAiInjection(
		account: Account,
		forceRefresh: boolean
	): Promise<UpstreamInjection> {
		if (account.secretReference === null) {
			throw new ApplicationError('CREDENTIAL_MISSING', `${account.label} has no stored credential`)
		}
		let auth = await readCodexCredential(dependencies.vault, account.secretReference)
		const expiry = accessExpiry(auth)
		const stale = expiry !== null && expiry - now() <= refreshMarginMilliseconds
		if (forceRefresh || stale) {
			auth = await refreshCodexCredential({
				fetchImplementation,
				reference: account.secretReference,
				vault: dependencies.vault
			})
		}
		return {
			accountId: account.id,
			baseUrl: upstreamFor('openai'),
			headers: {
				authorization: `Bearer ${auth.tokens.access_token}`,
				'chatgpt-account-id': codexIdentity(auth).accountId
			}
		}
	}

	async function anthropicInjection(
		account: Account,
		forceRefresh: boolean
	): Promise<UpstreamInjection> {
		if (account.secretReference === null) {
			throw new ApplicationError('CREDENTIAL_MISSING', `${account.label} has no stored credential`)
		}
		let credential = await readClaudeCredential(dependencies.vault, account.secretReference)
		const stale = credential.expiresAt - now() <= refreshMarginMilliseconds
		if (forceRefresh || stale) {
			credential = await refreshClaudeCredential({
				fetchImplementation,
				reference: account.secretReference,
				staleAccessToken: credential.accessToken,
				vault: dependencies.vault
			})
		}
		return {
			accountId: account.id,
			appendHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
			baseUrl: upstreamFor('anthropic'),
			headers: { authorization: `Bearer ${credential.accessToken}` },
			stripHeaders: ['x-api-key']
		}
	}

	async function injectionFor(
		provider: ProviderId,
		forceRefresh: boolean
	): Promise<UpstreamInjection | null> {
		const account = dependencies.store.activeAccount(provider)
		if (account === null) {
			return null
		}
		try {
			return provider === 'openai'
				? await openAiInjection(account, forceRefresh)
				: await anthropicInjection(account, forceRefresh)
		} catch (error) {
			if (isNetworkFailure(error)) {
				throw new ApplicationError(
					'UPSTREAM_UNREACHABLE',
					`could not refresh ${account.label} credentials: ${errorMessage(error)}`,
					{ cause: error instanceof Error ? error : undefined }
				)
			}
			const cli = provider === 'openai' ? 'codex' : 'claude'
			throw new ApplicationError(
				'ACTIVE_CREDENTIAL_UNUSABLE',
				`${account.label} needs re-login — run: tokenmaxx login ${cli}`,
				{ cause: error instanceof Error ? error : undefined }
			)
		}
	}

	return {
		refresh: async provider => {
			await injectionFor(provider, true)
		},
		resolve: provider => injectionFor(provider, false)
	}
}
