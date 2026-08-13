import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationPaths, ensureApplicationPaths, ensureProxyToken } from './paths.ts'

const temporaryDirectories: string[] = []

async function temporaryHome(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'quotanaut-paths-test-'))
	temporaryDirectories.push(directory)
	return directory
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
	)
})

describe('application paths', () => {
	test('uses isolated Quotanaut names and the Linux proxy port', async () => {
		const home = await temporaryHome()
		const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })

		expect(paths.root).toBe(join(home, 'state'))
		expect(paths.credentials).toBe(join(home, 'state', 'credentials'))
		expect(paths.proxyToken).toBe(join(home, 'state', 'proxy-token'))
		expect(paths.proxyPort).toBe(8460)
	})

	test('uses only QUOTANAUT environment overrides', async () => {
		const home = await temporaryHome()
		const paths = applicationPaths({
			QUOTANAUT_HOME: join(home, 'quotanaut'),
			QUOTANAUT_PROXY_PORT: '9001',
			TOKENMAXX_HOME: join(home, 'tokenmaxx'),
			TOKENMAXX_PROXY_PORT: '9002'
		})

		expect(paths.root).toBe(join(home, 'quotanaut'))
		expect(paths.proxyPort).toBe(9001)
	})

	test('rejects an empty QUOTANAUT_HOME instead of resolving it to the working directory', () => {
		expect(() => applicationPaths({ QUOTANAUT_HOME: ' \t\n' })).toThrow(
			expect.objectContaining({ code: 'APPLICATION_HOME_INVALID' })
		)
	})

	test('creates private state directories', async () => {
		const home = await temporaryHome()
		const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })

		await ensureApplicationPaths(paths)

		for (const directory of [paths.root, paths.runtime, paths.credentials]) {
			expect((await lstat(directory)).mode & 0o777).toBe(0o700)
		}
	})

	test('rejects an unsafe pre-existing state directory without changing its mode', async () => {
		const home = await temporaryHome()
		const root = join(home, 'state')
		await mkdir(root, { mode: 0o755 })
		await chmod(root, 0o755)
		const paths = applicationPaths({ QUOTANAUT_HOME: root })

		await expect(ensureApplicationPaths(paths)).rejects.toMatchObject({
			code: 'APPLICATION_DIRECTORY_MODE_INVALID'
		})
		expect((await lstat(root)).mode & 0o777).toBe(0o755)
	})

	test('rejects a symbolic-link state directory', async () => {
		const home = await temporaryHome()
		const target = join(home, 'target')
		await Bun.write(target, '')
		const root = join(home, 'state')
		await symlink(target, root)
		const paths = applicationPaths({ QUOTANAUT_HOME: root })

		await expect(ensureApplicationPaths(paths)).rejects.toMatchObject({
			code: 'APPLICATION_DIRECTORY_INVALID'
		})
	})
})

describe('proxy client capability', () => {
	test('creates one persistent private random token', async () => {
		const home = await temporaryHome()
		const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })

		const [first, second] = await Promise.all([ensureProxyToken(paths), ensureProxyToken(paths)])

		expect(first).toBe(second)
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect((await lstat(paths.proxyToken)).mode & 0o777).toBe(0o600)
		expect((await readFile(paths.proxyToken, 'utf8')).trim()).toBe(first)
	})

	test('rejects permissive token files instead of silently accepting them', async () => {
		const home = await temporaryHome()
		const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })
		await ensureApplicationPaths(paths)
		await writeFile(paths.proxyToken, 'a'.repeat(43), { mode: 0o600 })
		await chmod(paths.proxyToken, 0o644)

		await expect(ensureProxyToken(paths)).rejects.toMatchObject({
			code: 'PROXY_TOKEN_MODE_INVALID'
		})
	})

	test('rejects symbolic-link token files without reading their target', async () => {
		const home = await temporaryHome()
		const paths = applicationPaths({ QUOTANAUT_HOME: join(home, 'state') })
		await ensureApplicationPaths(paths)
		const target = join(home, 'target')
		await writeFile(target, 'a'.repeat(43), { mode: 0o600 })
		await symlink(target, paths.proxyToken)

		await expect(ensureProxyToken(paths)).rejects.toMatchObject({
			code: 'PROXY_TOKEN_INVALID'
		})
	})
})
