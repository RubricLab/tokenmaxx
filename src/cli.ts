import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { type FileHandle, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { z } from 'zod'
import { registerClaudeAccount } from './claude.ts'
import { registerCodexAccount } from './codex.ts'
import {
	healInstalledConfigs,
	installPiConfig,
	installProviderConfig,
	installStatus,
	piStatus,
	uninstallPiConfig,
	uninstallProviderConfig
} from './config-install.ts'
import { type Account, PROVIDERS, type ProviderId, ProviderIdSchema } from './domain.ts'
import { ApplicationError, errorMessage } from './errors.ts'
import { registerGrokAccount } from './grok.ts'
import {
	managerAvailable,
	managerRequest,
	managerVersion,
	readDashboard,
	readProxyPort,
	readRouting,
	requestAccountOrder,
	requestAccountRemove,
	requestAccountSave,
	requestAddApiKey,
	requestRouting,
	requestSwitch,
	startManagerServer
} from './ipc.ts'
import { LaunchAgent } from './launch-agent.ts'
import { AccountManager } from './manager.ts'
import { removeGlobalPackage } from './package-uninstall.ts'
import { type ApplicationPaths, applicationPaths, ensureApplicationPaths } from './paths.ts'
import { proxyIdentity } from './proxy.ts'
import { orderRank } from './selection.ts'
import { createStateStore, type StateStore } from './storage.ts'
import { renderDashboard } from './ui.ts'
import { uninstallTokenmaxx } from './uninstall.ts'
import { createMacOsKeychainVault } from './vault.ts'
import { availableUpdate, compiledBinary, installedVersion, VERSION } from './version.ts'

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

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && 'code' in error && Reflect.get(error, 'code') === 'EEXIST'
}

function processExists(processId: number): boolean {
	try {
		process.kill(processId, 0)
		return true
	} catch (error) {
		return error instanceof Error && 'code' in error && Reflect.get(error, 'code') !== 'ESRCH'
	}
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
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await ownedLock(lockPath, await open(lockPath, 'wx', 0o600))
		} catch (error) {
			if (!isAlreadyExists(error)) {
				throw error
			}
			const existing = await readLock(lockPath)
			if (existing === null) {
				throw new ApplicationError(
					'DAEMON_LOCKED',
					'Manager startup lock exists but has incomplete metadata; remove it only after confirming no manager is starting'
				)
			}
			if (processExists(existing.processId)) {
				throw new ApplicationError(
					'DAEMON_LOCKED',
					`Manager startup is already owned by process ${existing.processId}`
				)
			}
			const unchanged = await readLock(lockPath)
			if (unchanged?.ownerId === existing.ownerId) {
				await rm(lockPath, { force: true })
			}
		}
	}
	throw new ApplicationError('DAEMON_LOCKED', 'Could not acquire the manager startup lock')
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

