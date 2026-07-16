import { Database } from 'bun:sqlite'
import { chmodSync } from 'node:fs'
import {
	type Account,
	AccountSchema,
	type AutomationPolicy,
	AutomationPolicySchema,
	type DashboardSnapshot,
	DashboardSnapshotSchema,
	type ProviderId,
	ProviderIdSchema,
	type ProviderState,
	ProviderStateSchema,
	type SwitchRecord,
	SwitchRecordSchema,
	type TokenEvent,
	TokenEventSchema,
	type UsageHistory,
	UsageHistoryPointSchema,
	type UsageSnapshot,
	UsageSnapshotSchema
} from './domain.ts'
import { ApplicationError } from './errors.ts'

type PersistedSchema<Type> = { parse(value: unknown): Type }

const maxHistoryPoints = 2880
const maxTokenEventAgeMs = 31 * 24 * 60 * 60 * 1000
const tokenBucketCount = 120

export interface TokenTimeframeAggregate {
	key: string
	bucketMs: number
	buckets: number[]
	byModel: { model: string; provider: string; input: number; output: number; cached: number }[]
}

export interface StateStore {
	close(): void
	listAccounts(provider?: ProviderId): Account[]
	findAccount(accountId: string): Account | null
	saveAccount(account: Account): void
	removeAccount(accountId: string): void
	listUsage(): UsageSnapshot[]
	findUsage(accountId: string): UsageSnapshot | null
	saveUsage(snapshot: UsageSnapshot): void
	listProviderStates(): ProviderState[]
	findProviderState(provider: ProviderId): ProviderState
	saveProviderState(state: ProviderState): void
	saveAutomationPolicy(policy: AutomationPolicy): ProviderState
	listSwitchRecords(limit?: number): SwitchRecord[]
	saveSwitchRecord(record: SwitchRecord): void
	commitSwitch(record: SwitchRecord, state: ProviderState): void
	usageHistory(accountId: string): UsageHistory[]
	dashboard(): DashboardSnapshot
	recordTokenEvent(event: TokenEvent): void
	tokenAnalytics(
		nowMillis: number,
		timeframes: readonly { key: string; ms: number }[]
	): TokenTimeframeAggregate[]
}

interface JsonRow {
	payload: string
}

interface TableColumnRow {
	name: string
}

interface AccountMigrationRow extends JsonRow {
	id: string
}

function parsePayload<Type>(row: JsonRow | null, schema: PersistedSchema<Type>): Type | null {
	if (row === null) {
		return null
	}

	try {
		return schema.parse(JSON.parse(row.payload))
	} catch (error) {
		throw new ApplicationError('CORRUPT_STATE', 'Stored state failed schema validation', {
			cause: error
		})
	}
}

function parseRequiredPayload<Type>(row: JsonRow, schema: PersistedSchema<Type>): Type {
	const parsed = parsePayload(row, schema)
	if (parsed === null) {
		throw new ApplicationError('CORRUPT_STATE', 'Stored row unexpectedly has no payload')
	}
	return parsed
}

function serialize(value: unknown): string {
	return JSON.stringify(value)
}

function initialProviderState(provider: ProviderId): ProviderState {
	return ProviderStateSchema.parse({
		activeAccountId: null,
		generation: 0,
		policy: {
			authorization: 'notConfirmed',
			enabled: false,
			hysteresisPercent: 5,
			maximumSnapshotAgeMilliseconds: 120_000,
			minimumDwellMilliseconds: 300_000,
			provider,
			thresholdPercent: 95
		},
		provider,
		switchedAt: null
	})
}

