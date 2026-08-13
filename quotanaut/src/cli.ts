import { spawn } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'
import { type FileHandle, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
	type PreparedCodexAuthImport,
	prepareCodexAuthImport,
	registerCodexAccount
} from './codex.ts'
import { installCodexConfig, installStatus, uninstallCodexConfig } from './config-install.ts'
import type { Account } from './domain.ts'
import { ApplicationError, errorMessage } from './errors.ts'
import {
	managerAvailable,
	managerRequest,
	managerVersion,
	readDashboard,
	readProxyPort,
	requestAccountRemove,
	requestAccountSave,
	requestSwitch,
	startManagerServer
} from './ipc.ts'
import { AccountManager } from './manager.ts'
import { type ApplicationPaths, applicationPaths, ensureApplicationPaths } from './paths.ts'
import { proxyIdentity } from './proxy.ts'
import { createStateStore, type StateStore } from './storage.ts'
import { createFileSystemCredentialVault } from './vault.ts'
import { VERSION } from './version.ts'

const DaemonLockSchema = z
	.object({
		createdAt: z.iso.datetime(),
		ownerId: z.uuid(),
		processId: z.number().int().positive()
	})
	.strict()

interface DaemonLock {
	release(): Promise<void>
}

interface ApplicationContext {
	paths: ApplicationPaths
	store: StateStore
}

const maximumImportBytes = 1024 * 1024

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && Reflect.get(error, 'code') === code
}

async function readLock(lockPath: string): Promise<z.infer<typeof DaemonLockSchema> | null> {
	try {
		return DaemonLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')))
	} catch {
		return null
	}
}

async function ownedLock(lockPath: string, fileHandle: FileHandle): Promise<DaemonLock> {
	const owner = DaemonLockSchema.parse({
		createdAt: new Date().toISOString(),
		ownerId: crypto.randomUUID(),
		processId: process.pid
	})
	await fileHandle.writeFile(JSON.stringify(owner), 'utf8')
	await fileHandle.sync()
	let released = false
	return {
		async release() {
			if (released) {
				return
			}
			released = true
			await fileHandle.close()
			const current = await readLock(lockPath)
			if (current?.ownerId === owner.ownerId) {
				await rm(lockPath, { force: true })
			}
		}
	}
}

async function acquireDaemonLock(lockPath: string): Promise<DaemonLock> {
	try {
		return await ownedLock(lockPath, await open(lockPath, 'wx', 0o600))
	} catch (error) {
		if (!isFileSystemError(error, 'EEXIST')) {
			throw error
		}
		throw new ApplicationError(
			'DAEMON_LOCKED',
			`Manager lock already exists at ${lockPath}. If no manager answers, run quotanaut daemon stop to remove stale artifacts.`
		)
	}
}

async function linuxProcessExists(processId: number): Promise<boolean> {
	if (process.platform !== 'linux') {
		return true
	}
	return stat(`/proc/${processId}`).then(
		() => true,
		error => {
			if (isFileSystemError(error, 'ENOENT')) {
				return false
			}
			throw error
		}
	)
}