async function portOwnerProcessId(port: number): Promise<number | null> {
	const output = await commandOutput(['lsof', '-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
	const processId = Number(output.split('\n')[0])
	return Number.isInteger(processId) && processId > 0 ? processId : null
}

async function portFreed(port: number, deadlineMilliseconds: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMilliseconds
	while ((await proxyIdentity(port)) !== null) {
		if (Date.now() > deadline) {
			return false
		}
		await Bun.sleep(200)
	}
	return true
}

async function replacePortOccupant(port: number): Promise<void> {
	const identity = await proxyIdentity(port)
	if (identity === null) {
		return
	}
	const processId = await portOwnerProcessId(port)
	if (identity === 'foreign' || processId === null) {
		throw new ApplicationError(
			'PROXY_PORT_IN_USE',
			`Port ${port} is in use by another program${processId === null ? '' : ` (process ${processId})`}; stop it or set TOKENMAXX_PROXY_PORT`
		)
	}
	process.stdout.write(
		`Replacing an unreachable tokenmaxx daemon (process ${processId}) holding port ${port}…\n`
	)
	try {
		process.kill(processId, 'SIGTERM')
	} catch {}
	if (await portFreed(port, 5_000)) {
		return
	}
	try {
		process.kill(processId, 'SIGKILL')
	} catch {}
	if (await portFreed(port, 2_000)) {
		return
	}
	throw new ApplicationError(
		'PROXY_PORT_IN_USE',
		`Port ${port} is still held by process ${processId}`
	)
}

const CommandSchema = z.array(z.string())
const EmptyResultSchema = z.unknown()

interface ApplicationContext {
	paths: ApplicationPaths
	store: StateStore
	launchAgent: LaunchAgent
}

const cliWords = '<codex|claude|grok>'

function providerFromCli(value: string): ProviderId {
	switch (value) {
		case 'codex':
		case 'openai':
			return 'openai'
		case 'claude':
		case 'anthropic':
			return 'anthropic'
		case 'grok':
		case 'xai':
			return 'xai'
		default:
			throw new ApplicationError(
				'INVALID_PROVIDER',
				`Expected codex, claude or grok, received ${value}`
			)
	}
}

function option(arguments_: readonly string[], name: string): string | undefined {
	const equals = arguments_.find(argument => argument.startsWith(`${name}=`))
	if (equals !== undefined) {
		return equals.slice(name.length + 1)
	}
	const index = arguments_.indexOf(name)
	return index < 0 ? undefined : arguments_[index + 1]
}

function help(): string {
	const color =
		process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
	const sgr = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)
	const accent = (text: string) => sgr('38;2;90;176;255', text)
	const dim = (text: string) => sgr('38;2;139;147;161', text)
	const head = (text: string) => sgr('1', text)
	const field = 32
	const gutter = ' '.repeat(field + 2)
	const row = (name: string, ...lines: string[]): string => {
		if (name.length <= field - 1) {
			const [first = '', ...rest] = lines
			const head1 = `  ${accent(name)}${' '.repeat(field - name.length)}${dim(first)}`
			return [head1, ...rest.map(line => `${gutter}${dim(line)}`)].join('\n')
		}
		return [`  ${accent(name)}`, ...lines.map(line => `${gutter}${dim(line)}`)].join('\n')
	}
	return [
		`${accent('tokenmaxx')} ${dim('— switch between your own Codex, Claude Code and Grok accounts')}`,
		'',
		`${head('Usage')}  tokenmaxx <command> [options]        ${dim('run with no command for the dashboard')}`,
		'',
		head('Setup'),
		row(
			`login ${cliWords}`,
			'sign in an account · re-run to re-auth',
			'add --api-key to use an API key instead'
		),
		row('install [pi] [--autostart]', 'route codex, claude & grok, or pi; optionally start at login'),
		row('uninstall [pi]', 'restore your original config; accounts and data stay'),
		row('uninstall all', 'remove setup, saved credentials/data, and the global package'),
		'',
		head('Everyday'),
		row('list', 'accounts, health, and live usage'),
		row(`switch ${cliWords} <email>`, 'make an account active now'),
		row('logout [codex|claude|grok] <email>', 'sign out and delete the credential'),
		row(
			`order ${cliWords} [email…]`,
			'which accounts auto-rotate uses first',
			'no emails prints the order · --reset clears it'
		),
		row(
			'auto <codex|claude|grok|all> <on|off>',
			'switch accounts at a usage threshold',
			'optional: --threshold N  (default 90)'
		),
		'',
		head('Details'),
		row('status', 'machine-readable JSON snapshot'),
		row('refresh', 're-probe usage now'),
		row('doctor', 'check tools, proxy, and config'),
		row('daemon <start|stop|status>', 'the background manager'),
		row('daemon <install|disable>', 'add or remove macOS login startup'),
		'',
		head('Auto-rotation'),
		dim("  The threshold is measured against the active account's fullest rate-limit"),
		dim('  window — its 5-hour or weekly window, whichever is highest. The default 90%'),
		dim('  keeps the rest of each window in reserve for you instead of spending it'),
		dim('  automatically. The proxy reads live rate-limit headers off every response,'),
		dim('  so crossing the threshold or hitting a hard limit switches to the account'),
		dim('  with the most headroom, and an interrupted request is retried there.'),
		dim('  Threshold switches hold for 5 minutes to avoid flapping; hard limits'),
		dim('  ignore the hold. Turning auto on is what authorizes the switching.'),
		dim('  With an order set, it switches to the first account in the order with'),
		dim('  room, and moves back to an earlier one once it has room again.'),
		'',
		dim('Once installed, use codex, claude and grok normally — a local proxy injects the'),
		dim("active account's credential per request, so a switch takes effect on the"),
		dim('next request, even mid-turn, with no restart.')
	].join('\n')
}

async function createContext(): Promise<ApplicationContext> {
	const paths = applicationPaths()
	await ensureApplicationPaths(paths)
	return { launchAgent: new LaunchAgent(paths), paths, store: createStateStore(paths.database) }
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
		process.stderr.write(`[${new Date().toISOString()}] uncaught exception: ${errorMessage(error)}\n`)
	})
	const lock = await acquireDaemonLock(context.paths.managerLock)
	try {
		if (await managerAvailable(context.paths.managerSocket)) {
			throw new ApplicationError('DAEMON_RUNNING', 'The manager daemon is already running')
		}
		// ensureDaemon restarts the daemon on a version change, so this runs on the
		// first start after every update; a failure must not keep the daemon down.
		const healed = await healInstalledConfigs(context.paths).catch(error => {
			process.stderr.write(
				`[${new Date().toISOString()}] config heal failed: ${errorMessage(error)}\n`
			)
			return []
		})
		if (healed.length > 0) {
			process.stdout.write(
				`[${new Date().toISOString()}] re-applied ${healed.map(provider => PROVIDERS[provider].cli).join(', ')} routing for v${VERSION}\n`
			)
		}
		const manager = new AccountManager({
			paths: context.paths,
			store: context.store,
			vault: createMacOsKeychainVault()
		})
		await manager.start()
		try {
			let requestStop: (() => void) | undefined
			const stopped = new Promise<void>(resolve => {
				requestStop = resolve
			})
			const beginShutdown = () => {
				const watchdog = setTimeout(() => {
					process.stderr.write(`[${new Date().toISOString()}] shutdown watchdog: forcing exit\n`)
					process.exit(0)
				}, 4_000)
				watchdog.unref()
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

function daemonCommandArguments(): string[] {
	if (compiledBinary) {
		return ['daemon', 'run']
	}
	const entrypoint = process.argv[1]
	if (entrypoint === undefined) {
		throw new ApplicationError('ENTRYPOINT_MISSING', 'Cannot locate the CLI entrypoint')
	}
	return [entrypoint, 'daemon', 'run']
}

async function startDaemon(context: ApplicationContext): Promise<void> {
	if (await managerAvailable(context.paths.managerSocket)) {
		return
	}
	const managed = await context.launchAgent.installed()
	if (managed && (await context.launchAgent.loaded())) await stopDaemon(context)
	await replacePortOccupant(context.paths.proxyPort)
	await mkdir(context.paths.runtime, { mode: 0o700, recursive: true })
	if (managed) {
		await context.launchAgent.start()
		const deadline = Date.now() + 15_000
		while (Date.now() < deadline) {
			if (await managerAvailable(context.paths.managerSocket)) return
			await Bun.sleep(100)
		}
		throw new ApplicationError(
			'DAEMON_START_FAILED',
			`Login startup loaded, but the manager did not respond. Check ${join(context.paths.runtime, 'daemon.log')} and System Settings → General → Login Items & Extensions.`
		)
	}
	const daemonArguments = daemonCommandArguments()
	const logDescriptor = openSync(join(context.paths.runtime, 'daemon.log'), 'a', 0o600)
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const child = spawn(process.execPath, daemonArguments, {
				detached: true,
				env: process.env,
				stdio: ['ignore', logDescriptor, logDescriptor]
			})
			child.unref()
			const deadline = Date.now() + 5_000
			while (Date.now() < deadline) {
				if (await managerAvailable(context.paths.managerSocket)) {
					return
				}
				if (child.exitCode !== null) {
					break
				}
				await Bun.sleep(50)
			}
			if (await managerAvailable(context.paths.managerSocket)) {
				return
			}
			await Bun.sleep(500)
		}
		const logPath = join(context.paths.runtime, 'daemon.log')
		const lastError = await readFile(logPath, 'utf8')
			.then(log => log.trim().split('\n').at(-1) ?? '')
			.catch(() => '')
		throw new ApplicationError(
			'DAEMON_START_FAILED',
			`Manager did not start${lastError === '' ? '' : ` — ${lastError.replace(/^tokenmaxx: /, '')}`}\n` +
				'Your clients still route through tokenmaxx while it is down.\n' +
				'Escape hatch: tokenmaxx uninstall  (clients talk straight to the providers again)\n' +
				`Then check tokenmaxx doctor, or the full log: ${logPath}`
		)
	} finally {
		closeSync(logDescriptor)
	}
}

async function forceStopDaemon(context: Pick<ApplicationContext, 'paths'>): Promise<void> {
	const ownerPid = await readFile(context.paths.managerLock, 'utf8').then(
		raw => {
			try {
				const pid = (JSON.parse(raw) as { processId?: unknown }).processId
				return typeof pid === 'number' ? pid : null
			} catch {
				return null
			}
		},
		() => null
	)
	if (ownerPid !== null) {
		try {
			process.kill(ownerPid, 'SIGKILL')
		} catch {}
	}
	await Bun.sleep(300)
	await rm(context.paths.managerLock, { force: true })
	await rm(context.paths.managerSocket, { force: true })
}

async function stopDaemon(
	context: Pick<ApplicationContext, 'paths' | 'launchAgent'>
): Promise<void> {
	if (await context.launchAgent.installed()) await context.launchAgent.stop()
	await managerRequest({
		method: 'manager/stop',
		schema: EmptyResultSchema,
		socketPath: context.paths.managerSocket,
		timeoutMilliseconds: 1_000
	}).catch(() => undefined)
	const deadline = Date.now() + 8_000
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
	await forceStopDaemon(context)
	process.stdout.write('Manager daemon stopped.\n')
}

async function installLoginStartup(context: ApplicationContext): Promise<void> {
	await context.launchAgent.install()
	await stopDaemon(context)
	await startDaemon(context)
	process.stdout.write(
		'Login startup installed. macOS keeps tokenmaxx running in the background; you can close the terminal.\n'
	)
}

async function disableLoginStartup(context: ApplicationContext): Promise<void> {
	if (!(await context.launchAgent.installed())) {
		process.stdout.write('Login startup is not installed for this TOKENMAXX_HOME.\n')
		return
	}
	await stopDaemon(context)
	await context.launchAgent.uninstall()
	process.stdout.write(
		'Login startup removed and manager stopped. Run tokenmaxx daemon start to use it manually.\n'
	)
}

async function ensureDaemon(context: ApplicationContext): Promise<void> {
	if (!(await managerAvailable(context.paths.managerSocket))) {
		await startDaemon(context)
		return
	}
	const running = await managerVersion(context.paths.managerSocket)
	if (running !== null && running !== VERSION) {
		process.stdout.write(`Updating the manager daemon (${running} → ${VERSION})…\n`)
		await stopDaemon(context)
		await startDaemon(context)
	}
}

function registerIsolatedAccount(provider: ProviderId): Promise<Account> {
	switch (provider) {
		case 'openai':
			return registerCodexAccount({ vault: createMacOsKeychainVault() })
		case 'anthropic':
			return registerClaudeAccount({ vault: createMacOsKeychainVault() })
		case 'xai':
			return registerGrokAccount({ vault: createMacOsKeychainVault() })
	}
}

const cliInstallHint: Record<ProviderId, string> = {
	anthropic: 'npm install -g @anthropic-ai/claude-code',
	openai: 'npm install -g @openai/codex',
	xai: 'npm install -g @xai-official/grok'
}

function assertCliInstalled(provider: ProviderId): void {
	const binary = PROVIDERS[provider].cli
	if (Bun.which(binary) === null) {
		throw new ApplicationError(
			'CLI_MISSING',
			`${binary} is not installed — run: ${cliInstallHint[provider]}`
		)
	}
}

async function handTerminalBack(): Promise<void> {
	if (process.stdin.isTTY !== true) {
		return
	}
	try {
		Bun.spawnSync(['stty', 'sane'], { stderr: 'ignore', stdin: 'inherit', stdout: 'ignore' })
	} catch {}
	process.stdin.resume()
	await Bun.sleep(50)
	try {
		while (process.stdin.read() !== null) {}
	} catch {}
	process.stdin.pause()
}

function freshScreen(title: string): void {
	const color =
		process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
	const accent = (text: string) => (color ? `\x1b[38;2;90;176;255m${text}\x1b[0m` : text)
	const dim = (text: string) => (color ? `\x1b[38;2;139;147;161m${text}\x1b[0m` : text)
	process.stdout.write(`\x1b[2J\x1b[H${accent('tokenmaxx')} ${dim(`· ${title}`)}\n\n`)
}

function skipEscapeSequence(line: string, start: number): number {
	const kind = line[start + 1]
	if (kind === '[') {
		let index = start + 2
		while (index < line.length && !/[a-zA-Z~]/.test(line[index] ?? '')) {
			index += 1
		}
		return index + 1
	}
	if (kind === ']' || kind === 'P') {
		let index = start + 2
		while (index < line.length && line.charCodeAt(index) !== 7 && line.charCodeAt(index) !== 27) {
			index += 1
		}
		return line.charCodeAt(index) === 27 ? index + 2 : index + 1
	}
	return start + 2
}

export function stripTerminalNoise(line: string): string {
	let clean = ''
	let index = 0
	while (index < line.length) {
		const code = line.charCodeAt(index)
		if (code === 27) {
			index = skipEscapeSequence(line, index)
			continue
		}
		if (code >= 32 && code !== 127) {
			clean += line[index]
		}
		index += 1
	}
	return clean.trim()
}

async function promptApiKey(
	keyArgument: string | undefined
): Promise<{ key: string; label: string }> {
	if (process.stdin.isTTY !== true && keyArgument === undefined) {
		throw new ApplicationError(
			'USAGE',
			`Pass the key inline in non-interactive shells: tokenmaxx login ${cliWords} --api-key <key>`
		)
	}
	await handTerminalBack()
	const readline = createInterface({ input: process.stdin, output: process.stdout })
	try {
		const key = keyArgument ?? stripTerminalNoise(await readline.question('Paste the API key: '))
		const label = stripTerminalNoise(
			await readline.question('Name this account (shown in the dashboard): ')
		)
		return { key, label }
	} finally {
		readline.close()
	}
}

async function signInOauth(context: ApplicationContext, provider: ProviderId): Promise<boolean> {
	const authenticated = await registerIsolatedAccount(provider)
	const existing = context.store
		.listAccounts(provider)
		.find(
			candidate =>
				candidate.externalAccountId !== null &&
				candidate.externalAccountId === authenticated.externalAccountId
		)
	const account =
		existing === undefined
			? authenticated
			: {
					...authenticated,
					createdAt: existing.createdAt,
					enabled: existing.enabled,
					id: existing.id
				}
	try {
		await requestAccountSave(context.paths.managerSocket, account, {
			profilePath: existing?.profilePath ?? null,
			secretReference: existing?.secretReference ?? null
		})
	} catch (error) {
		if (authenticated.secretReference !== null) {
			await createMacOsKeychainVault().remove(authenticated.secretReference)
		}
		throw error
	}
	process.stdout.write(
		existing === undefined
			? `Signed in ${account.label}.\n`
			: `Re-authenticated ${account.label}; live sessions pick it up on their next request.\n`
	)
	return existing === undefined
}

async function login(
	context: ApplicationContext,
	providerArgument: string | undefined,
	options: { apiKey: boolean; apiKeyValue?: string } = { apiKey: false }
): Promise<void> {
	if (providerArgument === undefined) {
		throw new ApplicationError('USAGE', `Usage: tokenmaxx login ${cliWords} [--api-key [key]]`)
	}
	const provider = providerFromCli(providerArgument)
	if (!options.apiKey) {
		assertCliInstalled(provider)
	}
	await ensureDaemon(context)
	const socket = context.paths.managerSocket
	if (options.apiKey) {
		const account = await requestAddApiKey(socket, {
			provider,
			...(await promptApiKey(options.apiKeyValue))
		})
		process.stdout.write(`Signed in ${account.label}.\n`)
	} else if (!(await signInOauth(context, provider))) {
		return
	}
	const routing = await readRouting(socket)
	if (!routing.routed[provider]) {
		await requestRouting(socket, provider, true).catch(() => undefined)
		process.stdout.write(
			`tokenmaxx is on for ${providerArgument} — run ${providerArgument} as usual.\n`
		)
	}
}

function resolveAccount(store: StateStore, provider: ProviderId, reference: string): Account {
	const matches = store
		.listAccounts(provider)
		.filter(account => account.id === reference || account.label === reference)
	const account = matches[0]
	if (account === undefined || matches.length !== 1) {
		throw new ApplicationError('ACCOUNT_NOT_FOUND', `Could not uniquely resolve ${reference}`)
	}
	return account
}

const healthText: Record<Account['health'], string> = {
	disabled: 'disabled',
	loginExpiring: 'login expiring soon',
	ready: 'ready',
	reauthenticationRequired: 'login required — tokenmaxx login',
	refreshDue: 'refreshing',
	refreshing: 'refreshing',
	scopeMissing: 'missing a scope',
	temporarilyUnreachable: 'provider unreachable',
	unchecked: 'checking',
	usageRateLimited: 'rate-limited'
}

function listAccounts(context: ApplicationContext): void {
	const states = new Map(context.store.listProviderStates().map(state => [state.provider, state]))
	const accounts = context.store.listAccounts()
	if (accounts.length === 0) {
		const hints = ProviderIdSchema.options.map(
			provider => `tokenmaxx login ${PROVIDERS[provider].cli}`
		)
		process.stdout.write(`No accounts yet. Sign in with:  ${hints.join('   ·   ')}\n`)
		return
	}
	const width = Math.max(...accounts.map(account => account.label.length))
	for (const provider of ProviderIdSchema.options) {
		const group = inOrder(accounts.filter(account => account.provider === provider))
		if (group.length === 0) {
			continue
		}
		process.stdout.write(`\n${PROVIDERS[provider].cli}\n`)
		for (const account of group) {
			const isActive = states.get(provider)?.activeAccountId === account.id
			const place = account.priority === undefined ? '  ' : `${account.priority + 1}.`
			process.stdout.write(
				`  ${isActive ? '●' : ' '} ${place} ${account.label.padEnd(width)}   ${healthText[account.health]}\n`
			)
		}
	}
	process.stdout.write('\n● = active\n')
}

function inOrder(accounts: readonly Account[]): Account[] {
	return [...accounts].sort(
		(left, right) => orderRank(left) - orderRank(right) || left.label.localeCompare(right.label)
	)
}

async function orderAccounts(
	context: ApplicationContext,
	arguments_: readonly string[]
): Promise<void> {
	const providerArgument = arguments_[0]
	if (providerArgument === undefined) {
		throw new ApplicationError(
			'USAGE',
			`Usage: tokenmaxx order ${cliWords} [email…] | tokenmaxx order ${cliWords} --reset`
		)
	}
	const provider = providerFromCli(providerArgument)
	const references = arguments_.slice(1).filter(argument => argument !== '--reset')
	const reset = arguments_.includes('--reset')
	if (!reset && references.length === 0) {
		const group = inOrder(context.store.listAccounts(provider))
		if (group.every(account => account.priority === undefined)) {
			process.stdout.write(
				`No order set for ${providerArgument}; auto-rotate picks the account with the most room.\n`
			)
			return
		}
		for (const account of group) {
			process.stdout.write(`  ${(account.priority ?? group.length) + 1}. ${account.label}\n`)
		}
		return
	}
	const accountIds = reset
		? []
		: references.map(reference => resolveAccount(context.store, provider, reference).id)
	await ensureDaemon(context)
	const snapshot = await requestAccountOrder(context.paths.managerSocket, provider, accountIds)
	if (reset) {
		process.stdout.write(
			`Cleared the ${providerArgument} order; auto-rotate picks the account with the most room.\n`
		)
		return
	}
	const ordered = inOrder(snapshot.accounts.filter(account => account.provider === provider))
	process.stdout.write(`Auto-rotate for ${providerArgument} now uses, in order:\n`)
	for (const account of ordered) {
		process.stdout.write(`  ${(account.priority ?? 0) + 1}. ${account.label}\n`)
	}
	process.stdout.write(
		'When an earlier account has room again, tokenmaxx moves back to it after the cooldown.\n'
	)
}

const providerWords = new Set(['codex', 'claude', 'grok', 'openai', 'anthropic', 'xai'])

async function logout(context: ApplicationContext, arguments_: readonly string[]): Promise<void> {
	const qualified = arguments_[0] !== undefined && providerWords.has(arguments_[0])
	const provider = qualified ? providerFromCli(arguments_[0] as string) : undefined
	const reference = qualified ? arguments_[1] : arguments_[0]
	if (reference === undefined) {
		throw new ApplicationError('USAGE', 'Usage: tokenmaxx logout [codex|claude|grok] <email-or-name>')
	}
	const matches = context.store
		.listAccounts(provider)
		.filter(account => account.id === reference || account.label === reference)
	const account = matches[0]
	if (account === undefined) {
		throw new ApplicationError('ACCOUNT_NOT_FOUND', `No account matches ${reference}`)
	}
	if (matches.length > 1) {
		throw new ApplicationError(
			'ACCOUNT_AMBIGUOUS',
			`${reference} is on both providers — say which: tokenmaxx logout codex ${reference}`
		)
	}
	await ensureDaemon(context)
	await requestAccountRemove(context.paths.managerSocket, account.id)
	process.stdout.write(`Signed out ${account.label}; its credential is gone from the Keychain.\n`)
}

async function switchAccount(
	context: ApplicationContext,
	arguments_: readonly string[]
): Promise<void> {
	const providerArgument = arguments_[0]
	const accountReference = arguments_[1]
	if (providerArgument === undefined || accountReference === undefined) {
		throw new ApplicationError('USAGE', `Usage: tokenmaxx switch ${cliWords} <email-or-id>`)
	}
	const provider = providerFromCli(providerArgument)
	const target = resolveAccount(context.store, provider, accountReference)
	await ensureDaemon(context)
	await requestSwitch(context.paths.managerSocket, provider, target.id)
	process.stdout.write(`Switched managed ${providerArgument} sessions to ${target.label}.\n`)
}

async function configureAutomation(
	context: ApplicationContext,
	arguments_: readonly string[]
): Promise<void> {
	const providerArgument = arguments_[0]
	const mode = arguments_[1]
	if (providerArgument === undefined || (mode !== 'on' && mode !== 'off')) {
		throw new ApplicationError(
			'USAGE',
			'Usage: tokenmaxx auto <codex|claude|grok|all> <on|off> [--threshold 95]'
		)
	}
	const providers =
		providerArgument === 'all' || providerArgument === 'both'
			? ProviderIdSchema.options
			: [providerFromCli(providerArgument)]
	const thresholdValue = option(arguments_, '--threshold')
	const thresholdPercent = thresholdValue === undefined ? undefined : Number(thresholdValue)
	if (
		thresholdPercent !== undefined &&
		(!Number.isFinite(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100)
	) {
		throw new ApplicationError('USAGE', '--threshold takes a percentage from 1 to 100')
	}
	await ensureDaemon(context)
	let effectiveThreshold = thresholdPercent ?? 90
	for (const provider of providers) {
		const state = await managerRequest({
			method: 'policy/set',
			params: {
				authorizationConfirmed: mode === 'on',
				enabled: mode === 'on',
				provider,
				thresholdPercent
			},
			schema: z.object({ policy: z.object({ thresholdPercent: z.number() }) }),
			socketPath: context.paths.managerSocket
		})
		effectiveThreshold = state.policy.thresholdPercent
	}
	if (mode === 'on') {
		process.stdout.write(`Auto-rotate on for ${providerArgument} at ${effectiveThreshold}%.\n`)
		process.stdout.write(
			`Rotates when the active account's fullest rate-limit window reaches ${effectiveThreshold}%.\n`
		)
	} else {
		process.stdout.write(`Auto-rotate off for ${providerArgument}.\n`)
	}
}

async function installConfig(context: ApplicationContext, targetArgument?: string): Promise<void> {
	if (targetArgument !== undefined && targetArgument !== 'pi') {
		throw new ApplicationError('USAGE', 'Usage: tokenmaxx install [pi]')
	}
	await ensureDaemon(context)
	if (targetArgument === 'pi') {
		const result = await installPiConfig(context.paths)
		if (!result.applied) {
			process.stdout.write(`Left ${result.path} alone: ${result.manual}\n`)
			return
		}
		process.stdout.write(
			`pi now has tokenmaxx-anthropic, tokenmaxx-openai and tokenmaxx-xai providers (${result.path}).\n` +
				'Pick a tokenmaxx model with /model and requests route through the proxy.\n' +
				'Undo any time with: tokenmaxx uninstall pi\n'
		)
		return
	}
	const providers = ProviderIdSchema.options.filter(
		provider => provider !== 'xai' || Bun.which(PROVIDERS.xai.cli) !== null
	)
	for (const provider of providers) {
		await installProviderConfig(provider, context.paths)
	}
	const clis = providers.map(provider => PROVIDERS[provider].cli)
	process.stdout.write(
		`Native ${clis.join(', ').replace(/, ([^,]*)$/, ' and $1')} now route through tokenmaxx.\n` +
			`Just run ${clis.map(cli => `\`${cli}\``).join(' or ')} as usual — tokenmaxx injects the active account.\n` +
			'Undo any time with: tokenmaxx uninstall\n'
	)
}

async function uninstallConfig(targetArgument?: string): Promise<void> {
	if (targetArgument !== undefined && targetArgument !== 'routing' && targetArgument !== 'pi') {
		throw new ApplicationError('USAGE', 'Usage: tokenmaxx uninstall [pi|all]')
	}
	if (targetArgument === 'pi') {
		const result = await uninstallPiConfig()
		process.stdout.write(
			result.applied
				? `Removed the tokenmaxx providers from ${result.path}.\n`
				: `${result.manual === null ? 'pi was not routed; nothing to restore.' : `Left ${result.path} alone: ${result.manual}`}\n`
		)
		return
	}
	const restored: (string | null)[] = []
	for (const provider of ProviderIdSchema.options) {
		restored.push(await uninstallProviderConfig(provider))
	}
	const pi = await uninstallPiConfig()
	if (pi.manual !== null)
		throw new ApplicationError('CONFIG_UNINSTALL_FAILED', `${pi.path}: ${pi.manual}`)
	if (restored.every(path => path === null) && !pi.applied) {
		process.stdout.write('tokenmaxx was not installed; nothing to restore.\n')
		return
	}
	process.stdout.write(
		'Restored client routing. Saved accounts and data are unchanged. Re-enable with: tokenmaxx install\n'
	)
}

async function doctor(context: ApplicationContext): Promise<void> {
	const tools = [
		['bun', '1.2+'],
		['codex', '0.144.1'],
		['claude', '2.1.206'],
		['grok', '1.0.13']
	] as const
	for (const [tool, testedVersion] of tools) {
		if (Bun.which(tool) === null) {
			if (tool !== PROVIDERS.xai.cli) {
				process.stdout.write(`missing  ${tool}\n`)
			}
			continue
		}
		const version = await commandOutput([tool, '--version'])
		process.stdout.write(`ok       ${tool.padEnd(8)} ${version}  (tested ${testedVersion})\n`)
	}
	process.stdout.write(`${Bun.which('security') === null ? 'missing' : 'ok     '}  security\n`)
	const running = await managerAvailable(context.paths.managerSocket)
	const daemonVersion = running ? await managerVersion(context.paths.managerSocket) : null
	process.stdout.write(
		`${(await context.launchAgent.installed()) ? 'installed' : 'not installed'}  macOS login startup (tokenmaxx daemon install)\n`
	)
	const unreachable = !running && (await proxyIdentity(context.paths.proxyPort)) === 'tokenmaxx'
	if (unreachable) {
		const processId = await portOwnerProcessId(context.paths.proxyPort)
		process.stdout.write(
			`warning  manager daemon${processId === null ? '' : ` (process ${processId})`} holds port ${context.paths.proxyPort} but does not answer — tokenmaxx daemon start replaces it\n`
		)
	} else {
		process.stdout.write(
			`${running ? 'running' : 'stopped'}  manager daemon${daemonVersion === null ? '' : ` (${daemonVersion})`}\n`
		)
	}
	const update = await availableUpdate()
	process.stdout.write(
		update === null
			? `ok       version  ${VERSION} (latest)\n`
			: `note     version  ${VERSION} — v${update} is out: ${compiledBinary ? 'update the tokenmaxx app' : 'bun add -g tokenmaxx'}\n`
	)
	if (running) {
		const port = await readProxyPort(context.paths.managerSocket).catch(() => null)
		process.stdout.write(
			`${port === null ? 'warning  ' : 'ok     '}  proxy    ${port === null ? 'not listening' : `127.0.0.1:${port}`}\n`
		)
	}
	const routing = await installStatus()
	const routedText: Record<ProviderId, string> = {
		anthropic: 'settings.json routes ANTHROPIC_BASE_URL through tokenmaxx',
		openai: 'config.toml selects the tokenmaxx provider',
		xai: 'config.toml points cli_chat_proxy_base_url at tokenmaxx'
	}
	for (const provider of ProviderIdSchema.options) {
		const routed = routing.routed[provider]
		if (provider === 'xai' && !routed && Bun.which(PROVIDERS.xai.cli) === null) {
			continue
		}
		const detail = routed
			? routedText[provider]
			: provider === 'openai' && routing.codexStale
				? 'a tokenmaxx block exists but codex ignores it (top-level key was swallowed by a [table]) — run tokenmaxx install to repair'
				: 'not routed — run tokenmaxx install'
		process.stdout.write(
			`${routed ? 'ok     ' : 'note   '}  ${PROVIDERS[provider].cli.padEnd(8)} ${detail}\n`
		)
	}
	const pi = await piStatus()
	if (pi.present) {
		process.stdout.write(
			`${pi.routed ? 'ok     ' : 'note   '}  pi       ${
				pi.routed ? 'models.json has the tokenmaxx providers' : 'not routed — run tokenmaxx install pi'
			}\n`
		)
	}
	process.stdout.write(`state     ${context.paths.database}\n`)
	const legacyDirectories = [join(context.paths.root, 'codex'), join(context.paths.root, 'claude')]
	const legacyDetected = await Promise.all(
		legacyDirectories.map(directory =>
			stat(directory)
				.then(() => true)
				.catch(() => false)
		)
	)
	if (legacyDetected.some(Boolean)) {
		process.stdout.write(
			'warning  legacy plaintext snapshots detected; re-register accounts before removing them\n'
		)
	}
}

export async function runCli(rawArguments: readonly string[]): Promise<number> {
	const arguments_ = CommandSchema.parse(rawArguments)
	if (arguments_[0] === 'uninstall' && arguments_[1] === 'all' && arguments_.length === 2) {
		const initialPaths = applicationPaths()
		const saved = await new LaunchAgent(initialPaths).environment()
		const paths = saved === null ? initialPaths : applicationPaths({ ...process.env, ...saved })
		if (process.env.TOKENMAXX_HOME !== undefined && initialPaths.root !== paths.root) {
			throw new ApplicationError(
				'AUTOSTART_CONFLICT',
				`Startup uses ${paths.root}; use that TOKENMAXX_HOME to uninstall`
			)
		}
		const launchAgent = new LaunchAgent(paths)
		await uninstallTokenmaxx({
			environment: { ...process.env, ...saved },
			paths,
			removeStartup: () => launchAgent.uninstall(),
			stopDaemon: () => stopDaemon({ launchAgent, paths })
		})
		const entrypoint = process.argv[1]
		if (entrypoint === undefined)
			throw new ApplicationError('ENTRYPOINT_MISSING', 'Cannot locate the CLI entrypoint')
		const removed = await removeGlobalPackage(entrypoint)
		process.stdout.write(
			`Removed tokenmaxx setup, accounts, credentials, local data, and startup files.${removed ? ' The global package was removed.' : ' This source checkout was kept.'}\n`
		)
		return 0
	}
	const context = await createContext()
	try {
		const command = arguments_[0]
		switch (command) {
			case undefined:
			case 'dashboard': {
				const fixtureName = process.env.TOKENMAXX_FIXTURE ?? option(arguments_, '--fixture')
				if (fixtureName !== undefined && process.stdout.isTTY) {
					const [{ FIXTURE_NOW }, { runTuiDashboard }] = await Promise.all([
						import('./tui/fixtures.ts'),
						import('./tui/dashboard.ts')
					])
					const now = process.env.TOKENMAXX_NOW ? Number(process.env.TOKENMAXX_NOW) : FIXTURE_NOW
					const timewarp = Number(process.env.TOKENMAXX_TIMEWARP ?? 0)
					const routed = process.env.TOKENMAXX_INSTALLED !== 'false'
					await runTuiDashboard(context.paths.managerSocket, {
						fixture: {
							name: fixtureName,
							now,
							routed,
							timewarp: Number.isFinite(timewarp) && timewarp > 0 ? timewarp : 0
						}
					})
					context.store.close()
					process.exit(0)
				}
				await ensureDaemon(context)
				if (process.stdout.isTTY) {
					const { runTuiDashboard } = await import('./tui/dashboard.ts')
					let alert = ''
					for (;;) {
						const action = await runTuiDashboard(context.paths.managerSocket, { alert })
						alert = ''
						await handTerminalBack()
						if (action === undefined) {
							break
						}
						// A dashboard from before an update still runs the old code; never
						// let it write config or credentials.
						if ((await installedVersion()) !== VERSION) {
							alert = 'this dashboard is out of date — quit and run tokenmaxx again'
							continue
						}
						if (action.kind === 'relogin' || action.kind === 'login' || action.kind === 'loginApiKey') {
							const cli = PROVIDERS[action.provider].cli
							freshScreen(action.kind === 'loginApiKey' ? `add a ${cli} api key` : `sign in with ${cli}`)
							await login(context, cli, {
								apiKey: action.kind === 'loginApiKey'
							}).catch(error => {
								alert = errorMessage(error)
							})
							continue
						}
						if (action.kind === 'update') {
							if (compiledBinary) {
								process.stdout.write(
									`v${action.version} is out — update the tokenmaxx app from https://tokenmaxx.sh\n`
								)
								break
							}
							process.stdout.write(`Updating tokenmaxx to v${action.version}…\n`)
							const bun = Bun.which('bun') ?? 'bun'
							const result = Bun.spawnSync([bun, 'add', '-g', `tokenmaxx@${action.version}`], {
								stderr: 'inherit',
								stdout: 'inherit'
							})
							process.stdout.write(
								result.exitCode === 0
									? `Updated. Run tokenmaxx again to use v${action.version}.\n`
									: 'Update failed — run: bun add -g tokenmaxx\n'
							)
							break
						}
					}
					context.store.close()
					process.exit(0)
				}
				process.stdout.write(`${renderDashboard(await readDashboard(context.paths.managerSocket))}\n`)
				return 0
			}
			case 'version':
			case '--version':
			case '-v':
				process.stdout.write(`${VERSION}\n`)
				return 0
			case 'help':
			case '--help':
			case '-h':
				process.stdout.write(`${help()}\n`)
				return 0
			case 'login': {
				const flagIndex = arguments_.indexOf('--api-key')
				await login(context, arguments_[1], {
					apiKey: flagIndex >= 0,
					apiKeyValue: flagIndex >= 0 ? arguments_[flagIndex + 1] : undefined
				})
				return 0
			}
			case 'switch':
				await switchAccount(context, arguments_.slice(1))
				return 0
			case 'logout':
				await logout(context, arguments_.slice(1))
				return 0
			case 'order':
				await orderAccounts(context, arguments_.slice(1))
				return 0
			case 'auto':
				await configureAutomation(context, arguments_.slice(1))
				return 0
			case 'refresh':
				await ensureDaemon(context)
				await managerRequest({
					method: 'usage/refresh',
					schema: z.unknown(),
					socketPath: context.paths.managerSocket,
					timeoutMilliseconds: 60_000
				})
				process.stdout.write('Re-probed usage for every account.\n')
				return 0
			case 'status': {
				await ensureDaemon(context)
				const snapshot = await readDashboard(context.paths.managerSocket)
				process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
				return 0
			}
			case 'list':
				listAccounts(context)
				return 0
			case 'install': {
				const targets = arguments_.slice(1).filter(argument => argument !== '--autostart')
				if (targets.length > 1 || (targets[0] !== undefined && targets[0] !== 'pi')) {
					throw new ApplicationError('USAGE', 'Usage: tokenmaxx install [pi] [--autostart]')
				}
				if (arguments_.includes('--autostart')) await installLoginStartup(context)
				await installConfig(context, targets[0])
				return 0
			}
			case 'uninstall':
				if (arguments_.length > 2)
					throw new ApplicationError('USAGE', 'Usage: tokenmaxx uninstall [pi|all]')
				await uninstallConfig(arguments_[1])
				return 0
			case 'daemon':
				switch (arguments_[1]) {
					case 'install':
						await installLoginStartup(context)
						return 0
					case 'disable':
						await disableLoginStartup(context)
						return 0
					case 'run':
						await runDaemon(context)
						return 0
					case 'start':
						await ensureDaemon(context)
						process.stdout.write('Manager daemon is running.\n')
						return 0
					case 'stop':
						await stopDaemon(context)
						return 0
					case 'status': {
						process.stdout.write(
							`Login startup: ${(await context.launchAgent.installed()) ? 'installed' : 'not installed'}\n`
						)
						if (await managerAvailable(context.paths.managerSocket)) {
							process.stdout.write('running\n')
							return 0
						}
						const port = context.paths.proxyPort
						if ((await proxyIdentity(port)) === 'tokenmaxx') {
							const processId = await portOwnerProcessId(port)
							process.stdout.write(
								`unreachable — a tokenmaxx daemon${processId === null ? '' : ` (process ${processId})`} holds port ${port} but does not answer; tokenmaxx daemon start replaces it\n`
							)
							return 1
						}
						process.stdout.write('stopped\n')
						return 0
					}
					default:
						throw new ApplicationError('USAGE', 'Usage: daemon <start|run|stop|status|install|disable>')
				}
			case 'doctor':
				await doctor(context)
				return 0
			default:
				throw new ApplicationError(
					'UNKNOWN_COMMAND',
					`Unknown command ${command}. Run tokenmaxx --help.`
				)
		}
	} finally {
		context.store.close()
	}
}
