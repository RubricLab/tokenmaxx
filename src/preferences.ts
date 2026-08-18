import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { applicationPaths } from './paths.ts'

const PreferencesSchema = z.object({
	theme: z.enum(['auto', 'dark', 'light'])
})
export type Preferences = z.infer<typeof PreferencesSchema>

const DEFAULT_PREFERENCES: Preferences = { theme: 'auto' }

function preferencesPath(environment: NodeJS.ProcessEnv): string {
	return join(applicationPaths(environment).root, 'preferences.json')
}

// Nothing here reaches the manager, so a missing or hand-mangled file falls back to the defaults
// instead of keeping the dashboard shut.
export async function readPreferences(
	environment: NodeJS.ProcessEnv = process.env
): Promise<Preferences> {
	try {
		const raw = await readFile(preferencesPath(environment), 'utf8')
		const parsed = PreferencesSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : DEFAULT_PREFERENCES
	} catch {
		return DEFAULT_PREFERENCES
	}
}

export async function writePreferences(
	preferences: Preferences,
	environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
	await writeFile(preferencesPath(environment), `${JSON.stringify(preferences, null, '\t')}\n`, {
		mode: 0o600
	})
}
