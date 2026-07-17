import { claudeUpstream, migrateClaudeAccount, probeClaude, removeClaudeProfile } from './claude.ts'
import { codexUpstream, probeCodex } from './codex.ts'
import {
	type Account,
	AutomationPolicySchema,
	type FetchImplementation,
	type ProviderId,
	type ProviderState,
	SwitchRecordSchema,
	TIMEFRAMES,
	type TokenTimeframe,
	UsageSnapshotSchema,
	type UsageWindow
} from './domain.ts'
import { ApplicationError, errorMessage, isNetworkFailure } from './errors.ts'
import type { ApplicationPaths } from './paths.ts'
import { costUsd } from './pricing.ts'
import {
	type ProxyLimitEvent,
	type RunningProxy,
	startProxy,
	type UpstreamInjection
} from './proxy.ts'
import { selectRotation } from './selection.ts'
import type { StateStore, TokenTimeframeAggregate } from './storage.ts'
import type { CredentialVault } from './vault.ts'

interface TokenBreakdownAccumulator {
	cacheCreation: number
	cached: number
	costUsd: number
	input: number
	output: number
	tokens: number
}

function emptyBreakdown(): TokenBreakdownAccumulator {
	return { cacheCreation: 0, cached: 0, costUsd: 0, input: 0, output: 0, tokens: 0 }
}

function addInto(target: TokenBreakdownAccumulator, entry: TokenBreakdownAccumulator): void {
	target.input += entry.input
	target.output += entry.output
	target.cached += entry.cached
	target.cacheCreation += entry.cacheCreation
	target.tokens += entry.tokens
	target.costUsd += entry.costUsd
}

function priceTokenTimeframe(aggregate: TokenTimeframeAggregate): TokenTimeframe {
	const grand = emptyBreakdown()
	let costInput = 0
	let costOutput = 0
	let costCached = 0
	let costCacheCreation = 0
	const byProvider = new Map<ProviderId, TokenBreakdownAccumulator>()
	const models: (TokenBreakdownAccumulator & { model: string; provider: ProviderId })[] = []
	for (const entry of aggregate.byModel) {
		const provider: ProviderId = entry.provider === 'anthropic' ? 'anthropic' : 'openai'
		const priced: TokenBreakdownAccumulator = {
			cacheCreation: entry.cacheCreation,
			cached: entry.cached,
			costUsd: costUsd(entry.model, entry.input, entry.output, entry.cached, entry.cacheCreation),
			input: entry.input,
			output: entry.output,
			tokens: entry.input + entry.output + entry.cached + entry.cacheCreation
		}
		costInput += costUsd(entry.model, entry.input, 0, 0, 0)
		costOutput += costUsd(entry.model, 0, entry.output, 0, 0)
		costCached += costUsd(entry.model, 0, 0, entry.cached, 0)
		costCacheCreation += costUsd(entry.model, 0, 0, 0, entry.cacheCreation)
		addInto(grand, priced)
		const bucket = byProvider.get(provider) ?? emptyBreakdown()
		addInto(bucket, priced)
		byProvider.set(provider, bucket)
		models.push({ ...priced, model: entry.model, provider })
	}
	const peakBucket = aggregate.buckets.reduce((max, value) => Math.max(max, value), 0)
	return {
		bucketMs: aggregate.bucketMs,
		buckets: aggregate.buckets,
		byProvider: [...byProvider.entries()]
			.map(([provider, totals]) => ({ ...totals, provider }))
			.sort((left, right) => right.costUsd - left.costUsd),
		costCacheCreation,
		costCached,
		costInput,
		costOutput,
		costUsd: grand.costUsd,
		key: aggregate.key,
		models: models.sort((left, right) => right.costUsd - left.costUsd),
		peakPerHour: peakBucket * (3_600_000 / aggregate.bucketMs),
		totalCacheCreation: grand.cacheCreation,
		totalCached: grand.cached,
		totalInput: grand.input,
		totalOutput: grand.output,
		totalTokens: grand.tokens
	}
}

interface ManagerDependencies {
	fetchImplementation: FetchImplementation
	now(): Date
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
	readonly #vault: CredentialVault
	readonly #providerOperationTails = new Map<ProviderId, Promise<void>>()
	readonly #probeCooldownUntil = new Map<string, number>()
	readonly #lastProbeStartedAt = new Map<string, number>()
	readonly #observationSavedAt = new Map<string, number>()
	readonly #observationEvaluatedAt = new Map<ProviderId, number>()
	#proxy: RunningProxy | null = null
	#monitor: ReturnType<typeof setInterval> | null = null
	#refreshOperation: Promise<void> | null = null
	#stopping = false

	public constructor(input: {
		paths: ApplicationPaths
		store: StateStore
		vault: CredentialVault
		dependencies?: Partial<ManagerDependencies>
	}) {
		this.#store = input.store
		this.#paths = input.paths
		this.#vault = input.vault
		this.#dependencies = { ...defaultDependencies, ...input.dependencies }
	}

	public get proxyPort(): number | null {
		return this.#proxy?.port ?? null
	}

	private async upstreamInjection(
		provider: ProviderId,
		forceRefresh: boolean
	): Promise<UpstreamInjection | null> {
		const account = this.activeAccount(provider)
		if (account === null) {
			return null
		}
		const shared = {
			fetchImplementation: this.#dependencies.fetchImplementation,
			forceRefresh,
			now: () => this.#dependencies.now().getTime(),
			vault: this.#vault
		}
		try {
			return account.provider === 'openai'
				? await codexUpstream({ account, ...shared })
				: await claudeUpstream({ account, ...shared })
		} catch (error) {
			const cause = error instanceof Error ? error : undefined
			if (isNetworkFailure(error)) {
				throw new ApplicationError(
					'UPSTREAM_UNREACHABLE',
					`could not refresh ${account.label} credentials: ${errorMessage(error)}`,
					{ cause }
				)
			}
			const cli = provider === 'openai' ? 'codex' : 'claude'
			throw new ApplicationError(
				'ACTIVE_CREDENTIAL_UNUSABLE',
				`${account.label} needs re-login — run: tokenmaxx login ${cli}`,
				{ cause }
			)
		}
	}

