import { Database } from 'bun:sqlite'
import { lstat, readdir, realpath, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { removeClaudeProfile } from './claude.ts'
import { recordedConfigPaths, restoreConfigBackup } from './config-backup.ts'
import {
	clientConfigPaths,
	uninstallClaudeConfig,
	uninstallCodexConfig,
	uninstallGrokConfig,
	uninstallPiConfig
} from './config-install.ts'
import { ApplicationError } from './errors.ts'
import { type ApplicationPaths, applicationPaths } from './paths.ts'
import { createMacOsKeychainVault, removeMacOsKeychainCredentials } from './vault.ts'

function contains(parent: string, child: string): boolean {
	const path = relative(parent, child)
	return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function removeCredentials(root: string, references: readonly string[]): Promise<void> {
	if (root === applicationPaths({}).root) {
		await removeMacOsKeychainCredentials()
		return
	}
	const vault = createMacOsKeychainVault()
	for (const reference of references) await vault.remove(reference)
}

export async function uninstallTokenmaxx(input: {
	paths: ApplicationPaths
	environment?: NodeJS.ProcessEnv
	stopDaemon: () => Promise<void>
	removeStartup: () => Promise<void>
	removeCredentials?: (references: readonly string[]) => Promise<void>
	removeProfile?: (path: string) => Promise<void>
}): Promise<void> {
	const root = await realpath(input.paths.root).catch(error => {
		if (error.code === 'ENOENT') return resolve(input.paths.root)
		throw error
	})
	if ([homedir(), process.cwd()].some(directory => contains(root, directory))) {
		throw new ApplicationError(
			'UNSAFE_DATA_DIRECTORY',
			'TOKENMAXX_HOME must be a dedicated data directory to uninstall it'
		)
	}
	await input.stopDaemon()
	const profiles = new Set<string>()
	const credentials = new Set<string>()
	if (await Bun.file(input.paths.database).exists()) {
		const database = new Database(input.paths.database, { readonly: true })
		try {
			for (const row of database
				.query<{ payload: string }, []>('SELECT payload FROM accounts')
				.all()) {
				const account = JSON.parse(row.payload) as {
					profilePath?: unknown
					secretReference?: unknown
				}
				if (typeof account.profilePath === 'string') profiles.add(account.profilePath)
				if (typeof account.secretReference === 'string') credentials.add(account.secretReference)
			}
		} finally {
			database.close()
		}
	}
	for (const entry of await readdir(input.paths.claudeProfiles, { withFileTypes: true }).catch(
		error => {
			if (error.code === 'ENOENT') return []
			throw error
		}
	))
		if (entry.isDirectory()) profiles.add(join(input.paths.claudeProfiles, entry.name))
	for (const profile of profiles) {
		const canonical = await realpath(profile).catch(error => {
			if (error.code === 'ENOENT') return resolve(profile)
			throw error
		})
		if (!contains(root, canonical) || canonical === root)
			throw new ApplicationError(
				'UNSAFE_PROFILE_PATH',
				`An account profile is outside TOKENMAXX_HOME: ${profile}`
			)
	}
	for (const path of await recordedConfigPaths(input.paths)) {
		if (!(await restoreConfigBackup(input.paths, path))) await uninstallCodexConfig(input.paths, path)
	}
	const configs = clientConfigPaths(input.environment)
	await uninstallCodexConfig(input.paths, configs.codex)
	await uninstallClaudeConfig(input.paths, configs.claude)
	await uninstallGrokConfig(configs.grok)
	const pi = await uninstallPiConfig(input.paths, configs.pi)
	if (pi.manual !== null)
		throw new ApplicationError('CONFIG_UNINSTALL_FAILED', `${pi.path}: ${pi.manual}`)
	for (const profile of profiles) await (input.removeProfile ?? removeClaudeProfile)(profile)
	await (input.removeCredentials ?? (references => removeCredentials(root, references)))([
		...credentials
	])
	await input.removeStartup()
	for (const path of [
		input.paths.database,
		`${input.paths.database}-wal`,
		`${input.paths.database}-shm`,
		`${input.paths.database}-journal`,
		input.paths.managerSocket,
		input.paths.managerLock,
		join(input.paths.runtime, 'daemon.log'),
		join(input.paths.root, 'preferences.json'),
		join(input.paths.root, 'healed-version'),
		join(input.paths.root, 'config-backups.json')
	])
		await rm(path, { force: true })
	for (const directory of [
		input.paths.claudeProfiles,
		dirname(input.paths.claudeProfiles),
		input.paths.runtime,
		root
	]) {
		await rmdir(directory).catch(error => {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
		})
	}
	if (
		await lstat(input.paths.root).then(
			info => info.isSymbolicLink(),
			() => false
		)
	)
		await rm(input.paths.root)
}
