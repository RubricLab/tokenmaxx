import { afterEach, describe, expect, test } from 'bun:test'
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplicationError } from './errors.ts'
import { createFileSystemCredentialVault } from './vault.ts'

const temporaryDirectories: string[] = []

async function temporaryVaultRoot(): Promise<string> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quotanaut-vault-test-'))
	temporaryDirectories.push(temporaryDirectory)
	return join(temporaryDirectory, 'credentials')
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
	)
})

describe('filesystem credential vault', () => {
	test('stores credentials in a private directory and private files', async () => {
		const root = await temporaryVaultRoot()
		const vault = createFileSystemCredentialVault(root)
		const reference = 'codex:account-1'
		const credential = '{"access_token":"private-value"}'

		await vault.write(reference, credential)

		expect(await vault.read(reference)).toBe(credential)
		expect((await lstat(root)).mode & 0o777).toBe(0o700)
		expect((await lstat(join(root, reference))).mode & 0o777).toBe(0o600)
	})

	test('atomically replaces an existing credential without temporary files', async () => {
		const root = await temporaryVaultRoot()
		const vault = createFileSystemCredentialVault(root)
		const reference = 'codex:account-2'

		await vault.write(reference, 'first-value'.repeat(10_000))
		await vault.write(reference, 'second-value'.repeat(10_000))

		expect(await vault.read(reference)).toBe('second-value'.repeat(10_000))
		expect(await readdir(root)).toEqual([reference])
	})

	test('rejects a vault root with unsafe permissions', async () => {
		const root = await temporaryVaultRoot()
		await mkdir(root, { mode: 0o700, recursive: true })
		await chmod(root, 0o755)

		await expect(createFileSystemCredentialVault(root).read('codex:any')).rejects.toMatchObject({
			code: 'CREDENTIAL_VAULT_MODE_INVALID'
		})
	})

	test('rejects credential files with unsafe permissions before any operation', async () => {
		const root = await temporaryVaultRoot()
		await mkdir(root, { mode: 0o700, recursive: true })
		const path = join(root, 'codex:unsafe')
		await writeFile(path, 'credential', { mode: 0o600 })
		await chmod(path, 0o644)
		const vault = createFileSystemCredentialVault(root)

		await expect(vault.read('codex:unsafe')).rejects.toMatchObject({
			code: 'CREDENTIAL_MODE_INVALID'
		})
		await expect(vault.write('codex:unsafe', 'replacement')).rejects.toMatchObject({
			code: 'CREDENTIAL_MODE_INVALID'
		})
		await expect(vault.remove('codex:unsafe')).rejects.toMatchObject({
			code: 'CREDENTIAL_MODE_INVALID'
		})
		expect(await readFile(path, 'utf8')).toBe('credential')
	})

	test('rejects credential files owned by another user', async () => {
		const root = await temporaryVaultRoot()
		await mkdir(root, { mode: 0o700, recursive: true })
		await writeFile(join(root, 'codex:owner'), 'credential', { mode: 0o600 })
		const actualUserId = (await lstat(root)).uid
		const vault = createFileSystemCredentialVault(root, { userId: actualUserId + 1 })

		await expect(vault.read('codex:owner')).rejects.toMatchObject({
			code: 'CREDENTIAL_OWNER_INVALID'
		})
	})

	test('rejects symbolic-link and non-regular credential targets', async () => {
		const root = await temporaryVaultRoot()
		await mkdir(root, { mode: 0o700, recursive: true })
		const target = join(root, 'target')
		await writeFile(target, 'credential', { mode: 0o600 })
		await symlink(target, join(root, 'codex:link'))
		await mkdir(join(root, 'codex:directory'), { mode: 0o700 })
		const vault = createFileSystemCredentialVault(root)

		for (const reference of ['codex:link', 'codex:directory']) {
			await expect(vault.read(reference)).rejects.toMatchObject({
				code: 'CREDENTIAL_TARGET_INVALID'
			})
			await expect(vault.write(reference, 'replacement')).rejects.toMatchObject({
				code: 'CREDENTIAL_TARGET_INVALID'
			})
			await expect(vault.remove(reference)).rejects.toMatchObject({
				code: 'CREDENTIAL_TARGET_INVALID'
			})
		}
		expect(await readFile(target, 'utf8')).toBe('credential')
	})

	test('rejects path-like references without exposing a value', async () => {
		const root = await temporaryVaultRoot()
		const vault = createFileSystemCredentialVault(root)
		const secret = 'must-not-appear-in-an-error'

		for (const reference of ['', '.', '..', '../auth', 'nested/auth', '.hidden', 'bad reference']) {
			let failure: unknown
			try {
				await vault.write(reference, secret)
			} catch (error) {
				failure = error
			}
			expect(failure).toBeInstanceOf(ApplicationError)
			expect((failure as ApplicationError).code).toBe('CREDENTIAL_REFERENCE_INVALID')
			expect((failure as Error).message).not.toContain(secret)
		}
	})

	test('returns null for a missing credential and removes credentials idempotently', async () => {
		const root = await temporaryVaultRoot()
		const vault = createFileSystemCredentialVault(root)

		expect(await vault.read('codex:missing')).toBeNull()
		await vault.write('codex:remove-me', 'credential')
		await vault.remove('codex:remove-me')
		await vault.remove('codex:remove-me')
		expect(await vault.read('codex:remove-me')).toBeNull()
	})
})
