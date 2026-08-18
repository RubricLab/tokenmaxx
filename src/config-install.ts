import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApplicationPaths } from './paths.ts'
import { proxyBaseUrl } from './paths.ts'
import { VERSION } from './version.ts'

const providerName = 'tokenmaxx'
const topBeginMarker = '# >>> tokenmaxx managed (do not edit) >>>'
const topEndMarker = '# <<< tokenmaxx managed <<<'
const tableBeginMarker = '# >>> tokenmaxx provider (do not edit) >>>'
const tableEndMarker = '# <<< tokenmaxx provider <<<'
const dummyAuthToken = 'managed-by-tokenmaxx'
const legacyBeginMarkers = [topBeginMarker, '# >>> tokmax managed (do not edit) >>>']
const legacyEndMarkers = [topEndMarker, '# <<< tokmax managed <<<']
const legacyDummyTokens = [dummyAuthToken, 'managed-by-tokmax']
const disabledPrefix = /^#\s*(?:tokenmaxx|tokmax)-disabled:\s*/

function codexConfigPath(): string {
	return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
}

function claudeSettingsPath(): string {
	return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')
}

async function readFileOrEmpty(path: string): Promise<string> {
	return readFile(path, 'utf8').catch(() => '')
}

function stripMarkedBlock(content: string, beginMarker: string, endMarker: string): string {
	const begin = content.indexOf(beginMarker)
	const end = content.indexOf(endMarker)
	if (begin === -1 || end === -1 || end <= begin) {
		return content
	}
	return `${content.slice(0, begin)}${content.slice(end + endMarker.length)}`
}

function stripCodexManagedBlocks(content: string): string {
	let base = stripMarkedBlock(content, tableBeginMarker, tableEndMarker)
	for (let index = 0; index < legacyBeginMarkers.length; index += 1) {
		base = stripMarkedBlock(base, legacyBeginMarkers[index] ?? '', legacyEndMarkers[index] ?? '')
	}
	return base
		.split('\n')
		.map(line =>
			/^\s*model_provider\s*=/.test(line) ? `# tokenmaxx-disabled: ${line.trimStart()}` : line
		)
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

function restoreCodexContent(content: string): string {
	const stripped = stripCodexManagedBlocks(content)
	return `${stripped
		.split('\n')
		.map(line => line.replace(disabledPrefix, ''))
		.join('\n')
		.trimEnd()}\n`
}

function buildCodexManagedConfig(paths: ApplicationPaths): { top: string; table: string } {
	return {
		table: [
			tableBeginMarker,
			`[model_providers.${providerName}]`,
			`name = "${providerName}"`,
			`base_url = "${proxyBaseUrl(paths, 'openai')}"`,
			'wire_api = "responses"',
			'requires_openai_auth = true',
			tableEndMarker
		].join('\n'),
		top: [topBeginMarker, `model_provider = "${providerName}"`, topEndMarker].join('\n')
	}
}

export async function installCodexConfig(paths: ApplicationPaths): Promise<string> {
	const path = codexConfigPath()
	const base = stripCodexManagedBlocks(await readFileOrEmpty(path))
	const managed = buildCodexManagedConfig(paths)
	const body = base.length === 0 ? '' : `${base}\n\n`
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${managed.top}\n\n${body}${managed.table}\n`, { mode: 0o600 })
	return path
}

export async function uninstallCodexConfig(): Promise<string | null> {
	const path = codexConfigPath()
	const existing = await readFile(path, 'utf8').catch(() => null)
	if (
		existing === null ||
		![...legacyBeginMarkers, tableBeginMarker].some(marker => existing.includes(marker))
	) {
		return null
	}
	await writeFile(path, restoreCodexContent(existing), { mode: 0o600 })
	return path
}

interface ClaudeSettings {
	env?: Record<string, string>
	[key: string]: unknown
}

export async function installClaudeConfig(paths: ApplicationPaths): Promise<string> {
	const path = claudeSettingsPath()
	const raw = await readFileOrEmpty(path)
	let settings: ClaudeSettings = {}
	if (raw.trim().length > 0) {
		try {
			settings = JSON.parse(raw) as ClaudeSettings
		} catch {
			settings = {}
		}
	}
	// Base URL only: any set ANTHROPIC_AUTH_TOKEN switches Claude Code off its
	// claude.ai login, losing connectors and MCP; the proxy injects credentials itself.
	settings.env = { ...settings.env, ANTHROPIC_BASE_URL: proxyBaseUrl(paths, 'anthropic') }
	if (legacyDummyTokens.includes(settings.env.ANTHROPIC_AUTH_TOKEN ?? '')) {
		delete settings.env.ANTHROPIC_AUTH_TOKEN
	}
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
	return path
}

export async function uninstallClaudeConfig(): Promise<string | null> {
	const path = claudeSettingsPath()
	const raw = await readFile(path, 'utf8').catch(() => null)
	if (raw === null) {
		return null
	}
	let settings: ClaudeSettings
	try {
		settings = JSON.parse(raw) as ClaudeSettings
	} catch {
		return null
	}
	if (settings.env === undefined) {
		return null
	}
	const { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ...rest } = settings.env
	const managed =
		(ANTHROPIC_AUTH_TOKEN !== undefined && legacyDummyTokens.includes(ANTHROPIC_AUTH_TOKEN)) ||
		(ANTHROPIC_BASE_URL?.includes('127.0.0.1') ?? false)
	if (!managed) {
		return null
	}
	if (ANTHROPIC_AUTH_TOKEN !== undefined && !legacyDummyTokens.includes(ANTHROPIC_AUTH_TOKEN)) {
		rest.ANTHROPIC_AUTH_TOKEN = ANTHROPIC_AUTH_TOKEN
	}
	if (Object.keys(rest).length === 0) {
		settings.env = undefined
	} else {
		settings.env = rest
	}
	const cleaned = Object.fromEntries(
		Object.entries(settings).filter(([, value]) => value !== undefined)
	)
	await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`, { mode: 0o600 })
	return path
}