async function commandOutput(command: readonly string[]): Promise<string> {
	const handle = Bun.spawn([...command], { stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' })
	const [stdout, stderr] = await Promise.all([
		new Response(handle.stdout).text(),
		new Response(handle.stderr).text()
	])
	await handle.exited
	return stdout.trim() || stderr.trim()
}

async function assertProxyPortAvailable(port: number): Promise<void> {
	const identity = await proxyIdentity(port)
	if (identity === null) {
		return
	}
	throw new ApplicationError(
		'PROXY_PORT_IN_USE',
		`Port ${port} is already in use by ${identity === 'quotanaut' ? 'a Quotanaut proxy that does not answer manager IPC' : 'another program'}. Stop that listener or set QUOTANAUT_PROXY_PORT.`
	)
}

function option(arguments_: readonly string[], name: string): string | undefined {
	const equals = arguments_.find(argument => argument.startsWith(`${name}=`))
	if (equals !== undefined) {
		return equals.slice(name.length + 1)
	}
	const index = arguments_.indexOf(name)
	return index < 0 ? undefined : arguments_[index + 1]
}

export function help(): string {
	return `Quotanaut — live account switching for Codex on Linux

Usage:
  quotanaut login
  quotanaut import <auth.json>...
  quotanaut switch <email-or-id>
  quotanaut logout <email-or-id>
  quotanaut auto <on|off> [--threshold N]
  quotanaut install
  quotanaut uninstall
  quotanaut list
  quotanaut status
  quotanaut refresh
  quotanaut doctor
  quotanaut daemon <start|stop|status>

Quotanaut selects a credential for every request. A switch affects the next
request without restarting Codex. With auto-switching enabled, quota pressure
can rotate accounts and a hard-limited request can be retried before streaming.

Environment: QUOTANAUT_HOME, QUOTANAUT_PROXY_PORT`
}

async function createContext(
	paths: ApplicationPaths = applicationPaths()
): Promise<ApplicationContext> {
	await ensureApplicationPaths(paths)
	return { paths, store: createStateStore(paths.database) }
}

async function runDaemon(context: ApplicationContext): Promise<void> {
	try {
		process.chdir(homedir())
	} catch {}
	process.on('unhandledRejection', reason => {
		process.stderr.write(
			`[${new Date().toISOString()}] unhandled rejection: ${errorMessage(reason)}\n`
		)
	})
	process.on('uncaughtException', error => {
		process.stderr.write(
			`[${new Date().toISOString()}] uncaught exception: ${errorMessage(error)}\n`
		)
	})
	const lock = await acquireDaemonLock(context.paths.managerLock)
	try {
		if (await managerAvailable(context.paths.managerSocket)) {
			throw new ApplicationError('DAEMON_RUNNING', 'The manager daemon is already running')
		}
		const manager = new AccountManager({
			paths: context.paths,
			store: context.store,
			vault: createFileSystemCredentialVault(context.paths.credentials)
		})
		await manager.start()
		try {
			let requestStop: (() => void) | undefined
			const stopped = new Promise<void>(resolve => {
				requestStop = resolve
			})
			const beginShutdown = () => {
				requestStop?.()
			}
			const server = await startManagerServer({
				manager,
				onStop: beginShutdown,
				socketPath: context.paths.managerSocket
			})
			process.once('SIGINT', beginShutdown)
			process.once('SIGTERM', beginShutdown)
			await stopped
			await server.close()
		} finally {
			await manager.stop()
		}
	} finally {
		await lock.release()
	}
}

async function startDaemon(context: ApplicationContext): Promise<void> {
	if (await managerAvailable(context.paths.managerSocket)) {
		return
	}
	await assertProxyPortAvailable(context.paths.proxyPort)
	await mkdir(context.paths.runtime, { mode: 0o700, recursive: true })
	const entrypoint = process.argv[1]
	if (entrypoint === undefined) {
		throw new ApplicationError('ENTRYPOINT_MISSING', 'Cannot locate the CLI entrypoint')
	}
	const logPath = join(context.paths.runtime, 'daemon.log')
	const logDescriptor = openSync(logPath, 'a', 0o600)
	try {
		const child = spawn(process.execPath, [entrypoint, 'daemon', 'run'], {
			detached: true,
			env: process.env,
			stdio: ['ignore', logDescriptor, logDescriptor]
		})
		child.unref()
		const deadline = Date.now() + 8_000
		while (Date.now() < deadline) {
			if (await managerAvailable(context.paths.managerSocket)) {
				return
			}
			if (child.exitCode !== null) {
				break
			}
			await Bun.sleep(100)
		}
		const lastError = await readFile(logPath, 'utf8')
			.then(log => log.trim().split('\n').at(-1) ?? '')
			.catch(() => '')
		throw new ApplicationError(
			'DAEMON_START_FAILED',
			`Manager did not start${lastError === '' ? '' : ` — ${lastError.replace(/^quotanaut: /, '')}`}\n` +
				`Run quotanaut doctor or inspect ${logPath}. Restore direct Codex routing with quotanaut uninstall.`
		)
	} finally {
		closeSync(logDescriptor)
	}
}

export async function removeStaleDaemonArtifacts(
	paths: ApplicationPaths,
	processExists: (processId: number) => Promise<boolean> = linuxProcessExists
): Promise<void> {
	const existing = await readLock(paths.managerLock)
	if (existing !== null) {
		if (await processExists(existing.processId)) {
			throw new ApplicationError(
				'DAEMON_NOT_REACHABLE',
				`Manager process ${existing.processId} still exists but its socket does not answer. Quotanaut kept its lock and did not stop the process.`
			)
		}
		const unchanged = await readLock(paths.managerLock)
		if (unchanged?.ownerId !== existing.ownerId) {
			throw new ApplicationError(
				'DAEMON_LOCK_CHANGED',
				'Manager lock changed while stale state was checked; Quotanaut kept all artifacts'
			)
		}
		await rm(paths.managerLock)
	} else {
		const lockExists = await stat(paths.managerLock).then(
			() => true,
			error => {
				if (isFileSystemError(error, 'ENOENT')) {
					return false
				}
				throw error
			}
		)
		if (lockExists) {
			throw new ApplicationError(
				'DAEMON_LOCK_INVALID',
				'Manager lock exists but its metadata is invalid; Quotanaut kept all artifacts'
			)
		}
	}

	const cleanupLock = await acquireDaemonLock(paths.managerLock)
	try {
		await rm(paths.managerSocket, { force: true })
	} finally {
		await cleanupLock.release()
	}
}

async function stopDaemon(context: ApplicationContext): Promise<void> {
	if (!(await managerAvailable(context.paths.managerSocket))) {
		await removeStaleDaemonArtifacts(context.paths)
		process.stdout.write(
			'Manager daemon is not reachable; removed stale lock and socket artifacts.\n'
		)
		return
	}
	await managerRequest({
		method: 'manager/stop',
		schema: z.unknown(),
		socketPath: context.paths.managerSocket,
		timeoutMilliseconds: 1_000
	}).catch(() => undefined)
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		const running = await managerAvailable(context.paths.managerSocket)
		const lockHeld = await stat(context.paths.managerLock).then(
			() => true,
			() => false
		)
		if (!running && !lockHeld) {
			process.stdout.write('Manager daemon stopped.\n')
			return
		}
		await Bun.sleep(200)
	}
	throw new ApplicationError(
		'DAEMON_STOP_TIMEOUT',
		'Manager did not stop after 25 seconds. Quotanaut did not kill its process; inspect the daemon log and process state.'
	)
}

async function ensureDaemon(context: ApplicationContext): Promise<void> {
	if (!(await managerAvailable(context.paths.managerSocket))) {
		await startDaemon(context)
		return
	}
	const runningVersion = await managerVersion(context.paths.managerSocket)
	if (runningVersion !== null && runningVersion !== VERSION) {
		process.stdout.write(`Updating manager daemon (${runningVersion} → ${VERSION})…\n`)
		await stopDaemon(context)
		await startDaemon(context)
	}
}

function assertCodexInstalled(): void {
	if (Bun.which('codex') === null) {
		throw new ApplicationError(
			'CLI_MISSING',
			'codex is not installed — run: npm install -g @openai/codex'
		)
	}
}

async function login(context: ApplicationContext): Promise<void> {
	assertCodexInstalled()
	await ensureDaemon(context)
	const authenticated = await registerCodexAccount()
	const saved = await requestAccountSave(context.paths.managerSocket, authenticated.serializedAuth)
	process.stdout.write(`Signed in ${saved.label}; live sessions use it on their next request.\n`)
	if (!(await installStatus(context.paths)).codexRouted) {
		await installCodexConfig(context.paths)
		process.stdout.write('Codex now routes through Quotanaut.\n')
	}
}

export interface PreparedImport extends PreparedCodexAuthImport {
	path: string
}

export interface CodexAuthImportDependencies {
	onImported(account: Account): void
	onRefreshFailure(): void
	refreshUsage(): Promise<void>
	saveAccount(serializedAuth: string): Promise<Account>
}

function pathContains(parent: string, candidate: string): boolean {
	const child = relative(parent, candidate)
	return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

async function canonicalPathIfPresent(path: string): Promise<string> {
	try {
		return await realpath(path)
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return resolve(path)
		}
		throw error
	}
}

async function readBoundedFile(handle: FileHandle, path: string): Promise<string> {
	const buffer = Buffer.allocUnsafe(maximumImportBytes + 1)
	let bytesRead = 0
	while (bytesRead < buffer.length) {
		const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
		if (result.bytesRead === 0) {
			break
		}
		bytesRead += result.bytesRead
	}
	if (bytesRead > maximumImportBytes) {
		throw new ApplicationError(
			'IMPORT_SOURCE_TOO_LARGE',
			`Import source ${path} exceeds the 1 MiB limit`
		)
	}
	return buffer.subarray(0, bytesRead).toString('utf8')
}

async function readImportSource(
	path: string,
	credentialsDirectory: string,
	expectedUserId: number | undefined = process.getuid?.()
): Promise<string> {
	let handle: FileHandle | null = null
	try {
		try {
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		} catch (error) {
			if (isFileSystemError(error, 'ELOOP')) {
				throw new ApplicationError(
					'IMPORT_SOURCE_INVALID',
					`Import source ${path} must be a regular file, not a symbolic link`
				)
			}
			throw error
		}
		const details = await handle.stat()
		if (!details.isFile() || details.isSymbolicLink()) {
			throw new ApplicationError(
				'IMPORT_SOURCE_INVALID',
				`Import source ${path} must be a regular file, not a symbolic link`
			)
		}
		if (expectedUserId !== undefined && details.uid !== expectedUserId) {
			throw new ApplicationError(
				'IMPORT_SOURCE_OWNER_INVALID',
				`Import source ${path} must be owned by the current user`
			)
		}
		if ((details.mode & 0o077) !== 0) {
			throw new ApplicationError(
				'IMPORT_SOURCE_MODE_INVALID',
				`Import source ${path} must not grant permissions to group or other users`
			)
		}
		if (details.size > maximumImportBytes) {
			throw new ApplicationError(
				'IMPORT_SOURCE_TOO_LARGE',
				`Import source ${path} exceeds the 1 MiB limit`
			)
		}
		const [sourcePath, credentialPath] = await Promise.all([
			realpath(path),
			canonicalPathIfPresent(credentialsDirectory)
		])
		if (pathContains(credentialPath, sourcePath)) {
			throw new ApplicationError(
				'IMPORT_SOURCE_MANAGED',
				`Import source ${path} is inside the Quotanaut credential directory`
			)
		}
		return await readBoundedFile(handle, path)
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

export async function prepareCodexAuthImports(
	paths: ApplicationPaths,
	sourcePaths: readonly string[]
): Promise<PreparedImport[]> {
	if (sourcePaths.length === 0) {
		throw new ApplicationError('USAGE', 'Usage: quotanaut import <auth.json>...')
	}
	const prepared = await Promise.all(
		sourcePaths.map(async sourcePath => {
			const path = resolve(sourcePath)
			return {
				...prepareCodexAuthImport(await readImportSource(path, paths.credentials)),
				path
			}
		})
	)
	const identities = new Set<string>()
	for (const item of prepared) {
		const key = `${item.account.externalAccountId ?? ''}\0${item.account.externalUserId ?? ''}`
		if (identities.has(key)) {
			throw new ApplicationError(
				'DUPLICATE_IMPORT_IDENTITY',
				`Import batch contains the same Codex identity more than once: ${item.account.identity}`
			)
		}
		identities.add(key)
	}
	return prepared
}

export async function applyCodexAuthImports(
	prepared: readonly PreparedImport[],
	dependencies: CodexAuthImportDependencies
): Promise<Account[]> {
	const imported: Account[] = []
	try {
		for (const item of prepared) {
			let account: Account
			try {
				account = await dependencies.saveAccount(item.serializedAuth)
			} catch (error) {
				if (imported.length === 0) {
					throw error
				}
				throw new ApplicationError(
					'IMPORT_PARTIAL_FAILURE',
					`Imported ${imported.length} of ${prepared.length} Codex accounts before the batch stopped. Rerun the same command; Quotanaut safely updates identities that were already imported.`,
					{ cause: error instanceof Error ? error : undefined }
				)
			}
			imported.push(account)
			dependencies.onImported(account)
		}
	} finally {
		if (imported.length > 0) {
			try {
				await dependencies.refreshUsage()
			} catch {
				dependencies.onRefreshFailure()
			}
		}
	}
	return imported
}

async function importCodexAuth(
	context: ApplicationContext,
	prepared: readonly PreparedImport[]
): Promise<void> {
	await ensureDaemon(context)
	const imported = await applyCodexAuthImports(prepared, {
		onImported: account => {
			process.stdout.write(`Imported ${account.identity}.\n`)
		},
		onRefreshFailure: () => {
			process.stderr.write(
				'Imported credentials, but usage refresh did not complete. Run quotanaut refresh before quotanaut auto on.\n'
			)
		},
		refreshUsage: () =>
			managerRequest({
				method: 'usage/refresh',
				schema: z.unknown(),
				socketPath: context.paths.managerSocket,
				timeoutMilliseconds: 60_000
			}).then(() => undefined),
		saveAccount: serializedAuth => requestAccountSave(context.paths.managerSocket, serializedAuth)
	})
	process.stdout.write(
		`Imported ${imported.length} Codex account${imported.length === 1 ? '' : 's'}.\n`
	)
}

function resolveAccount(context: ApplicationContext, reference: string): Account {
	const matches = context.store
		.listAccounts('openai')
		.filter(account => account.id === reference || account.label === reference)
	if (matches.length !== 1 || matches[0] === undefined) {
		throw new ApplicationError('ACCOUNT_NOT_FOUND', `Could not uniquely resolve ${reference}`)
	}
	return matches[0]
}

const healthText: Record<Account['health'], string> = {
	disabled: 'disabled',
	loginExpiring: 'login expiring soon',
	ready: 'ready',
	reauthenticationRequired: 'login required — quotanaut login',
	refreshDue: 'refreshing',
	refreshing: 'refreshing',
	scopeMissing: 'missing a scope',
	temporarilyUnreachable: 'provider unreachable',
	unchecked: 'checking',
	usageRateLimited: 'rate-limited'
}

function listAccounts(context: ApplicationContext): void {
	const accounts = context.store.listAccounts('openai')
	if (accounts.length === 0) {
		process.stdout.write('No accounts yet. Sign in with: quotanaut login\n')
		return
	}
	const state = context.store.findProviderState('openai')
	const usage = new Map(context.store.listUsage().map(snapshot => [snapshot.accountId, snapshot]))
	const width = Math.max(...accounts.map(account => account.label.length))
	for (const account of accounts) {
		const pressure = usage
			.get(account.id)
			?.windows.filter(window => window.kind === 'hard')
			.reduce((highest, window) => Math.max(highest, window.usedPercent), 0)
		const pressureText = pressure === undefined ? 'no usage' : `${Math.round(pressure)}% used`
		process.stdout.write(
			`${state.activeAccountId === account.id ? '●' : ' '} ${account.label.padEnd(width)}  ${healthText[account.health]}  ${pressureText}\n`
		)
	}
}

async function logout(context: ApplicationContext, reference: string | undefined): Promise<void> {
	if (reference === undefined) {
		throw new ApplicationError('USAGE', 'Usage: quotanaut logout <email-or-id>')
	}
	const account = resolveAccount(context, reference)
	await ensureDaemon(context)
	await requestAccountRemove(context.paths.managerSocket, account.id)
	process.stdout.write(`Signed out ${account.label}; its credential file was deleted.\n`)
}

async function switchAccount(
	context: ApplicationContext,
	reference: string | undefined
): Promise<void> {
	if (reference === undefined) {
		throw new ApplicationError('USAGE', 'Usage: quotanaut switch <email-or-id>')
	}
	const account = resolveAccount(context, reference)
	await ensureDaemon(context)
	await requestSwitch(context.paths.managerSocket, 'openai', account.id)
	process.stdout.write(`Switched live Codex requests to ${account.label}.\n`)
}

async function configureAutomation(
	context: ApplicationContext,
	arguments_: readonly string[]
): Promise<void> {
	const mode = arguments_[0]
	if (mode !== 'on' && mode !== 'off') {
		throw new ApplicationError('USAGE', 'Usage: quotanaut auto <on|off> [--threshold N]')
	}
	const thresholdValue = option(arguments_, '--threshold')
	const thresholdPercent = thresholdValue === undefined ? undefined : Number(thresholdValue)
	if (
		thresholdPercent !== undefined &&
		(!Number.isFinite(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100)
	) {
		throw new ApplicationError('USAGE', '--threshold takes a percentage from 1 to 100')
	}
	await ensureDaemon(context)
	const result = await managerRequest({
		method: 'policy/set',
		params: {
			authorizationConfirmed: mode === 'on',
			enabled: mode === 'on',
			provider: 'openai',
			thresholdPercent
		},
		schema: z.object({ policy: z.object({ thresholdPercent: z.number() }) }),
		socketPath: context.paths.managerSocket
	})
	process.stdout.write(
		mode === 'on'
			? `Auto-switching is on at ${result.policy.thresholdPercent}% pressure.\n`
			: 'Auto-switching is off.\n'
	)
}

async function installConfig(context: ApplicationContext): Promise<void> {
	await ensureDaemon(context)
	await installCodexConfig(context.paths)
	process.stdout.write(
		'Codex now routes through Quotanaut. Account changes apply on the next request.\n' +
			'Restore direct Codex routing with: quotanaut uninstall\n'
	)
}

async function uninstallConfig(): Promise<void> {
	const path = await uninstallCodexConfig()
	process.stdout.write(
		path === null
			? 'Quotanaut was not installed in the Codex config.\n'
			: 'Restored the previous Codex config. Codex no longer routes through Quotanaut.\n'
	)
}

async function doctor(context: ApplicationContext): Promise<void> {
	for (const tool of ['bun', 'codex'] as const) {
		if (Bun.which(tool) === null) {
			process.stdout.write(`missing  ${tool}\n`)
			continue
		}
		process.stdout.write(`ok       ${tool.padEnd(8)} ${await commandOutput([tool, '--version'])}\n`)
	}
	const running = await managerAvailable(context.paths.managerSocket)
	const identity = running ? null : await proxyIdentity(context.paths.proxyPort)
	process.stdout.write(
		`${running ? 'running' : identity === 'quotanaut' ? 'warning' : 'stopped'}  manager daemon\n`
	)
	if (running) {
		const port = await readProxyPort(context.paths.managerSocket).catch(() => null)
		process.stdout.write(
			`${port === null ? 'warning' : 'ok     '}  proxy    ${port === null ? 'not listening' : `127.0.0.1:${port}`}\n`
		)
	}
	const routing = await installStatus(context.paths)
	process.stdout.write(
		`${routing.codexRouted ? 'ok     ' : 'note   '}  codex    ${
			routing.codexRouted
				? 'config.toml selects the authenticated Quotanaut provider'
				: routing.codexStale
					? 'managed config is incomplete — run quotanaut install'
					: 'not routed — run quotanaut install'
		}\n`
	)
	process.stdout.write(`state     ${context.paths.database}\n`)
	process.stdout.write(
		'warning   Codex credentials are plaintext files protected by your user account and mode 0600.\n'
	)
}

export async function runCli(rawArguments: readonly string[]): Promise<number> {
	const arguments_ = z.array(z.string()).parse(rawArguments)
	const command = arguments_[0]
	if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(`${help()}\n`)
		return 0
	}
	if (command === 'uninstall') {
		if (arguments_.length !== 1) {
			throw new ApplicationError('USAGE', 'Usage: quotanaut uninstall')
		}
		await uninstallConfig()
		return 0
	}
	const paths = applicationPaths()
	const preparedImports =
		command === 'import' ? await prepareCodexAuthImports(paths, arguments_.slice(1)) : null
	const context = await createContext(paths)
	try {
		switch (command) {
			case 'login': {
				if (arguments_.length !== 1) {
					throw new ApplicationError('USAGE', 'Usage: quotanaut login')
				}
				await login(context)
				return 0
			}
			case 'import':
				await importCodexAuth(context, preparedImports ?? [])
				return 0
			case 'switch':
				await switchAccount(context, arguments_[1])
				return 0
			case 'logout':
				await logout(context, arguments_[1])
				return 0
			case 'auto':
				await configureAutomation(context, arguments_.slice(1))
				return 0
			case 'install':
				await installConfig(context)
				return 0
			case 'list':
				listAccounts(context)
				return 0
			case 'status':
				await ensureDaemon(context)
				process.stdout.write(
					`${JSON.stringify(await readDashboard(context.paths.managerSocket), null, 2)}\n`
				)
				return 0
			case 'refresh':
				await ensureDaemon(context)
				await managerRequest({
					method: 'usage/refresh',
					schema: z.unknown(),
					socketPath: context.paths.managerSocket,
					timeoutMilliseconds: 60_000
				})
				process.stdout.write('Refreshed usage for every account.\n')
				return 0
			case 'doctor':
				await doctor(context)
				return 0
			case 'daemon':
				switch (arguments_[1]) {
					case 'run':
						await runDaemon(context)
						return 0
					case 'start':
						await startDaemon(context)
						process.stdout.write('Manager daemon is running.\n')
						return 0
					case 'stop':
						await stopDaemon(context)
						return 0
					case 'status':
						process.stdout.write(
							`${(await managerAvailable(context.paths.managerSocket)) ? 'running' : 'stopped'}\n`
						)
						return 0
					default:
						throw new ApplicationError('USAGE', 'Usage: quotanaut daemon <start|stop|status>')
				}
			default:
				throw new ApplicationError(
					'UNKNOWN_COMMAND',
					`Unknown command ${command}. Run quotanaut --help.`
				)
		}
	} finally {
		context.store.close()
	}
}
