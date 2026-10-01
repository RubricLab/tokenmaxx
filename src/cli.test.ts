import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTerminalNoise } from './cli.ts'
import { managerAvailable } from './ipc.ts'
import { applicationPaths } from './paths.ts'

describe('stripTerminalNoise', () => {
	test('terminal chatter never survives into a typed answer', () => {
		expect(stripTerminalNoise('\x1b[B\x1b[Ask-ant-abc123')).toBe('sk-ant-abc123')
		expect(stripTerminalNoise('\x1bP1+r4d73=1b5d\x1b\\sk-proj-xyz')).toBe('sk-proj-xyz')
		expect(stripTerminalNoise('\x1b]0;4:00 on ttys005\x07my key')).toBe('my key')
		expect(stripTerminalNoise('  plain-key-42  ')).toBe('plain-key-42')
	})
})

test('status and invalid setup arguments do not start a manager or configure clients', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'tmx-cli-'))
	const reservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
	const paths = applicationPaths({
		TOKENMAXX_HOME: join(directory, 'state'),
		TOKENMAXX_PROXY_PORT: String(reservation.port)
	})
	reservation.stop()
	try {
		for (const args of [
			['daemon', 'status'],
			['install', 'unknown', '--autostart']
		]) {
			const child = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts'), ...args], {
				env: {
					...process.env,
					CLAUDE_CONFIG_DIR: join(directory, 'claude'),
					CODEX_HOME: join(directory, 'codex'),
					TOKENMAXX_HOME: paths.root,
					TOKENMAXX_PROXY_PORT: String(paths.proxyPort)
				},
				stderr: 'pipe',
				stdout: 'pipe'
			})
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited
			])
			if (args[0] === 'daemon') {
				expect(exitCode).toBe(0)
				expect(stdout).toContain('Login startup: not installed')
				expect(stdout).toContain('stopped')
			} else {
				expect(exitCode).toBe(1)
				expect(stderr).toContain('Usage: tokenmaxx install [pi] [--autostart]')
			}
			expect(await managerAvailable(paths.managerSocket)).toBe(false)
			expect(await Bun.file(join(directory, 'codex', 'config.toml')).exists()).toBe(false)
			expect(await Bun.file(join(directory, 'claude', 'settings.json')).exists()).toBe(false)
		}
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
})
