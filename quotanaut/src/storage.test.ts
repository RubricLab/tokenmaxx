import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateStore } from './storage.ts'

test('a fresh database contains only the OpenAI provider state', () => {
	const path = join(mkdtempSync(join(tmpdir(), 'quotanaut-fresh-store-')), 'state.sqlite')
	const store = createStateStore(path)
	expect(store.listAccounts()).toEqual([])
	expect(store.listProviderStates().map(state => state.provider)).toEqual(['openai'])
	expect(store.dashboard().providers).toHaveLength(1)
	store.close()
})

describe('a database with rows this build cannot read', () => {
	test('still opens, lists what parses, and never kills the daemon', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'quotanaut-store-')), 'state.sqlite')
		const seed = createStateStore(path)
		seed.saveAccount({
			auth: 'oauth',
			createdAt: '2026-07-01T00:00:00.000Z',
			enabled: true,
			externalAccountId: 'acct-good',
			externalUserId: 'user-good',
			health: 'ready',
			id: '00000000-0000-4000-8000-000000000301',
			identity: 'good@example.com',
			label: 'good@example.com',
			onThreshold: 'switch',
			plan: 'pro',
			profilePath: null,
			provider: 'openai',
			secretReference: 'codex:good',
			updatedAt: '2026-07-01T00:00:00.000Z'
		})
		seed.close()

		const database = new Database(path)
		database
			.query(
				"INSERT INTO accounts(id, provider, label, payload) VALUES ('bad-row', 'openai', 'future@example.com', ?)"
			)
			.run('{"provider":"openai","fromTheFuture":true}')
		database
			.query("UPDATE provider_states SET payload = 'not json at all' WHERE provider = 'openai'")
			.run()
		database.close()

		const store = createStateStore(path)
		expect(store.listAccounts().map(account => account.label)).toEqual(['good@example.com'])
		expect(store.findAccount('bad-row')).toBeNull()
		expect(store.findProviderState('openai').policy.thresholdPercent).toBe(90)
		expect(store.dashboard().accounts).toHaveLength(1)
		store.close()
	})
})
