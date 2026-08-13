import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { type FileHandle, link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { ApplicationError } from './errors.ts'

const ApplicationPathsSchema = z.object({
	credentials: z.string().min(1),
	database: z.string().min(1),
	managerLock: z.string().min(1),
	managerSocket: z.string().min(1),
	proxyPort: z.number().int().positive().max(65_535),
	proxyToken: z.string().min(1),
	root: z.string().min(1),
	runtime: z.string().min(1)
})
export type ApplicationPaths = z.infer<typeof ApplicationPathsSchema>

const defaultProxyPort = 8460
const tokenPattern = /^[A-Za-z0-9_-]{43}$/

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && Reflect.get(error, 'code') === code
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		await mkdir(directory, { mode: 0o700, recursive: true })
	} catch (error) {
		if (!isFileSystemError(error, 'EEXIST')) {
			throw error
		}
	}
	const details = await lstat(directory)
	if (!details.isDirectory() || details.isSymbolicLink()) {
		throw new ApplicationError(
			'APPLICATION_DIRECTORY_INVALID',
			'Quotanaut state paths must be directories, not files or symbolic links'
		)
	}
	const processUserId = process.getuid?.()
	if (processUserId !== undefined && details.uid !== processUserId) {
		throw new ApplicationError(
			'APPLICATION_DIRECTORY_OWNER_INVALID',
			'Quotanaut state paths must be owned by the current user'
		)
	}
	if ((details.mode & 0o777) !== 0o700) {
		throw new ApplicationError(
			'APPLICATION_DIRECTORY_MODE_INVALID',
			'Quotanaut state directories must have mode 0700'
		)
	}
}

export function applicationPaths(environment: NodeJS.ProcessEnv = process.env): ApplicationPaths {
	const configuredHome = environment.QUOTANAUT_HOME
	if (configuredHome !== undefined && configuredHome.trim().length === 0) {
		throw new ApplicationError(
			'APPLICATION_HOME_INVALID',
			'QUOTANAUT_HOME must be a non-empty path'
		)
	}
	const root = resolve(configuredHome ?? join(homedir(), '.quotanaut'))
	const runtime = join(root, 'runtime')
	const proxyPort = Number(environment.QUOTANAUT_PROXY_PORT ?? defaultProxyPort)

	return ApplicationPathsSchema.parse({
		credentials: join(root, 'credentials'),
		database: join(root, 'state.sqlite'),
		managerLock: join(runtime, 'manager.lock'),
		managerSocket: join(runtime, 'manager.sock'),
		proxyPort: Number.isFinite(proxyPort) ? proxyPort : defaultProxyPort,
		proxyToken: join(root, 'proxy-token'),
		root,
		runtime
	})
}

export async function ensureApplicationPaths(paths: ApplicationPaths): Promise<void> {
	const directories = [paths.root, paths.runtime, paths.credentials]
	for (const directory of directories) {
		await ensurePrivateDirectory(directory)
	}
}

function validateProxyTokenFile(details: Stats): void {
	if (!details.isFile() || details.isSymbolicLink()) {
		throw new ApplicationError(
			'PROXY_TOKEN_INVALID',
			'Proxy client capability must be a regular file, not a symbolic link'
		)
	}
	const processUserId = process.getuid?.()
	if (processUserId !== undefined && details.uid !== processUserId) {
		throw new ApplicationError(
			'PROXY_TOKEN_OWNER_INVALID',
			'Proxy client capability must be owned by the current user'
		)
	}
	if ((details.mode & 0o777) !== 0o600) {
		throw new ApplicationError(
			'PROXY_TOKEN_MODE_INVALID',
			'Proxy client capability must have mode 0600'
		)
	}
}

async function readProxyToken(path: string): Promise<string> {
	let handle: FileHandle | null = null
	try {
		try {
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
		} catch (error) {
			if (isFileSystemError(error, 'ELOOP')) {
				throw new ApplicationError(
					'PROXY_TOKEN_INVALID',
					'Proxy client capability must be a regular file, not a symbolic link'
				)
			}
			throw error
		}
		validateProxyTokenFile(await handle.stat())
		const token = (await handle.readFile('utf8')).trim()
		if (!tokenPattern.test(token)) {
			throw new ApplicationError(
				'PROXY_TOKEN_INVALID',
				'Proxy client capability has an invalid format'
			)
		}
		return token
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

export async function readProxyTokenIfPresent(paths: ApplicationPaths): Promise<string | null> {
	try {
		return await readProxyToken(paths.proxyToken)
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return null
		}
		throw error
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

const proxyTokenOperations = new Map<string, Promise<string>>()

async function createOrReadProxyToken(paths: ApplicationPaths): Promise<string> {
	await ensureApplicationPaths(paths)
	try {
		return await readProxyToken(paths.proxyToken)
	} catch (error) {
		if (!isFileSystemError(error, 'ENOENT')) {
			throw error
		}
	}

	const token = randomBytes(32).toString('base64url')
	const temporaryPath = join(paths.root, `.proxy-token-${process.pid}-${crypto.randomUUID()}.tmp`)
	let handle: FileHandle | null = null
	try {
		handle = await open(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600
		)
		await handle.writeFile(`${token}\n`, 'utf8')
		await handle.sync()
		await handle.chmod(0o600)
		await handle.close()
		handle = null
		let created = false
		try {
			await link(temporaryPath, paths.proxyToken)
			created = true
		} catch (error) {
			if (!isFileSystemError(error, 'EEXIST')) {
				throw error
			}
		}
		if (created) {
			await syncDirectory(paths.root)
		}
		return await readProxyToken(paths.proxyToken)
	} finally {
		await handle?.close().catch(() => undefined)
		await unlink(temporaryPath).catch(() => undefined)
	}
}

export function ensureProxyToken(paths: ApplicationPaths): Promise<string> {
	const existing = proxyTokenOperations.get(paths.proxyToken)
	if (existing !== undefined) {
		return existing
	}
	const operation = createOrReadProxyToken(paths).finally(() => {
		if (proxyTokenOperations.get(paths.proxyToken) === operation) {
			proxyTokenOperations.delete(paths.proxyToken)
		}
	})
	proxyTokenOperations.set(paths.proxyToken, operation)
	return operation
}

export function proxyBaseUrl(paths: ApplicationPaths): string {
	return `http://127.0.0.1:${paths.proxyPort}/openai`
}
