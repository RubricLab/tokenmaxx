import packageJson from '../package.json'

export const VERSION: string = packageJson.version

function parts(version: string): number[] {
	return version.split('.').map(part => Number.parseInt(part, 10) || 0)
}

function isNewerVersion(candidate: string, current: string): boolean {
	const a = parts(candidate)
	const b = parts(current)
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const left = a[index] ?? 0
		const right = b[index] ?? 0
		if (left !== right) {
			return left > right
		}
	}
	return false
}

async function latestPublishedVersion(): Promise<string | null> {
	try {
		const response = await fetch('https://registry.npmjs.org/tokenmaxx/latest', {
			signal: AbortSignal.timeout(1_500)
		})
		if (!response.ok) {
			return null
		}
		const body = (await response.json()) as { version?: unknown }
		return typeof body.version === 'string' ? body.version : null
	} catch {
		return null
	}
}

export async function availableUpdate(): Promise<string | null> {
	const latest = await latestPublishedVersion()
	return latest !== null && isNewerVersion(latest, VERSION) ? latest : null
}
