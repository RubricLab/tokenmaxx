import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { managerAvailable, managerRequest } from './ipc.ts'
import { LaunchAgent, type LaunchAgentOptions, launchAgentFiles } from './launch-agent.ts'
import { applicationPaths, ensureApplicationPaths } from './paths.ts'
import { uninstallTokenmaxx } from './uninstall.ts'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'tmx-'))
	directories.push(directory)
	return directory
}

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { force: true, recursive: true })
})

async function options(): Promise<LaunchAgentOptions> {
	const directory = await temporaryDirectory()
	return {
		bunPath: process.execPath,
		entrypoint: join(import.meta.dir, 'index.ts'),
		environment: {
			ANTHROPIC_API_KEY: 'must-not-be-written',
			CLAUDE_CONFIG_DIR: join(directory, 'claude'),
			CODEX_HOME: join(directory, 'codex'),
			GROK_HOME: join(directory, 'grok'),
			OPENAI_API_KEY: 'must-not-be-written',
			PATH: '/usr/bin:/bin',
			PI_CODING_AGENT_DIR: join(directory, 'pi'),
			TOKENMAXX_FIXTURE: 'must-not-be-written'
		},
		paths: applicationPaths({
			TOKENMAXX_HOME: join(directory, 'state'),
			TOKENMAXX_PROXY_PORT: '18459'
		}),
		userDirectory: directory
	}
}

async function parsePlist(content: string): Promise<Record<string, unknown>> {
	const child = Bun.spawn(['/usr/bin/plutil', '-convert', 'json', '-o', '-', '--', '-'], {
		stderr: 'pipe',
		stdin: new Blob([content]),
		stdout: 'pipe'
	})
	const result = (await new Response(child.stdout).json()) as Record<string, unknown>
	expect(await child.exited).toBe(0)
	return result
}

