import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ApplicationError } from './errors.ts'
import type { ApplicationPaths } from './paths.ts'

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue }

function xml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function plistValue(value: PlistValue): string {
	if (typeof value === 'string') return `<string>${xml(value)}</string>`
	if (typeof value === 'number') return `<integer>${value}</integer>`
	if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
	if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`
	return `<dict>${Object.entries(value)
		.map(([key, item]) => `<key>${xml(key)}</key>${plistValue(item)}`)
		.join('')}</dict>`
}

function plist(value: PlistValue): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${plistValue(value)}</plist>
`
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

export interface LaunchAgentOptions {
	paths: ApplicationPaths
	bunPath: string
	entrypoint: string
	userDirectory: string
	environment: NodeJS.ProcessEnv
	label?: string
}

export function launchAgentFiles(input: LaunchAgentOptions) {
	const label = input.label ?? 'sh.tokenmaxx.daemon'
	const bundleId = label.replace(/\.daemon$/, '')
	const appPath = join(input.userDirectory, 'Applications', 'tokenmaxx.app')
	const executable = join(appPath, 'Contents', 'MacOS', 'tokenmaxx')
	const plistPath = join(input.userDirectory, 'Library', 'LaunchAgents', `${label}.plist`)
	const environment: Record<string, string> = {
		PATH: [
			...new Set([
				dirname(input.bunPath),
				join(input.userDirectory, '.bun', 'bin'),
				join(input.userDirectory, '.local', 'bin'),
				'/opt/homebrew/bin',
				'/usr/local/bin',
				'/usr/bin',
				'/bin',
				'/usr/sbin',
				'/sbin',
				...(input.environment.PATH ?? '').split(':').filter(Boolean)
			])
		].join(':'),
		TOKENMAXX_HOME: input.paths.root,
		TOKENMAXX_PROXY_PORT: String(input.paths.proxyPort)
	}
	for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
		const value = input.environment[key]
		if (value !== undefined) environment[key] = resolve(value)
	}
	const logPath = join(input.paths.runtime, 'daemon.log')
	return {
		appPath,
		bundleId,
		files: [
			{
				content: plist({
					CFBundleDisplayName: 'tokenmaxx',
					CFBundleExecutable: 'tokenmaxx',
					CFBundleIdentifier: bundleId,
					CFBundleInfoDictionaryVersion: '6.0',
					CFBundleName: 'tokenmaxx',
					CFBundlePackageType: 'APPL',
					CFBundleVersion: '1',
					LSUIElement: true
				}),
				mode: 0o644,
				path: join(appPath, 'Contents', 'Info.plist')
			},
			{
				content: `#!/bin/sh\nexec ${shellQuote(input.bunPath)} ${shellQuote(resolve(input.entrypoint))} "$@"\n`,
				mode: 0o755,
				path: executable
			},
			{
				content: plist({
					AssociatedBundleIdentifiers: [bundleId],
					EnvironmentVariables: environment,
					ExitTimeOut: 10,
					KeepAlive: true,
					Label: label,
					ProgramArguments: [executable, 'daemon', 'run'],
					RunAtLoad: true,
					StandardErrorPath: logPath,
					StandardOutPath: logPath,
					ThrottleInterval: 10,
					WorkingDirectory: input.userDirectory
				}),
				mode: 0o644,
				path: plistPath
			}
		],
		label,
		plistPath
	}
}

async function run(
	command: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(command, { stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' })
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited
	])
	return { exitCode, stderr, stdout }
}

export class LaunchAgent {
	readonly #options: LaunchAgentOptions
	readonly #configuration: ReturnType<typeof launchAgentFiles>
	readonly #domain = `gui/${process.getuid?.()}`

