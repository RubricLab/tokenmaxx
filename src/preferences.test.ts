import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPreferences, writePreferences } from './preferences.ts'

let home: string
let environment: NodeJS.ProcessEnv

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'tokenmaxx-preferences-'))
	environment = { TOKENMAXX_HOME: home }
})

afterEach(async () => {
	await rm(home, { force: true, recursive: true })
})

describe('preferences', () => {
	test('defaults to auto before anything is written', async () => {
		expect(await readPreferences(environment)).toEqual({ theme: 'auto' })
	})

	test('round-trips a stored theme', async () => {
		await writePreferences({ theme: 'light' }, environment)
		expect(await readPreferences(environment)).toEqual({ theme: 'light' })
	})

	test('falls back to auto when the file is corrupt', async () => {
		await writeFile(join(home, 'preferences.json'), '{ not json')
		expect(await readPreferences(environment)).toEqual({ theme: 'auto' })
	})

	test('falls back to auto when the stored theme is not one we know', async () => {
		await writeFile(join(home, 'preferences.json'), JSON.stringify({ theme: 'gruvbox' }))
		expect(await readPreferences(environment)).toEqual({ theme: 'auto' })
	})

	test('keeps the file private to the user', async () => {
		await writePreferences({ theme: 'dark' }, environment)
		const stat = await Bun.file(join(home, 'preferences.json')).stat()
		expect(stat.mode & 0o777).toBe(0o600)
	})
})