interface InstallStatus {
	codexRouted: boolean
	claudeRouted: boolean
	codexStale: boolean
}

export async function installStatus(): Promise<InstallStatus> {
	const codexRaw = await readFileOrEmpty(codexConfigPath())
	let codexRouted = false
	try {
		const parsed = Bun.TOML.parse(codexRaw) as {
			model_provider?: unknown
			model_providers?: Record<string, { base_url?: unknown }>
		}
		const selected = typeof parsed.model_provider === 'string' ? parsed.model_provider : null
		const baseUrl = selected === null ? undefined : parsed.model_providers?.[selected]?.base_url
		codexRouted = typeof baseUrl === 'string' && baseUrl.includes('127.0.0.1')
	} catch {
		codexRouted = false
	}
	const codexStale =
		!codexRouted &&
		[...legacyBeginMarkers, tableBeginMarker].some(marker => codexRaw.includes(marker))

	let claudeRouted = false
	try {
		const settings = JSON.parse(await readFileOrEmpty(claudeSettingsPath())) as ClaudeSettings
		claudeRouted = settings.env?.ANTHROPIC_BASE_URL?.includes('127.0.0.1') ?? false
	} catch {
		claudeRouted = false
	}
	return { claudeRouted, codexRouted, codexStale }
}

// Configs written by an older version stay stale after an update (#17): re-apply
// install for whatever is currently routed, once per version change. Never adds
// routing — a harness the user uninstalled or never installed stays untouched.
export async function healInstalledConfigs(paths: ApplicationPaths): Promise<string[]> {
	const stampPath = join(paths.root, 'healed-version')
	if ((await readFileOrEmpty(stampPath)).trim() === VERSION) {
		return []
	}
	const { claudeRouted, codexRouted } = await installStatus()
	const healed: string[] = []
	if (codexRouted) {
		await installCodexConfig(paths)
		healed.push('codex')
	}
	if (claudeRouted) {
		await installClaudeConfig(paths)
		healed.push('claude')
	}
	await mkdir(paths.root, { recursive: true })
	await writeFile(stampPath, `${VERSION}\n`)
	return healed
}
