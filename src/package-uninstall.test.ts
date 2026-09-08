import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeGlobalPackage } from './package-uninstall.ts'

test('the owning package manager removes the global CLI and leaves other packages alone', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'tmx-package-'))
	const previousPath = process.env.PATH
	try {
		const globalDirectory = join(directory, 'global')
		const packageRoot = join(globalDirectory, 'node_modules', 'tokenmaxx')
		const otherPackage = join(globalDirectory, 'node_modules', 'other')
		const executable = join(directory, 'bin', 'bun')
		await mkdir(join(packageRoot, 'dist'), { recursive: true })
		await mkdir(otherPackage)
		await mkdir(join(directory, 'bin'))
		await writeFile(join(packageRoot, 'package.json'), '{"name":"tokenmaxx"}')
		await writeFile(join(packageRoot, 'dist', 'index.js'), '')
		await writeFile(join(otherPackage, 'keep'), 'unrelated package')
		await writeFile(
			executable,
			`#!${process.execPath}
import { rm } from 'node:fs/promises'
const arguments_ = process.argv.slice(2)
if (JSON.stringify(arguments_) === JSON.stringify(['pm', '-g', 'ls'])) {
  process.stdout.write(${JSON.stringify(`${globalDirectory} node_modules (2 installed)\n`)})
} else if (JSON.stringify(arguments_) === JSON.stringify(['remove', '-g', 'tokenmaxx'])) {
  await rm(${JSON.stringify(packageRoot)}, { recursive: true })
} else process.exit(1)
`
		)
		await chmod(executable, 0o755)
		process.env.PATH = `${join(directory, 'bin')}:${previousPath ?? ''}`
		expect(await removeGlobalPackage(join(packageRoot, 'dist', 'index.js'))).toBe(true)
		expect(await Bun.file(join(packageRoot, 'package.json')).exists()).toBe(false)
		expect(await Bun.file(join(otherPackage, 'keep')).exists()).toBe(true)
		expect(await removeGlobalPackage(join(import.meta.dir, 'index.ts'))).toBe(false)
	} finally {
		if (previousPath === undefined) delete process.env.PATH
		else process.env.PATH = previousPath
		await rm(directory, { force: true, recursive: true })
	}
})
