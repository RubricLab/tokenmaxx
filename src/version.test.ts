import { expect, test } from 'bun:test'
import { installedVersion, VERSION } from './version.ts'

test('the version on disk matches the running build in a source checkout', async () => {
	expect(await installedVersion()).toBe(VERSION)
})
