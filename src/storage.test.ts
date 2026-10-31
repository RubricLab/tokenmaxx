import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateStore } from './storage.ts'

describe('a database with rows this build cannot read', () => {
	test('still opens, lists what parses, and never kills the daemon', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'tokenmaxx-store-')), 'state.sqlite')
		const seed = createStateStore(path)
		seed.saveAccount({
			auth: 'oauth',
			createdAt: '2026-07-01T00:00:00.000Z',
			enabled: true,
			externalAccountId: 'acct-good',
			externalUserId: null,
			health: 'ready',
			id: '00000000-0000-4000-8000-000000000301',
			identity: 'good@rubriclabs.com',
			label: 'good@rubriclabs.com',
			onThreshold: 'switch',
			plan: 'max',
			profilePath: '/tmp/p',
			provider: 'anthropic',
			secretReference: null,
			updatedAt: '2026-07-01T00:00:00.000Z'
		})
		seed.close()

		const database = new Database(path)
		database
			.query(
				"INSERT INTO accounts(id, provider, label, payload) VALUES ('bad-row', 'anthropic', 'future@rubriclabs.com', ?)"
			)
			.run('{"provider":"anthropic","fromTheFuture":true}')
		database
			.query("UPDATE provider_states SET payload = 'not json at all' WHERE provider = 'openai'")
			.run()
		database.close()

		const store = createStateStore(path)
		expect(store.listAccounts().map(account => account.label)).toEqual(['good@rubriclabs.com'])
		expect(store.findAccount('bad-row')).toBeNull()
		expect(store.findProviderState('openai').policy.thresholdPercent).toBe(90)
		expect(store.dashboard().accounts).toHaveLength(1)
		store.close()
	})
})

describe('token analytics', () => {
	const day = 24 * 3_600_000
	const now = Date.UTC(2026, 9, 28, 12, 0, 0)
	const accountId = '00000000-0000-4000-8000-000000000401'
	const timeframes = [
		{ key: '1h', ms: 3_600_000 },
		{ key: '7d', ms: 7 * day },
		{ key: '31d', ms: 31 * day }
	]
	const events = Array.from({ length: 400 }, (_, index) => ({
		accountId: index % 3 === 0 ? null : accountId,
		at: now - ((index * 7_919_993) % (30 * day)),
		cacheCreationTokens: index % 5,
		cacheReadTokens: index * 3,
		inputTokens: 100 + index,
		model: index % 4 === 0 ? null : `model-${index % 2}`,
		outputTokens: index * 2,
		provider: index % 2 === 0 ? ('anthropic' as const) : ('openai' as const)
	}))
	const sorted = <Row extends { model: string; provider?: string }>(rows: Row[]) =>
		[...rows].sort((a, b) => `${a.provider}${a.model}`.localeCompare(`${b.provider}${b.model}`))

	test('long windows read the minute rollup and keep the same totals', () => {
		const store = createStateStore(
			join(mkdtempSync(join(tmpdir(), 'tokenmaxx-store-')), 'state.sqlite')
		)
		for (const event of events) {
			store.recordTokenEvent(event)
		}
		const [hour, week, month] = store.tokenAnalytics(now, timeframes)
		const inWindow = (ms: number) => events.filter(event => event.at >= now - ms)
		const total = (list: typeof events) =>
			list.reduce(
				(sum, event) =>
					sum +
					event.inputTokens +
					event.outputTokens +
					event.cacheReadTokens +
					event.cacheCreationTokens,
				0
			)
		expect(hour?.buckets.reduce((a, b) => a + b, 0)).toBe(total(inWindow(3_600_000)))
		expect(week?.buckets.reduce((a, b) => a + b, 0)).toBe(total(inWindow(7 * day)))
		expect(month?.buckets.reduce((a, b) => a + b, 0)).toBe(total(inWindow(31 * day)))
		expect(sorted(month?.byModel ?? []).map(row => row.model)).toContain('unknown')
		expect((month?.byModel ?? []).reduce((sum, row) => sum + row.input, 0)).toBe(
			events.reduce((sum, event) => sum + event.inputTokens, 0)
		)
		expect(
			store.accountTokens(accountId, now - 31 * day).reduce((sum, row) => sum + row.output, 0)
		).toBe(
			events
				.filter(event => event.accountId === accountId)
				.reduce((sum, event) => sum + event.outputTokens, 0)
		)
		store.close()
	})

	test('an existing database backfills the rollup from its raw events', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'tokenmaxx-store-')), 'state.sqlite')
		const seed = createStateStore(path)
		for (const event of events) {
			seed.recordTokenEvent(event)
		}
		const expected = seed.tokenAnalytics(now, timeframes)
		seed.close()

		const database = new Database(path)
		database.exec('DROP TABLE token_minutes')
		database.close()

		const store = createStateStore(path)
		const actual = store.tokenAnalytics(now, timeframes)
		expect(actual.map(frame => frame.buckets)).toEqual(expected.map(frame => frame.buckets))
		expect(actual.map(frame => sorted(frame.byModel))).toEqual(
			expected.map(frame => sorted(frame.byModel))
		)
		store.close()
	})

	test('minutes older than the retention window are pruned with their events', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'tokenmaxx-store-')), 'state.sqlite')
		const store = createStateStore(path)
		const old = { ...(events[1] as (typeof events)[number]), at: now - 40 * day }
		store.recordTokenEvent(old)
		store.recordTokenEvent({ ...old, at: now })
		store.close()

		const database = new Database(path)
		const count = (table: string) =>
			database.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
		expect(count('token_events')).toBe(1)
		expect(count('token_minutes')).toBe(1)
		database.close()
	})
})