function migrate(database: Database): void {
	database.exec('PRAGMA journal_mode = WAL')
	database.exec('PRAGMA foreign_keys = ON')
	database.exec('PRAGMA busy_timeout = 5000')
	database.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      external_account_id TEXT,
      external_user_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS accounts_provider ON accounts(provider);

    CREATE TABLE IF NOT EXISTS usage_snapshots (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_states (
      provider TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS switch_records (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS switch_records_provider_created
      ON switch_records(provider, created_at DESC);

    CREATE TABLE IF NOT EXISTS usage_history (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      window_id TEXT NOT NULL,
      label TEXT NOT NULL,
      points TEXT NOT NULL,
      PRIMARY KEY (account_id, window_id)
    );

    CREATE TABLE IF NOT EXISTS token_events (
      at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS token_events_at ON token_events(at);

    DROP TABLE IF EXISTS runtime_sessions;
  `)

	const accountColumns = new Set(
		database
			.query<TableColumnRow, []>('PRAGMA table_info(accounts)')
			.all()
			.map(column => column.name)
	)
	const tokenColumns = new Set(
		database
			.query<TableColumnRow, []>('PRAGMA table_info(token_events)')
			.all()
			.map(column => column.name)
	)
	if (!tokenColumns.has('cache_read_tokens')) {
		database.exec('ALTER TABLE token_events ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0')
		database.exec('DELETE FROM token_events')
	}
	const requiresLabelMigration = !accountColumns.has('label')
	const requiresExternalAccountIdMigration = !accountColumns.has('external_account_id')
	const requiresExternalUserIdMigration = !accountColumns.has('external_user_id')
	if (requiresLabelMigration) {
		database.exec('ALTER TABLE accounts ADD COLUMN label TEXT')
	}
	if (requiresExternalAccountIdMigration) {
		database.exec('ALTER TABLE accounts ADD COLUMN external_account_id TEXT')
	}
	if (requiresExternalUserIdMigration) {
		database.exec('ALTER TABLE accounts ADD COLUMN external_user_id TEXT')
	}
	if (
		requiresLabelMigration ||
		requiresExternalAccountIdMigration ||
		requiresExternalUserIdMigration
	) {
		const migrationRows = database
			.query<AccountMigrationRow, []>('SELECT id, payload FROM accounts')
			.all()
		const updateMigratedAccount = database.query(
			'UPDATE accounts SET label = ?, external_account_id = ?, external_user_id = ? WHERE id = ?'
		)
		for (const row of migrationRows) {
			const account = parseRequiredPayload(row, AccountSchema)
			updateMigratedAccount.run(
				account.label,
				account.externalAccountId,
				account.externalUserId,
				row.id
			)
		}
	}
	try {
		database.exec(`
      DROP INDEX IF EXISTS accounts_provider_external;
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_label
        ON accounts(provider, label);
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_openai_external_user
        ON accounts(external_account_id, external_user_id)
        WHERE provider = 'openai'
          AND external_account_id IS NOT NULL
          AND external_user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_anthropic_external
        ON accounts(external_account_id)
        WHERE provider = 'anthropic' AND external_account_id IS NOT NULL;
    `)
	} catch (error) {
		throw new ApplicationError(
			'DUPLICATE_ACCOUNT',
			'Stored accounts contain duplicate provider labels or identities',
			{ cause: error }
		)
	}

	const insertState = database.query(
		'INSERT OR IGNORE INTO provider_states(provider, payload) VALUES (?, ?)'
	)
	for (const provider of ProviderIdSchema.options) {
		insertState.run(provider, serialize(initialProviderState(provider)))
	}
}

export function createStateStore(databasePath: string): StateStore {
	const database = new Database(databasePath, { create: true, strict: true })
	migrate(database)
	for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
		try {
			chmodSync(path, 0o600)
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && Reflect.get(error, 'code') === 'ENOENT')) {
				throw error
			}
		}
	}

	function queryAll<Type>(
		schema: PersistedSchema<Type>,
		sql: string,
		...params: (string | number)[]
	): Type[] {
		return database
			.query<JsonRow, (string | number)[]>(sql)
			.all(...params)
			.map(row => parseRequiredPayload(row, schema))
	}

	function listAccounts(provider?: ProviderId): Account[] {
		return provider
			? queryAll(
					AccountSchema,
					'SELECT payload FROM accounts WHERE provider = ? ORDER BY label, id',
					provider
				)
			: queryAll(AccountSchema, 'SELECT payload FROM accounts ORDER BY provider, label, id')
	}

	function findAccount(accountId: string): Account | null {
		const row = database
			.query<JsonRow, [string]>('SELECT payload FROM accounts WHERE id = ?')
			.get(accountId)
		return parsePayload(row, AccountSchema)
	}

	function saveAccount(account: Account): void {
		const parsed = AccountSchema.parse(account)
		const duplicate = listAccounts(parsed.provider).find(
			candidate =>
				candidate.id !== parsed.id &&
				(candidate.label === parsed.label ||
					(parsed.provider === 'openai' &&
						candidate.provider === 'openai' &&
						parsed.externalAccountId !== null &&
						parsed.externalUserId !== null &&
						candidate.externalAccountId === parsed.externalAccountId &&
						candidate.externalUserId === parsed.externalUserId) ||
					(parsed.provider === 'anthropic' &&
						candidate.provider === 'anthropic' &&
						parsed.externalAccountId !== null &&
						candidate.externalAccountId === parsed.externalAccountId))
		)
		if (duplicate !== undefined) {
			throw new ApplicationError(
				'DUPLICATE_ACCOUNT',
				`Account conflicts with registered profile ${duplicate.label}`
			)
		}
		try {
			database
				.query(
					'INSERT INTO accounts(id, provider, label, external_account_id, external_user_id, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, label = excluded.label, external_account_id = excluded.external_account_id, external_user_id = excluded.external_user_id, payload = excluded.payload'
				)
				.run(
					parsed.id,
					parsed.provider,
					parsed.label,
					parsed.externalAccountId,
					parsed.externalUserId,
					serialize(parsed)
				)
		} catch (error) {
			if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
				throw new ApplicationError(
					'DUPLICATE_ACCOUNT',
					'Account label or identity is already registered',
					{ cause: error }
				)
			}
			throw error
		}
	}

	function removeAccount(accountId: string): void {
		const transaction = database.transaction(() => {
			for (const provider of ProviderIdSchema.options) {
				const state = findProviderState(provider)
				if (state.activeAccountId === accountId) {
					saveProviderState({ ...state, activeAccountId: null })
				}
			}
			database.query('DELETE FROM accounts WHERE id = ?').run(accountId)
		})
		transaction.immediate()
	}

	function listUsage(): UsageSnapshot[] {
		return queryAll(UsageSnapshotSchema, 'SELECT payload FROM usage_snapshots ORDER BY account_id')
	}

	function findUsage(accountId: string): UsageSnapshot | null {
		const row = database
			.query<JsonRow, [string]>('SELECT payload FROM usage_snapshots WHERE account_id = ?')
			.get(accountId)
		return parsePayload(row, UsageSnapshotSchema)
	}

	function saveUsage(snapshot: UsageSnapshot): void {
		const parsed = UsageSnapshotSchema.parse(snapshot)
		const account = findAccount(parsed.accountId)
		if (account === null) {
			throw new ApplicationError('ACCOUNT_NOT_FOUND', `Unknown account ${parsed.accountId}`)
		}
		if (account.provider !== parsed.provider) {
			throw new ApplicationError(
				'PROVIDER_MISMATCH',
				`Usage provider ${parsed.provider} does not match account provider ${account.provider}`
			)
		}
		const observedAtMillis = Date.parse(parsed.observedAt)
		database
			.transaction(() => {
				database
					.query(
						'INSERT INTO usage_snapshots(account_id, observed_at, payload) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET observed_at = excluded.observed_at, payload = excluded.payload'
					)
					.run(parsed.accountId, parsed.observedAt, serialize(parsed))
				for (const window of parsed.windows) {
					appendUsagePoint(parsed.accountId, window.id, window.label, {
						at: observedAtMillis,
						usedPercent: Math.max(0, Math.min(100, window.usedPercent))
					})
				}
			})
			.immediate()
	}

	function appendUsagePoint(
		accountId: string,
		windowId: string,
		label: string,
		point: { at: number; usedPercent: number }
	): void {
		const existing = database
			.query<{ points: string }, [string, string]>(
				'SELECT points FROM usage_history WHERE account_id = ? AND window_id = ?'
			)
			.get(accountId, windowId)
		const points =
			existing === null ? [] : UsageHistoryPointSchema.array().parse(JSON.parse(existing.points))
		points.push(point)
		database
			.query(
				'INSERT INTO usage_history(account_id, window_id, label, points) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, window_id) DO UPDATE SET label = excluded.label, points = excluded.points'
			)
			.run(accountId, windowId, label, JSON.stringify(points.slice(-maxHistoryPoints)))
	}

	function usageHistory(accountId: string): UsageHistory[] {
		return database
			.query<{ window_id: string; label: string; points: string }, [string]>(
				'SELECT window_id, label, points FROM usage_history WHERE account_id = ? ORDER BY window_id'
			)
			.all(accountId)
			.map(row => ({
				label: row.label,
				points: UsageHistoryPointSchema.array().parse(JSON.parse(row.points)),
				windowId: row.window_id
			}))
	}

	function listProviderStates(): ProviderState[] {
		return queryAll(ProviderStateSchema, 'SELECT payload FROM provider_states ORDER BY provider')
	}

	function findProviderState(provider: ProviderId): ProviderState {
		const parsedProvider = ProviderIdSchema.parse(provider)
		const row = database
			.query<JsonRow, [ProviderId]>('SELECT payload FROM provider_states WHERE provider = ?')
			.get(parsedProvider)
		const state = parsePayload(row, ProviderStateSchema)
		if (state === null) {
			throw new ApplicationError('STATE_NOT_FOUND', `Missing ${provider} provider state`)
		}
		return state
	}

	function saveProviderState(state: ProviderState): void {
		const parsed = ProviderStateSchema.parse(state)
		if (parsed.activeAccountId !== null) {
			const active = findAccount(parsed.activeAccountId)
			if (active === null || active.provider !== parsed.provider) {
				throw new ApplicationError(
					'INVALID_ACTIVE_ACCOUNT',
					`Active account must be a registered ${parsed.provider} account`
				)
			}
		}
		database
			.query(
				'INSERT INTO provider_states(provider, payload) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload'
			)
			.run(parsed.provider, serialize(parsed))
	}

	function saveAutomationPolicy(policy: AutomationPolicy): ProviderState {
		const parsed = AutomationPolicySchema.parse(policy)
		const state = { ...findProviderState(parsed.provider), policy: parsed }
		saveProviderState(state)
		return state
	}

	function listSwitchRecords(limit = 50): SwitchRecord[] {
		return queryAll(
			SwitchRecordSchema,
			'SELECT payload FROM switch_records ORDER BY created_at DESC LIMIT ?',
			limit
		)
	}

	function saveSwitchRecord(record: SwitchRecord): void {
		const parsed = SwitchRecordSchema.parse(record)
		database
			.query(
				'INSERT INTO switch_records(id, provider, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload'
			)
			.run(parsed.id, parsed.provider, parsed.createdAt, serialize(parsed))
	}

	function commitSwitch(record: SwitchRecord, state: ProviderState): void {
		const parsedRecord = SwitchRecordSchema.parse(record)
		const parsedState = ProviderStateSchema.parse(state)
		if (
			parsedRecord.phase !== 'committed' ||
			parsedRecord.provider !== parsedState.provider ||
			parsedRecord.targetAccountId !== parsedState.activeAccountId ||
			parsedRecord.generation !== parsedState.generation
		) {
			throw new ApplicationError(
				'INVALID_SWITCH_COMMIT',
				'Switch record and provider state do not form a valid commit'
			)
		}
		database
			.transaction(() => {
				saveSwitchRecord(parsedRecord)
				saveProviderState(parsedState)
			})
			.immediate()
	}

	function dashboard(): DashboardSnapshot {
		return database.transaction(() =>
			DashboardSnapshotSchema.parse({
				accounts: listAccounts(),
				providers: listProviderStates(),
				sampledAt: new Date().toISOString(),
				usage: listUsage()
			})
		)()
	}

	function recordTokenEvent(event: TokenEvent): void {
		const parsed = TokenEventSchema.parse(event)
		database
			.query(
				'INSERT INTO token_events (at, provider, account_id, model, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				parsed.at,
				parsed.provider,
				parsed.accountId,
				parsed.model,
				parsed.inputTokens,
				parsed.outputTokens,
				parsed.cacheReadTokens
			)
		database.query('DELETE FROM token_events WHERE at < ?').run(parsed.at - maxTokenEventAgeMs)
	}

	function tokenAnalytics(
		nowMillis: number,
		timeframes: readonly { key: string; ms: number }[]
	): TokenTimeframeAggregate[] {
		const bucketQuery = database.query<
			{ b: number; tokens: number },
			[number, number, number, number]
		>(
			'SELECT CAST((at - ?) / ? AS INTEGER) AS b, SUM(input_tokens + output_tokens + cache_read_tokens) AS tokens FROM token_events WHERE at >= ? AND at <= ? GROUP BY b'
		)
		const modelQuery = database.query<
			{ model: string | null; provider: string; input: number; output: number; cached: number },
			[number, number]
		>(
			'SELECT model, provider, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cached FROM token_events WHERE at >= ? AND at <= ? GROUP BY model, provider'
		)
		return timeframes.map(({ key, ms }) => {
			const start = nowMillis - ms
			const bucketMs = Math.max(1, Math.round(ms / tokenBucketCount))
			const buckets = new Array<number>(tokenBucketCount).fill(0)
			for (const row of bucketQuery.all(start, bucketMs, start, nowMillis)) {
				const index = Math.min(tokenBucketCount - 1, Math.max(0, row.b))
				buckets[index] = (buckets[index] ?? 0) + row.tokens
			}
			const byModel = modelQuery.all(start, nowMillis).map(row => ({
				cached: row.cached,
				input: row.input,
				model: row.model ?? 'unknown',
				output: row.output,
				provider: row.provider
			}))
			return { bucketMs, buckets, byModel, key }
		})
	}

	return {
		close: () => database.close(),
		commitSwitch,
		dashboard,
		findAccount,
		findProviderState,
		findUsage,
		listAccounts,
		listProviderStates,
		listSwitchRecords,
		listUsage,
		recordTokenEvent,
		removeAccount,
		saveAccount,
		saveAutomationPolicy,
		saveProviderState,
		saveSwitchRecord,
		saveUsage,
		tokenAnalytics,
		usageHistory
	}
}
