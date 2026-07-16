import { z } from 'zod'

export const CommandResultSchema = z.object({
	exitCode: z.number().int(),
	stderr: z.string(),
	stdout: z.string()
})
export type CommandResult = z.infer<typeof CommandResultSchema>

export async function runCommand(
	command: readonly string[],
	options: {
		cwd?: string
		environment?: Record<string, string | undefined>
		stdin?: 'inherit' | 'ignore'
		stdout?: 'inherit' | 'pipe'
		stderr?: 'inherit' | 'pipe'
	} = {}
): Promise<CommandResult> {
	const processHandle = Bun.spawn([...command], {
		cwd: options.cwd,
		env: { ...process.env, ...options.environment },
		stderr: options.stderr ?? 'pipe',
		stdin: options.stdin ?? 'ignore',
		stdout: options.stdout ?? 'pipe'
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		processHandle.exited,
		options.stdout === 'inherit' ? Promise.resolve('') : new Response(processHandle.stdout).text(),
		options.stderr === 'inherit' ? Promise.resolve('') : new Response(processHandle.stderr).text()
	])

	return CommandResultSchema.parse({ exitCode, stderr, stdout })
}
