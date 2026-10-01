import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account } from './domain.ts'
import { AccountManager } from './manager.ts'
import { applicationPaths } from './paths.ts'
import { createStateStore } from './storage.ts'

function account(n: number): Account {
	return {
		auth: 'oauth',
		createdAt: '2026-06-01T00:00:00.000Z',
		enabled: true,
		externalAccountId: `acct_${n}`,
		externalUserId: null,
		health: 'ready',
		id: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
		identity: `user${n}@example.com`,
		label: `user${n}@example.com`,
		onThreshold: 'switch',
		plan: 'max',
		profilePath: null,
		provider: 'anthropic',
		secretReference: `claude:${n}`,
		updatedAt: '2026-06-01T00:00:00.000Z'
	}
}

function setup() {
	const home = mkdtempSync(join(tmpdir(), 'tokenmaxx-order-'))
	const paths = applicationPaths({ TOKENMAXX_HOME: home })
	const store = createStateStore(join(home, 'state.sqlite'))
	for (const n of [1, 2, 3]) {
		store.saveAccount(account(n))
	}
	const vault = {
		read: async () => null,
		remove: async () => undefined,
		write: async () => undefined
	}
	return { manager: new AccountManager({ paths, store, vault }), store }
}

const priorities = (accounts: readonly Account[]) =>
	Object.fromEntries(accounts.map(candidate => [candidate.label, candidate.priority]))

describe('account order', () => {
	test('puts the listed accounts first and keeps the rest after them', async () => {
		const { manager, store } = setup()
		await manager.setAccountOrder('anthropic', [account(3).id])
		expect(priorities(store.listAccounts('anthropic'))).toEqual({
			'user1@example.com': 1,
			'user2@example.com': 2,
			'user3@example.com': 0
		})
		await manager.setAccountOrder('anthropic', [account(2).id, account(3).id])
		expect(priorities(store.listAccounts('anthropic'))).toEqual({
			'user1@example.com': 2,
			'user2@example.com': 0,
			'user3@example.com': 1
		})
	})

	test('an empty list clears the order', async () => {
		const { manager, store } = setup()
		await manager.setAccountOrder('anthropic', [account(2).id])
		await manager.setAccountOrder('anthropic', [])
		expect(store.listAccounts('anthropic').every(candidate => candidate.priority === undefined)).toBe(
			true
		)
	})

	test('rejects an account from another provider', async () => {
		const { manager } = setup()
		await expect(manager.setAccountOrder('openai', [account(1).id])).rejects.toThrow(
			'No openai account'
		)
	})
})