	public constructor(paths: ApplicationPaths, options?: LaunchAgentOptions) {
		this.#options = options ?? {
			bunPath: Bun.which('bun') ?? process.execPath,
			entrypoint: process.argv[1] ?? '',
			environment: process.env,
			paths,
			userDirectory: homedir()
		}
		this.#configuration = launchAgentFiles(this.#options)
	}

	get #service(): string {
		return `${this.#domain}/${this.#configuration.label}`
	}

	public async installed(): Promise<boolean> {
		if (process.platform !== 'darwin' || !(await Bun.file(this.#configuration.plistPath).exists())) {
			return false
		}
		const result = await run([
			'/usr/bin/plutil',
			'-extract',
			'EnvironmentVariables.TOKENMAXX_HOME',
			'raw',
			'-o',
			'-',
			this.#configuration.plistPath
		])
		return result.exitCode === 0 && result.stdout.replace(/\n$/, '') === this.#options.paths.root
	}

	async #checkAppOwnership(): Promise<void> {
		const existing = await lstat(this.#configuration.appPath).catch(error => {
			if (error.code === 'ENOENT') return null
			throw error
		})
		if (existing === null) return
		const identity = await run([
			'/usr/bin/plutil',
			'-extract',
			'CFBundleIdentifier',
			'raw',
			'-o',
			'-',
			join(this.#configuration.appPath, 'Contents', 'Info.plist')
		])
		if (
			existing.isSymbolicLink() ||
			identity.exitCode !== 0 ||
			identity.stdout.trim() !== this.#configuration.bundleId
		) {
			throw new ApplicationError(
				'AUTOSTART_CONFLICT',
				`An existing app at ${this.#configuration.appPath} is not the tokenmaxx background launcher`
			)
		}
	}

	public async install(): Promise<void> {
		if (process.platform !== 'darwin' || process.getuid?.() === 0) {
			throw new ApplicationError(
				'AUTOSTART_UNSUPPORTED',
				'Install login startup as your macOS user, without sudo'
			)
		}
		await this.#launchctl(['print', this.#domain])
		if ((await Bun.file(this.#configuration.plistPath).exists()) && !(await this.installed())) {
			throw new ApplicationError(
				'AUTOSTART_CONFLICT',
				`A different startup configuration exists at ${this.#configuration.plistPath}; remove it before installing for this TOKENMAXX_HOME`
			)
		}
		if (!(await Bun.file(this.#options.entrypoint).exists())) {
			throw new ApplicationError('ENTRYPOINT_MISSING', 'Cannot locate the CLI entrypoint')
		}
		await access(this.#options.bunPath, constants.X_OK)
		await this.#checkAppOwnership()
		for (const file of this.#configuration.files) {
			await mkdir(dirname(file.path), { recursive: true })
			await writeFile(file.path, file.content, { mode: file.mode })
			await chmod(file.path, file.mode)
		}
	}

	async #launchctl(arguments_: string[]): Promise<void> {
		const result = await run(['/bin/launchctl', ...arguments_])
		if (result.exitCode !== 0) {
			throw new ApplicationError(
				'LAUNCHCTL_FAILED',
				`launchctl ${arguments_[0]} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`
			)
		}
	}

	public async loaded(): Promise<boolean> {
		return (await run(['/bin/launchctl', 'print', this.#service])).exitCode === 0
	}

	public async start(): Promise<void> {
		await this.#launchctl(['enable', this.#service])
		if (!(await this.loaded())) {
			const deadline = Date.now() + 10_000
			for (;;) {
				const result = await run([
					'/bin/launchctl',
					'bootstrap',
					this.#domain,
					this.#configuration.plistPath
				])
				if (result.exitCode === 0 || (await this.loaded())) break
				if (result.exitCode !== 5 || Date.now() >= deadline) {
					throw new ApplicationError(
						'LAUNCHCTL_FAILED',
						`Could not load login startup: ${result.stderr.trim()}. Check System Settings → General → Login Items & Extensions and ${join(this.#options.paths.runtime, 'daemon.log')}`
					)
				}
				await Bun.sleep(200)
			}
		}
		await this.#launchctl(['kickstart', this.#service])
	}

	public async stop(): Promise<void> {
		if (!(await this.loaded())) return
		await this.#launchctl(['bootout', this.#service])
		const deadline = Date.now() + 15_000
		while (await this.loaded()) {
			if (Date.now() >= deadline) {
				throw new ApplicationError(
					'LAUNCHCTL_FAILED',
					'Timed out waiting for macOS to unload tokenmaxx'
				)
			}
			await Bun.sleep(100)
		}
	}

	public async uninstall(): Promise<void> {
		if (!(await this.installed())) return
		await this.#checkAppOwnership()
		await this.stop()
		await rm(this.#configuration.plistPath)
		await rm(this.#configuration.appPath, { force: true, recursive: true })
	}
}