	public async start(): Promise<void> {
		this.#stopping = false
		await this.migrateClaudeProfiles()
		this.#proxy = startProxy({
			observeLimits: event => this.noteRateLimitObservation(event),
			port: this.#paths.proxyPort,
			record: event => {
				try {
					this.#store.recordTokenEvent(event)
				} catch {}
			},
			source: {
				refresh: async provider => {
					await this.upstreamInjection(provider, true)
				},
				resolve: provider => this.upstreamInjection(provider, false)
			}
		})
		void this.refreshAll().catch(() => undefined)
		this.#monitor = setInterval(() => {
			void this.refreshAll().catch(() => undefined)
		}, 60_000)
	}

	private async migrateClaudeProfiles(): Promise<void> {
		for (const account of this.#store.listAccounts()) {
			if (
				account.provider !== 'anthropic' ||
				account.secretReference !== null ||
				account.profilePath === null
			) {
				continue
			}
			try {
				this.#store.saveAccount(await migrateClaudeAccount({ account, vault: this.#vault }))
			} catch (error) {
				process.stderr.write(
					`[${this.#dependencies.now().toISOString()}] could not migrate ${account.label}: ${errorMessage(error)}\n`
				)
				this.#store.saveAccount({
					...account,
					health: 'reauthenticationRequired',
					updatedAt: this.#dependencies.now().toISOString()
				})
			}
		}
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
		const trailingWindowMs = 5 * 60_000
		return {
			snapshot,
			tokens: {
				nowPerHour:
					this.#store.tokensBetween(nowMillis - trailingWindowMs, nowMillis) *
					(3_600_000 / trailingWindowMs),
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
		enabled?: boolean
		thresholdPercent?: number
		authorizationConfirmed?: boolean
		minimumDwellMilliseconds?: number
		hysteresisPercent?: number
		hiddenWindowIds?: string[]
	}) {
		const current = this.#store.findProviderState(input.provider).policy
		const policy = AutomationPolicySchema.parse({
			...current,
			authorization: input.authorizationConfirmed ? 'confirmed' : current.authorization,
			enabled: input.enabled ?? current.enabled,
			hiddenWindowIds: input.hiddenWindowIds ?? current.hiddenWindowIds,
			hysteresisPercent: input.hysteresisPercent ?? current.hysteresisPercent,
			minimumDwellMilliseconds: input.minimumDwellMilliseconds ?? current.minimumDwellMilliseconds,
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
		const shared = {
			fetchImplementation: this.#dependencies.fetchImplementation,
			now: () => this.#dependencies.now(),
			vault: this.#vault
		}
		const result =
			account.provider === 'anthropic'
				? await probeClaude({ account, ...shared })
				: await probeCodex({ account, ...shared })
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

	private headerFresh(accountId: string): boolean {
		const snapshot = this.#store.findUsage(accountId)
		if (snapshot === null || snapshot.source !== 'proxyResponseHeaders') {
			return false
		}
		const age = this.#dependencies.now().getTime() - Date.parse(snapshot.observedAt)
		return Number.isFinite(age) && age < 120_000
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
			const probeInterval = this.headerFresh(account.id) ? 10 * 60_000 : isActive ? 0 : 5 * 60_000
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
					const health = healthForError(error)
					if (health === 'usageRateLimited' && this.headerFresh(account.id)) {
						return
					}
					this.#store.saveAccount({
						...account,
						health,
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
			case 'REAUTHENTICATION_REQUIRED':
				return 15 * 60_000
			default:
				return null
		}
	}

	public async noteRateLimitObservation(event: ProxyLimitEvent): Promise<void> {
		const account = this.#store.findAccount(event.accountId)
		if (account === null || account.provider !== event.provider) {
			return
		}
		const lastSaved = this.#observationSavedAt.get(event.accountId) ?? 0
		if (!event.observation.limited && event.at - lastSaved < 15_000) {
			return
		}
		this.#observationSavedAt.set(event.accountId, event.at)
		const existing = this.#store.findUsage(event.accountId)
		const windows = new Map<string, UsageWindow>(
			(existing?.windows ?? []).map(window => [window.id, window])
		)
		for (const window of event.observation.windows) {
			windows.set(window.id, window)
		}
		const merged = [...windows.values()]
		try {
			this.#store.saveUsage(
				UsageSnapshotSchema.parse({
					accountId: event.accountId,
					hardLimitReached:
						event.observation.limited ||
						merged.some(window => window.kind === 'hard' && window.usedPercent >= 100),
					observedAt: new Date(event.at).toISOString(),
					provider: event.provider,
					source: 'proxyResponseHeaders',
					windows: merged
				})
			)
		} catch {
			return
		}
		const lastEvaluated = this.#observationEvaluatedAt.get(event.provider) ?? 0
		if (event.observation.limited) {
			this.#observationEvaluatedAt.set(event.provider, event.at)
			await this.withProviderOperation(event.provider, () => this.evaluateAutomation(event.provider))
		} else if (event.at - lastEvaluated >= 5_000) {
			this.#observationEvaluatedAt.set(event.provider, event.at)
			void this.withProviderOperation(event.provider, () =>
				this.evaluateAutomation(event.provider)
			).catch(() => undefined)
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
