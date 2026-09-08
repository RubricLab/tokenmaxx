import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ApplicationPaths } from './paths.ts'

const BackupSchema = z.object({
	directories: z.array(z.string()),
	installed: z.string(),
	original: z.string().nullable(),
	path: z.string()
})
const BackupsSchema = z.array(BackupSchema)
type Backup = z.infer<typeof BackupSchema>

async function backups(paths: ApplicationPaths): Promise<Backup[]> {
	try {
		return BackupsSchema.parse(
			JSON.parse(await readFile(join(paths.root, 'config-backups.json'), 'utf8'))
		)
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
		throw error
	}
}

export async function saveConfigBackup(
	paths: ApplicationPaths,
	path: string,
	installed: string,
	originalOverride?: string
): Promise<void> {
	const records = await backups(paths)
	let record = records.find(item => item.path === path)
	if (record === undefined) {
		const original =
			originalOverride ??
			(await readFile(path, 'utf8').catch(error => {
				if (error.code === 'ENOENT') return null
				throw error
			}))
		const directories: string[] = []
		for (
			let directory = dirname(path);
			!(await stat(directory).then(
				() => true,
				error => {
					if (error.code === 'ENOENT') return false
					throw error
				}
			));
			directory = dirname(directory)
		)
			directories.push(directory)
		record = { directories, installed, original, path }
		records.push(record)
	} else record.installed = installed
	await mkdir(paths.root, { mode: 0o700, recursive: true })
	await writeFile(join(paths.root, 'config-backups.json'), JSON.stringify(records), { mode: 0o600 })
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function undoJson(original: unknown, installed: unknown, current: unknown): unknown {
	if (isDeepStrictEqual(current, installed)) return original
	if (!object(current) || !object(installed)) return current
	const restored = { ...current }
	for (const key of new Set([
		...Object.keys(installed),
		...Object.keys(object(original) ? original : {})
	])) {
		const value = undoJson(object(original) ? original[key] : undefined, installed[key], current[key])
		if (value === undefined) delete restored[key]
		else restored[key] = value
	}
	return restored
}

export async function restoreConfigBackup(paths: ApplicationPaths, path: string): Promise<boolean> {
	const record = (await backups(paths)).find(item => item.path === path)
	if (record === undefined) return false
	const current = await readFile(path, 'utf8').catch(error => {
		if (error.code === 'ENOENT') return null
		throw error
	})
	const removeCreatedFile = async () => {
		await rm(path)
		for (const directory of record.directories) {
			await rmdir(directory).catch(error => {
				if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
			})
		}
	}
	if (current !== null && current !== record.original) {
		if (current === record.installed) {
			if (record.original === null) await removeCreatedFile()
			else await writeFile(path, record.original, { mode: 0o600 })
		} else {
			if (!path.endsWith('.json')) return false
			const restored = undoJson(
				record.original === null
					? undefined
					: record.original.trim() === ''
						? {}
						: JSON.parse(record.original),
				JSON.parse(record.installed),
				JSON.parse(current)
			)
			if (restored === undefined) await removeCreatedFile()
			else await writeFile(path, `${JSON.stringify(restored, null, 2)}\n`, { mode: 0o600 })
		}
	}
	await forgetConfigBackup(paths, path)
	return true
}

export async function forgetConfigBackup(paths: ApplicationPaths, path: string): Promise<void> {
	const records = await backups(paths)
	if (!records.some(record => record.path === path)) return
	await writeFile(
		join(paths.root, 'config-backups.json'),
		JSON.stringify(records.filter(record => record.path !== path)),
		{ mode: 0o600 }
	)
}

export async function recordedConfigPaths(paths: ApplicationPaths): Promise<string[]> {
	return (await backups(paths)).map(record => record.path)
}
