import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import packageJson from '../package.json'

export const VERSION: string = packageJson.version

// The version on disk, which an update may have moved past this running process.
export async function installedVersion(): Promise<string> {
	try {
		const raw = await readFile(join(import.meta.dir, '..', 'package.json'), 'utf8')
		const { version } = JSON.parse(raw) as { version?: unknown }
		return typeof version === 'string' ? version : VERSION
	} catch {
		return VERSION
	}
}
