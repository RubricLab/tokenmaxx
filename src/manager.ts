import {
	type Account,
	AutomationPolicySchema,
	type ProviderId,
	type ProviderState,
	SwitchRecordSchema,
	TIMEFRAMES,
	type TokenTimeframe
} from './domain.ts'
import { ApplicationError, errorMessage } from './errors.ts'
import type { FetchImplementation } from './http.ts'
import type { ApplicationPaths } from './paths.ts'
import { costUsd } from './pricing.ts'
import { removeClaudeProfile } from './providers/claude/auth.ts'
import { AnthropicProviderAdapter } from './providers/claude/provider.ts'
import type { CredentialVault } from './providers/codex/auth.ts'
import { OpenAiProviderAdapter } from './providers/codex/provider.ts'
import type { ProviderAdapter } from './providers/provider.ts'
import { type RunningProxy, startProxy } from './proxy.ts'
import { createRuntimeCredentialSource } from './runtime-source.ts'
import { selectRotation } from './selection.ts'
import type { StateStore, TokenTimeframeAggregate } from './storage.ts'

function priceTokenTimeframe(aggregate: TokenTimeframeAggregate): TokenTimeframe {
	let totalInput = 0
	let totalOutput = 0
	let totalCached = 0
	let costTotal = 0
	const byProvider = {
		anthropic: { costUsd: 0, tokens: 0 },
		openai: { costUsd: 0, tokens: 0 }
	}
	let top: { model: string; tokens: number } | null = null
	for (const entry of aggregate.byModel) {
		const entryCost = costUsd(entry.model, entry.input, entry.output, entry.cached)
		const entryTokens = entry.input + entry.output + entry.cached
		totalInput += entry.input
		totalOutput += entry.output
		totalCached += entry.cached
		costTotal += entryCost
		const bucket = entry.provider === 'anthropic' ? byProvider.anthropic : byProvider.openai
		bucket.tokens += entryTokens
		bucket.costUsd += entryCost
		if (top === null || entryTokens > top.tokens) {
			top = { model: entry.model, tokens: entryTokens }
		}
	}
	const peakBucket = aggregate.buckets.reduce((max, value) => Math.max(max, value), 0)
	return {
		bucketMs: aggregate.bucketMs,
		buckets: aggregate.buckets,
		byProvider,
		costUsd: costTotal,
		key: aggregate.key,
		peakPerHour: peakBucket * (3_600_000 / aggregate.bucketMs),
		topModel: top?.model ?? null,
		totalCached,
		totalInput,
		totalOutput,
		totalTokens: totalInput + totalOutput + totalCached
	}
}

export interface ManagerDependencies {
	fetchImplementation: FetchImplementation
	now(): Date
}

export interface ProviderAdapters {
	openai: ProviderAdapter
	anthropic: ProviderAdapter
}

const defaultDependencies: ManagerDependencies = {
	fetchImplementation: fetch,
	now: () => new Date()
}

function healthForError(error: unknown): Account['health'] {
	if (error instanceof ApplicationError) {
		switch (error.code) {
			case 'REAUTHENTICATION_REQUIRED':
			case 'CREDENTIAL_MISSING':
			case 'ACCESS_TOKEN_REJECTED':
			case 'IDENTITY_CHANGED':
				return 'reauthenticationRequired'
			case 'USAGE_RATE_LIMITED':
				return 'usageRateLimited'
			case 'SCOPE_MISSING':
				return 'scopeMissing'
			default:
				return 'temporarilyUnreachable'
		}
	}
	return 'temporarilyUnreachable'
}

export class AccountManager {
	readonly #store: StateStore
	readonly #paths: ApplicationPaths
	readonly #dependencies: ManagerDependencies
	readonly #adapters: ProviderAdapters
	readonly #vault: CredentialVault
	readonly #providerOperationTails = new Map<ProviderId, Promise<void>>()
	readonly #probeCooldownUntil = new Map<string, number>()
	readonly #lastProbeStartedAt = new Map<string, number>()
	#proxy: RunningProxy | null = null
	#monitor: ReturnType<typeof setInterval> | null = null
	#refreshOperation: Promise<void> | null = null
	#stopping = false

