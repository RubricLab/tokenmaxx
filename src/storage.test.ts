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
