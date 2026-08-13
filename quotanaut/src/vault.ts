import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ApplicationError } from './errors.ts'

export interface CredentialVault {
	read(reference: string): Promise<string | null>
	write(reference: string, value: string): Promise<void>
	remove(reference: string): Promise<void>
}

export interface FileSystemCredentialVaultOptions {
	userId?: number
}

const credentialLocks = new Map<string, Promise<void>>()
const filesystemReferencePattern = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,199}$/

export async function exclusive<Result>(
	reference: string,
	operation: () => Promise<Result>
): Promise<Result> {
	const previous = credentialLocks.get(reference) ?? Promise.resolve()
	let release: (() => void) | undefined
	const current = new Promise<void>(resolve => {
		release = resolve
	})
	const queued = previous.then(() => current)
	credentialLocks.set(reference, queued)
	await previous
	try {
		return await operation()
	} finally {
		release?.()
		if (credentialLocks.get(reference) === queued) {
			credentialLocks.delete(reference)
		}
	}
}

export async function exclusiveReferences<Result>(
	references: readonly string[],
	operation: () => Promise<Result>
): Promise<Result> {
	const [reference, ...remaining] = [...new Set(references)].sort()
	if (reference === undefined) {
		return operation()
	}
	return exclusive(reference, () => exclusiveReferences(remaining, operation))
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && Reflect.get(error, 'code') === code
}

function requireSafeFilesystemReference(reference: string): string {
	if (!filesystemReferencePattern.test(reference)) {
		throw new ApplicationError(
			'CREDENTIAL_REFERENCE_INVALID',
			'Credential reference must start with an alphanumeric character and contain only [A-Za-z0-9_.@:-]'
		)
	}
	return reference
}

function assertOwner(details: Stats, expectedUserId: number | undefined, kind: string): void {
	if (expectedUserId !== undefined && details.uid !== expectedUserId) {
		throw new ApplicationError(
			'CREDENTIAL_OWNER_INVALID',
			`${kind} must be owned by the current user`
		)
	}
}

function assertPrivateDirectory(details: Stats, expectedUserId: number | undefined): void {
	if (!details.isDirectory() || details.isSymbolicLink()) {
		throw new ApplicationError(
			'CREDENTIAL_VAULT_ROOT_INVALID',
			'Credential vault root must be a directory, not a file or symbolic link'
		)
	}
	assertOwner(details, expectedUserId, 'Credential vault root')
	if ((details.mode & 0o777) !== 0o700) {
		throw new ApplicationError(
			'CREDENTIAL_VAULT_MODE_INVALID',
			'Credential vault root must have mode 0700'
		)
	}
}

function assertPrivateCredential(details: Stats, expectedUserId: number | undefined): void {
	if (!details.isFile() || details.isSymbolicLink()) {
		throw new ApplicationError(
			'CREDENTIAL_TARGET_INVALID',
			'Credential target must be a regular file, not a symbolic link or another file type'
		)
	}
	assertOwner(details, expectedUserId, 'Credential file')
	if ((details.mode & 0o777) !== 0o600) {
		throw new ApplicationError('CREDENTIAL_MODE_INVALID', 'Credential file must have mode 0600')
	}
}

async function ensurePrivateDirectory(
	directory: string,
	expectedUserId: number | undefined
): Promise<void> {
	try {
		await mkdir(directory, { mode: 0o700, recursive: true })
	} catch (error) {
		if (!isFileSystemError(error, 'EEXIST')) {
			throw error
		}
	}
	assertPrivateDirectory(await lstat(directory), expectedUserId)
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

async function openCredential(
	path: string,
	expectedUserId: number | undefined
): Promise<FileHandle | null> {
	let handle: FileHandle
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return null
		}
		if (isFileSystemError(error, 'ELOOP')) {
			throw new ApplicationError(
				'CREDENTIAL_TARGET_INVALID',
				'Credential target must be a regular file, not a symbolic link or another file type'
			)
		}
		throw error
	}
	try {
		assertPrivateCredential(await handle.stat(), expectedUserId)
		return handle
	} catch (error) {
		await handle.close().catch(() => undefined)
		throw error
	}
}

/**
 * Stores plaintext credentials in a private directory on the local filesystem.
 * Protect the owning user account and do not copy this directory to shared storage.
 */
export function createFileSystemCredentialVault(
	rootDirectory: string,
	options: FileSystemCredentialVaultOptions = {}
): CredentialVault {
	if (rootDirectory.trim().length === 0) {
		throw new ApplicationError(
			'CREDENTIAL_VAULT_ROOT_INVALID',
			'Credential vault root must not be empty'
		)
	}
	const directory = resolve(rootDirectory)
	const expectedUserId = options.userId ?? process.getuid?.()

	function credentialPath(reference: string): string {
		return join(directory, requireSafeFilesystemReference(reference))
	}

	return {
		async read(reference) {
			const path = credentialPath(reference)
			await ensurePrivateDirectory(directory, expectedUserId)
			const handle = await openCredential(path, expectedUserId)
			if (handle === null) {
				return null
			}
			try {
				return await handle.readFile('utf8')
			} finally {
				await handle.close()
			}
		},
		async remove(reference) {
			const path = credentialPath(reference)
			await ensurePrivateDirectory(directory, expectedUserId)
			const handle = await openCredential(path, expectedUserId)
			if (handle === null) {
				return
			}
			try {
				// unlink removes the directory entry itself. If the path is swapped for a
				// symbolic link after validation, it removes that link and never follows it.
				await unlink(path)
				await syncDirectory(directory)
			} finally {
				await handle.close()
			}
		},
		async write(reference, value) {
			const path = credentialPath(reference)
			await ensurePrivateDirectory(directory, expectedUserId)
			const existing = await openCredential(path, expectedUserId)
			await existing?.close()

			const temporaryPath = join(directory, `.credential-${process.pid}-${crypto.randomUUID()}.tmp`)
			let handle: FileHandle | null = null
			try {
				handle = await open(
					temporaryPath,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600
				)
				await handle.writeFile(value, 'utf8')
				await handle.sync()
				assertPrivateCredential(await handle.stat(), expectedUserId)
				await handle.close()
				handle = null
				await rename(temporaryPath, path)
				await syncDirectory(directory)
			} finally {
				await handle?.close().catch(() => undefined)
				await unlink(temporaryPath).catch(() => undefined)
			}
		}
	}
}