describe('login startup files', () => {
	test('only the settings needed by the daemon are persisted', async () => {
		const input = await options()
		const plan = launchAgentFiles(input)
		const launchAgent = plan.files.find(file => file.path === plan.plistPath)
		expect(launchAgent?.content).toContain(input.paths.root)
		expect(launchAgent?.content).toContain('<string>18459</string>')
		expect(launchAgent?.content).toContain(input.environment.CODEX_HOME ?? '')
		expect(plan.files.map(file => file.content).join('\n')).not.toContain('must-not-be-written')
	})

	test('the launcher preserves executable paths and arguments without evaluating shell characters', async () => {
		const input = await options()
		const special = join(
			input.userDirectory,
			"space & <xml> ' $(touch unexpected) `touch unexpected2`"
		)
		await mkdir(special)
		const bunPath = join(special, 'bun')
		await symlink(process.execPath, bunPath)
		const entrypoint = join(special, 'entry.ts')
		await writeFile(entrypoint, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
		const plan = launchAgentFiles({ ...input, bunPath, entrypoint })
		const launcher = plan.files.find(file => file.mode === 0o755)
		if (launcher === undefined) throw new Error('Missing launcher')
		await mkdir(dirname(launcher.path), { recursive: true })
		await writeFile(launcher.path, launcher.content)
		await chmod(launcher.path, launcher.mode)
		const args = ['daemon', 'run', "an argument's spaces", '$(touch injected)']
		const child = Bun.spawn([launcher.path, ...args], {
			cwd: input.userDirectory,
			stderr: 'pipe',
			stdout: 'pipe'
		})
		expect(await new Response(child.stdout).json()).toEqual(args)
		expect(await child.exited).toBe(0)
		for (const name of ['unexpected', 'unexpected2', 'injected']) {
			expect(await Bun.file(join(input.userDirectory, name)).exists()).toBe(false)
		}
	})

	test.skipIf(process.platform !== 'darwin')(
		'macOS parses the plists and resolves the intended service settings',
		async () => {
			const input = await options()
			input.userDirectory = join(input.userDirectory, "space & <xml> ' characters")
			const plan = launchAgentFiles(input)
			const launchAgent = await parsePlist(plan.files[2]?.content ?? '')
			expect(launchAgent).toMatchObject({
				EnvironmentVariables: {
					TOKENMAXX_HOME: input.paths.root,
					TOKENMAXX_PROXY_PORT: '18459'
				},
				KeepAlive: true,
				Label: 'sh.tokenmaxx.daemon',
				RunAtLoad: true,
				WorkingDirectory: input.userDirectory
			})
			expect(launchAgent.ProgramArguments).toEqual([
				join(plan.appPath, 'Contents', 'MacOS', 'tokenmaxx'),
				'daemon',
				'run'
			])
			expect(await parsePlist(plan.files[0]?.content ?? '')).toMatchObject({
				CFBundleDisplayName: 'tokenmaxx',
				CFBundleName: 'tokenmaxx',
				LSUIElement: true
			})
		}
	)

	test.skipIf(process.platform === 'darwin')(
		'other platforms reject installation without writing files',
		async () => {
			const input = await options()
			const agent = new LaunchAgent(input.paths, input)
			expect(await agent.installed()).toBe(false)
			await expect(agent.install()).rejects.toThrow('macOS user')
			expect(await Bun.file(launchAgentFiles(input).plistPath).exists()).toBe(false)
		}
	)
})

async function waitFor<Result>(
	read: () => Promise<Result>,
	ready: (value: Result) => boolean
): Promise<Result> {
	const deadline = Date.now() + 20_000
	for (;;) {
		const value = await read()
		if (ready(value)) return value
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for launchd: ${JSON.stringify(value)}`)
		await Bun.sleep(100)
	}
}

test.skipIf(process.platform !== 'darwin' || process.env.TOKENMAXX_TEST_LAUNCHD !== '1')(
	'launchd runs one manager, restarts it after exit, and supports stop, reinstall, and full uninstall',
	async () => {
		const input = await options()
		input.label = `sh.tokenmaxx.test.${crypto.randomUUID()}`
		const reservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
		input.paths.proxyPort = reservation.port
		reservation.stop()
		await ensureApplicationPaths(input.paths)
		const agent = new LaunchAgent(input.paths, input)
		const ping = () =>
			managerRequest({
				method: 'manager/ping',
				schema: z.object({ processId: z.number() }),
				socketPath: input.paths.managerSocket,
				timeoutMilliseconds: 500
			})
				.then(result => result.processId)
				.catch(() => null)
		try {
			const appPath = launchAgentFiles(input).appPath
			await mkdir(appPath, { recursive: true })
			await expect(agent.install()).rejects.toThrow('existing app')
			await rm(appPath, { recursive: true })
			await agent.install()
			expect(await agent.installed()).toBe(true)
			await agent.start()
			const firstPid = await waitFor(ping, pid => pid !== null)
			await agent.start()
			expect(await ping()).toBe(firstPid)
			const proxy = await fetch(`http://127.0.0.1:${input.paths.proxyPort}/`)
			expect(await proxy.text()).toStartWith('tokenmaxx proxy')
			if (firstPid === null) throw new Error('Missing manager process')
			process.kill(firstPid, 'SIGTERM')
			await waitFor(ping, pid => pid !== null && pid !== firstPid)
			await agent.stop()
			await waitFor(
				() => managerAvailable(input.paths.managerSocket),
				running => !running
			)
			expect(await agent.loaded()).toBe(false)
			expect(await agent.installed()).toBe(true)
			await waitFor(
				() =>
					stat(input.paths.managerLock).then(
						() => true,
						() => false
					),
				held => !held
			)
			await agent.install()
			await agent.start()
			await waitFor(ping, pid => pid !== null)
			const otherPaths = applicationPaths({ TOKENMAXX_HOME: join(input.userDirectory, 'other-state') })
			const other = new LaunchAgent(otherPaths, { ...input, paths: otherPaths })
			expect(await other.installed()).toBe(false)
			await expect(other.install()).rejects.toThrow('different startup configuration')
			await other.uninstall()
			expect(await agent.installed()).toBe(true)
			await uninstallTokenmaxx({
				environment: input.environment,
				paths: input.paths,
				removeCredentials: async () => {},
				removeStartup: () => agent.uninstall(),
				stopDaemon: () => agent.stop()
			})
		} finally {
			await agent.uninstall()
			await waitFor(
				() => managerAvailable(input.paths.managerSocket),
				running => !running
			)
		}
		expect(await agent.installed()).toBe(false)
		expect(await agent.loaded()).toBe(false)
		for (const path of [
			input.paths.root,
			launchAgentFiles(input).appPath,
			launchAgentFiles(input).plistPath
		]) {
			expect(
				await stat(path).then(
					() => true,
					() => false
				)
			).toBe(false)
		}
		await agent.uninstall()
	},
	60_000
)
