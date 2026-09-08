import { expect, test } from 'bun:test'
import { removeMacOsKeychainCredentials } from './vault.ts'

test('uninstall deletes every tokenmaxx Keychain item, including chunks and orphaned credentials', async () => {
	const items = new Set(['codex:account', 'codex:account:0', 'codex:account:1', 'orphan'])
	const commands: string[][] = []
	await removeMacOsKeychainCredentials('test.tokenmaxx', {
		async run(command) {
			commands.push([...command])
			const item = items.values().next().value
			if (item === undefined) return { exitCode: 44, stderr: '', stdout: '' }
			items.delete(item)
			return { exitCode: 0, stderr: '', stdout: '' }
		}
	})
	expect(items.size).toBe(0)
	expect(commands.length).toBe(5)
	for (const command of commands)
		expect(command).toEqual(['security', 'delete-generic-password', '-s', 'test.tokenmaxx'])
})

test('Keychain access failures are reported instead of claiming successful cleanup', async () => {
	await expect(
		removeMacOsKeychainCredentials('test.tokenmaxx', {
			run: async () => ({ exitCode: 36, stderr: 'Keychain locked', stdout: '' })
		})
	).rejects.toThrow('Keychain locked')
})
