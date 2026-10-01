import { access, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ApplicationError } from './errors.ts'

export async function removeGlobalPackage(entrypoint: string): Promise<boolean> {
	const packageRoot = await realpath(join(dirname(entrypoint), '..'))
	if (
		await access(join(packageRoot, '.git')).then(
			() => true,
			() => false
		)
	)
		return false
	const packageJson = await Bun.file(join(packageRoot, 'package.json')).json()
	if (packageJson.name !== 'tokenmaxx')
		throw new ApplicationError(
			'PACKAGE_UNINSTALL_FAILED',
			'Cannot identify the tokenmaxx package directory'
		)
	const managers = [
		{ name: 'bun', query: ['pm', '-g', 'ls'], remove: ['remove', '-g', 'tokenmaxx'] },
		{ name: 'npm', query: ['root', '-g'], remove: ['uninstall', '-g', 'tokenmaxx'] },
		{ name: 'pnpm', query: ['root', '-g'], remove: ['remove', '-g', 'tokenmaxx'] },
		{ name: 'yarn', query: ['global', 'dir'], remove: ['global', 'remove', 'tokenmaxx'] }
	]
	for (const manager of managers) {
		const binary = Bun.which(manager.name, { PATH: process.env.PATH })
		if (binary === null) continue
		const query = Bun.spawn([binary, ...manager.query], {
			stderr: 'ignore',
			stdin: 'ignore',
			stdout: 'pipe'
		})
		const output = (await new Response(query.stdout).text()).trim()
		if ((await query.exited) !== 0) continue
		const directory =
			manager.name === 'bun' ? output.split('\n')[0]?.replace(/ node_modules.*$/, '') : output
		if (!directory) continue
		const candidate = join(
			directory,
			...(['bun', 'yarn'].includes(manager.name) ? ['node_modules'] : []),
			'tokenmaxx'
		)
		if ((await realpath(candidate).catch(() => null)) !== packageRoot) continue
		const removal = Bun.spawn([binary, ...manager.remove], {
			stderr: 'inherit',
			stdin: 'ignore',
			stdout: 'inherit'
		})
		if ((await removal.exited) !== 0)
			throw new ApplicationError(
				'PACKAGE_UNINSTALL_FAILED',
				`${manager.name} could not remove tokenmaxx; retry ${manager.name} ${manager.remove.join(' ')}`
			)
		return true
	}
	throw new ApplicationError(
		'PACKAGE_UNINSTALL_FAILED',
		'Setup was removed, but the package manager could not be identified. Remove tokenmaxx with the package manager that installed it.'
	)
}
