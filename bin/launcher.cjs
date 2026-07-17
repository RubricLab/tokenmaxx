#!/usr/bin/env node
'use strict'

// tokenmaxx runs on the Bun runtime (bun:sqlite, Bun.TOML, Bun.spawn, …), but it
// should install cleanly with any package manager. npm/pnpm/yarn create a shim
// that runs this file with node; `bun add -g` runs it with bun. Either way this
// launcher finds a Bun binary and hands the real bundle to it, so the published
// `#!/usr/bin/env bun` shebang never has to resolve on the caller's PATH.

const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const bundle = join(__dirname, 'index.js')
const isWindows = process.platform === 'win32'
const bunName = isWindows ? 'bun.exe' : 'bun'

function findBun() {
	// Already running under Bun (the `bun add -g` shim) — reuse this very runtime.
	if (process.versions.bun) {
		return process.execPath
	}
	const candidates = []
	if (process.env.BUN_INSTALL) {
		candidates.push(join(process.env.BUN_INSTALL, 'bin', bunName))
	}
	candidates.push(join(homedir(), '.bun', 'bin', bunName))
	if (!isWindows) {
		candidates.push('/opt/homebrew/bin/bun', '/usr/local/bin/bun')
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate
		}
	}
	// Last resort: ask the shell to resolve it off PATH.
	const lookup = isWindows
		? spawnSync('where', [bunName], { encoding: 'utf8' })
		: spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' })
	if (lookup.status === 0) {
		const resolved = lookup.stdout.trim().split('\n')[0]
		if (resolved) {
			return resolved
		}
	}
	return null
}

const bun = findBun()
if (!bun) {
	process.stderr.write(
		'tokenmaxx runs on the Bun runtime, which was not found on this system.\n' +
			'Install Bun, then run tokenmaxx again:\n' +
			'  curl -fsSL https://bun.sh/install | bash\n' +
			'(see https://bun.sh for other install methods)\n'
	)
	process.exit(1)
}

const result = spawnSync(bun, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) {
	process.stderr.write(`tokenmaxx: could not start Bun (${result.error.message})\n`)
	process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
