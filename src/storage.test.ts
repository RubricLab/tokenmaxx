import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Account, distinctLabel, sameExternalIdentity } from './domain.ts'
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

describe('claude accounts are one per organization and user', () => {
	const claude = (n: number, fields: Partial<Extract<Account, { provider: 'anthropic' }>>) =>
		({
			auth: 'oauth',
			createdAt: '2026-07-01T00:00:00.000Z',
			enabled: true,
			externalAccountId: null,
			externalUserId: null,
			health: 'ready',
			id: `00000000-0000-4000-8000-00000000050${n}`,
			identity: 'dev@example.com',
			label: 'dev@example.com',
			onThreshold: 'switch',
			plan: 'max',
			profilePath: null,
			provider: 'anthropic',
			secretReference: `claude:${n}`,
			updatedAt: '2026-07-01T00:00:00.000Z',
			...fields
		}) satisfies Account

	test('a database from before keeps its row and takes a second subscription of the same user', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'tokenmaxx-store-')), 'state.sqlite')
		const legacy = claude(1, { externalAccountId: 'user-uuid' })
		const seed = createStateStore(path)
		seed.saveAccount(legacy)
		seed.close()
		const database = new Database(path)
		database.exec('DROP INDEX accounts_anthropic_external_user')
		database.exec(
			"CREATE UNIQUE INDEX accounts_anthropic_external ON accounts(external_account_id) WHERE provider = 'anthropic' AND external_account_id IS NOT NULL"
		)
		database.close()

		const store = createStateStore(path)
		expect(store.listAccounts('anthropic')).toEqual([legacy])
		const backfilled = { ...legacy, externalAccountId: 'personal-org', externalUserId: 'user-uuid' }
		store.saveAccount(backfilled)
		const team = claude(2, {
			externalAccountId: 'team-org',
			externalUserId: 'user-uuid',
			label: 'dev@example.com (team)',
			plan: 'team'
		})
		store.saveAccount(team)
		expect(store.listAccounts('anthropic')).toEqual([backfilled, team])
		expect(() =>
			store.saveAccount({
				...team,
				id: '00000000-0000-4000-8000-000000000503',
				identity: 'x@y.com',
				label: 'x@y.com'
			})
		).toThrow('Account conflicts')
		store.close()
	})

	test('a row without its organization still collides with a new row of the same user', () => {
		const store = createStateStore(
			join(mkdtempSync(join(tmpdir(), 'tokenmaxx-store-')), 'state.sqlite')
		)
		store.saveAccount(claude(1, { externalAccountId: 'user-uuid' }))
		expect(() =>
			store.saveAccount(
				claude(2, {
					externalAccountId: 'team-org',
					externalUserId: 'user-uuid',
					label: 'dev@example.com (team)'
				})
			)
		).toThrow('Account conflicts')
		store.close()
	})
})

describe('sign-in identity and labels', () => {
	const base = {
		auth: 'oauth',
		createdAt: '2026-07-01T00:00:00.000Z',
		enabled: true,
		health: 'ready',
		identity: 'dev@example.com',
		label: 'dev@example.com',
		onThreshold: 'switch',
		profilePath: null,
		updatedAt: '2026-07-01T00:00:00.000Z'
	} as const
	const personal: Account = {
		...base,
		externalAccountId: 'personal-org',
		externalUserId: 'user-uuid',
		id: '00000000-0000-4000-8000-000000000601',
		plan: 'max',
		provider: 'anthropic',
		secretReference: 'claude:1'
	}
	const team: Account = {
		...personal,
		externalAccountId: 'team-org',
		id: '00000000-0000-4000-8000-000000000602',
		plan: 'default_claude_team',
		secretReference: 'claude:2'
	}

	test('the same user in another organization is a new account, not a re-login', () => {
		expect(sameExternalIdentity(personal, team)).toBe(false)
		expect(sameExternalIdentity(personal, { ...personal, id: team.id })).toBe(true)
	})

	test('a row saved before organizations were recorded matches its user once', () => {
		const legacy = { ...personal, externalAccountId: 'user-uuid', externalUserId: null }
		expect(sameExternalIdentity(legacy, team)).toBe(true)
	})

	test('codex users sharing one workspace stay separate accounts', () => {
		const codex: Account = {
			...base,
			externalAccountId: 'workspace',
			externalUserId: 'user-a',
			id: '00000000-0000-4000-8000-000000000603',
			plan: 'team',
			provider: 'openai',
			secretReference: 'codex:1'
		}
		expect(sameExternalIdentity(codex, { ...codex, externalUserId: 'user-b' })).toBe(false)
		expect(sameExternalIdentity(codex, { ...codex, externalUserId: null })).toBe(true)
	})

	test('the label only gains a qualifier when the email is already taken', () => {
		expect(distinctLabel(personal, [])).toBe('dev@example.com')
		expect(distinctLabel(personal, [personal])).toBe('dev@example.com')
		expect(distinctLabel(team, [personal])).toBe('dev@example.com (team)')
		const sameplan = { ...team, plan: 'max' }
		expect(
			distinctLabel(sameplan, [
				personal,
				{ ...sameplan, id: personal.id, label: 'dev@example.com (max)' }
			])
		).toBe('dev@example.com (team-org)')
	})
})
