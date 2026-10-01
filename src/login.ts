import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface IsolatedLoginDependencies {
	run(
		command: readonly string[],
		environment: Record<string, string | undefined>
	): Promise<{ exitCode: number; stderr: string }>
	createTemporaryDirectory(prefix: string): Promise<string>
	read(path: string): Promise<string>
	remove(path: string): Promise<void>
}

export function defaultIsolatedLoginDependencies(): IsolatedLoginDependencies {
	return {
		createTemporaryDirectory: prefix => mkdtemp(join(tmpdir(), prefix)),
		read: path => readFile(path, 'utf8'),
		remove: path => rm(path, { force: true, recursive: true }),
		async run(command, environment) {
			const child = Bun.spawn([...command], {
				env: { ...process.env, ...environment },
				stderr: 'pipe',
				stdin: 'inherit',
				stdout: 'inherit'
			})
			const decoder = new TextDecoder()
			let stderr = ''
			for await (const chunk of child.stderr) {
				process.stderr.write(chunk)
				stderr = `${stderr}${decoder.decode(chunk, { stream: true })}`.slice(-4_096)
			}
			return { exitCode: await child.exited, stderr }
		}
	}
}