	public constructor(input: {
		paths: ApplicationPaths
		store: StateStore
		vault: CredentialVault
		dependencies?: Partial<ManagerDependencies>
		adapters?: ProviderAdapters
	}) {
		this.#store = input.store
		this.#paths = input.paths
		this.#vault = input.vault
		this.#dependencies = { ...defaultDependencies, ...input.dependencies }
		this.#adapters =
			input.adapters ??
			({
				anthropic: new AnthropicProviderAdapter({ dependencies: this.#dependencies }),
				openai: new OpenAiProviderAdapter({
					dependencies: this.#dependencies,
					vault: input.vault
				})
			} satisfies ProviderAdapters)
		if (
			this.#adapters.openai.provider !== 'openai' ||
			this.#adapters.anthropic.provider !== 'anthropic'
		) {
			throw new ApplicationError(
				'PROVIDER_MISMATCH',
				'Injected provider adapters do not match their registry keys'
			)
		}
	}

	public get proxyPort(): number | null {
		return this.#proxy?.port ?? null
	}

	public async start(): Promise<void> {
		this.#stopping = false
		const source = createRuntimeCredentialSource({
			fetchImplementation: this.#dependencies.fetchImplementation,
			store: { activeAccount: provider => this.activeAccount(provider) },
			vault: this.#vault
		})
		this.#proxy = startProxy({
			port: this.#paths.proxyPort,
			record: event => {
				try {
					this.#store.recordTokenEvent({
						...event,
						accountId: this.activeAccount(event.provider)?.id ?? null
					})
				} catch {}
			},
			source
		})
		void this.refreshAll().catch(() => undefined)
		this.#monitor = setInterval(() => {
			void this.refreshAll().catch(() => undefined)
		}, 60_000)
	}

	public async stop(): Promise<void> {
		this.#stopping = true
		if (this.#monitor !== null) {
			clearInterval(this.#monitor)
			this.#monitor = null
		}
		const bounded = (work: Promise<unknown> | undefined, milliseconds: number) =>
			work === undefined ? Promise.resolve() : Promise.race([work, Bun.sleep(milliseconds)])
		await bounded(
			this.#refreshOperation?.catch(() => undefined),
			15_000
		)
		await bounded(
			this.#proxy?.stop().catch(() => undefined),
			5_000
		)
		this.#proxy = null
	}

	public dashboard() {
		return this.#store.dashboard()
	}

	public analytics() {
		const snapshot = this.#store.dashboard()
		const nowMillis = this.#dependencies.now().getTime()
		return {
			history: snapshot.accounts.map(account => ({
				accountId: account.id,
				windows: this.#store.usageHistory(account.id)
			})),
			snapshot,
			tokens: {
				timeframes: this.#store.tokenAnalytics(nowMillis, TIMEFRAMES).map(priceTokenTimeframe)
			}
		}
	}

	public activeAccount(provider: ProviderId): Account | null {
		const accountId = this.#store.findProviderState(provider).activeAccountId
		return accountId === null ? null : this.#store.findAccount(accountId)
	}

	public async saveAccount(input: {
		account: Account
		removePrevious: { secretReference: string | null; profilePath: string | null }
	}): Promise<void> {
		return this.withProviderOperation(input.account.provider, async () => {
			this.#store.saveAccount(input.account)
			const { secretReference, profilePath } = input.removePrevious
			if (secretReference !== null && secretReference !== input.account.secretReference) {
				await this.#vault.remove(secretReference).catch(() => undefined)
			}
			if (profilePath !== null && profilePath !== input.account.profilePath) {
				await removeClaudeProfile(profilePath).catch(() => undefined)
			}
			const state = this.#store.findProviderState(input.account.provider)
			if (state.activeAccountId === null) {
				this.commitActivation({
					provider: input.account.provider,
					reason: 'first-account',
					sourceAccountId: null,
					state,
					target: input.account
				})
			}
		})
	}

	public setAutomationPolicy(input: {
		provider: ProviderId
		enabled: boolean
		thresholdPercent?: number
		authorizationConfirmed?: boolean
	}) {
		const current = this.#store.findProviderState(input.provider).policy
		const policy = AutomationPolicySchema.parse({
			...current,
			authorization: input.authorizationConfirmed ? 'confirmed' : current.authorization,
			enabled: input.enabled,
			thresholdPercent: input.thresholdPercent ?? current.thresholdPercent
		})
		if (policy.enabled && policy.authorization !== 'confirmed') {
			throw new ApplicationError(
				'AUTHORIZATION_REQUIRED',
				'Automatic rotation requires explicit confirmation that your provider authorizes this use'
			)
		}
		return this.#store.saveAutomationPolicy(policy)
	}

	public async refreshAll(): Promise<void> {
		if (this.#refreshOperation !== null) {
			return this.#refreshOperation
		}
		const operation = this.performRefreshAll().finally(() => {
			if (this.#refreshOperation === operation) {
				this.#refreshOperation = null
			}
		})
		this.#refreshOperation = operation
		return operation
	}

	public async refreshAccount(account: Account): Promise<void> {
		return this.withProviderOperation(account.provider, () => this.probeAndSave(account))
	}

	private async probeAndSave(account: Account): Promise<void> {
		const result = await this.adapter(account.provider).probe(account)
		this.#store.saveUsage(result.usage)
		this.#store.saveAccount(result.account)
	}

	public async switchAccount(
		provider: ProviderId,
		targetAccountId: string,
		reason = 'manual'
	): Promise<void> {
		return this.withProviderOperation(provider, async () => {
			const state = this.#store.findProviderState(provider)
			const target = this.#store.findAccount(targetAccountId)
			if (target === null || target.provider !== provider || !target.enabled) {
				throw new ApplicationError(
					'INVALID_TARGET',
					`Account ${targetAccountId} is not an enabled ${provider} account`
				)
			}
			if (state.activeAccountId !== targetAccountId) {
				await this.probeAndSave(target)
			}
			this.commitActivation({
				provider,
				reason,
				sourceAccountId: state.activeAccountId,
				state,
				target
			})
		})
	}

	private async performRefreshAll(): Promise<void> {
		for (const account of this.#store.listAccounts()) {
			if (this.#stopping) {
				return
			}
			if (!account.enabled) {
				continue
			}
			const cooldownUntil = this.#probeCooldownUntil.get(account.id) ?? 0
			if (this.#dependencies.now().getTime() < cooldownUntil) {
				continue
			}
			const isActive = this.#store.findProviderState(account.provider).activeAccountId === account.id
			const probeInterval = isActive ? 0 : 5 * 60_000
			const lastStartedAt = this.#lastProbeStartedAt.get(account.id) ?? 0
			if (this.#dependencies.now().getTime() - lastStartedAt < probeInterval) {
				continue
			}
			this.#lastProbeStartedAt.set(account.id, this.#dependencies.now().getTime())
			await this.refreshAccount(account).then(
				() => {
					this.#probeCooldownUntil.delete(account.id)
				},
				error => {
					process.stderr.write(
						`[${this.#dependencies.now().toISOString()}] probe failed for ${account.provider} ${account.label}: ${errorMessage(error)}\n`
					)
					const cooldown = this.probeCooldownForError(error)
					if (cooldown !== null) {
						this.#probeCooldownUntil.set(account.id, this.#dependencies.now().getTime() + cooldown)
					}
					this.#store.saveAccount({
						...account,
						health: healthForError(error),
						updatedAt: this.#dependencies.now().toISOString()
					})
				}
			)
		}
		if (this.#stopping) {
			return
		}
		for (const provider of ['openai', 'anthropic'] as const) {
			if (this.#stopping) {
				return
			}
			await this.evaluateAutomation(provider)
		}
	}

	private probeCooldownForError(error: unknown): number | null {
		if (!(error instanceof ApplicationError)) {
			return null
		}
		switch (error.code) {
			case 'USAGE_RATE_LIMITED':
				return 5 * 60_000
			// Each retry spawns `claude auth login`; hammering a dead refresh
			// token every probe risks burning the whole token family.
			case 'REAUTHENTICATION_REQUIRED':
				return 15 * 60_000
			default:
				return null
		}
	}

	private async evaluateAutomation(provider: ProviderId): Promise<void> {
		const state = this.#store.findProviderState(provider)
		const decision = selectRotation({
			accounts: this.#store.listAccounts(provider),
			now: this.#dependencies.now(),
			state,
			usage: this.#store.listUsage()
		})
		if (decision.rotate) {
			await this.performSwitchForAutomation(provider, decision.targetAccountId, decision.reason)
		}
	}

	private async performSwitchForAutomation(
		provider: ProviderId,
		targetAccountId: string,
		reason: string
	): Promise<void> {
		const state = this.#store.findProviderState(provider)
		const target = this.#store.findAccount(targetAccountId)
		if (target === null || target.provider !== provider || !target.enabled) {
			return
		}
		this.commitActivation({
			provider,
			reason: `automatic:${reason}`,
			sourceAccountId: state.activeAccountId,
			state,
			target
		})
	}

	private commitActivation(input: {
		provider: ProviderId
		state: ProviderState
		sourceAccountId: string | null
		target: Account
		reason: string
	}): void {
		const now = this.#dependencies.now().toISOString()
		this.#store.commitSwitch(
			SwitchRecordSchema.parse({
				createdAt: now,
				generation: input.state.generation + 1,
				id: crypto.randomUUID(),
				message: null,
				phase: 'committed',
				provider: input.provider,
				reason: input.reason,
				sourceAccountId: input.sourceAccountId,
				targetAccountId: input.target.id,
				updatedAt: now
			}),
			{
				...input.state,
				activeAccountId: input.target.id,
				generation: input.state.generation + 1,
				switchedAt: now
			}
		)
	}

	private adapter(provider: ProviderId): ProviderAdapter {
		switch (provider) {
			case 'openai':
				return this.#adapters.openai
			case 'anthropic':
				return this.#adapters.anthropic
		}
	}

	private async withProviderOperation<Result>(
		provider: ProviderId,
		operation: () => Promise<Result>
	): Promise<Result> {
		const previous = this.#providerOperationTails.get(provider) ?? Promise.resolve()
		let release: (() => void) | undefined
		const current = new Promise<void>(resolve => {
			release = resolve
		})
		const tail = previous.then(() => current)
		this.#providerOperationTails.set(provider, tail)
		await previous
		try {
			return await operation()
		} finally {
			release?.()
			if (this.#providerOperationTails.get(provider) === tail) {
				this.#providerOperationTails.delete(provider)
			}
		}
	}
}
