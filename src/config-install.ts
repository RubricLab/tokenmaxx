import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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

// tokenmaxx owns its provider name: codex rewrites config.toml (sorting tables,
// dropping comments), which strips our markers and leaves a bare copy of the
// provider table — reclaim those too, or install stacks duplicates that break
// TOML parsing for codex and for us.
const bareProviderTable = /^\[model_providers\.(?:tokenmaxx|tokmax)\]\r?\n(?:(?!\[).*\r?\n?)*/gm
const ownProviderSelection = /^\s*model_provider\s*=\s*"(?:tokenmaxx|tokmax)"\s*$/

function stripCodexManagedBlocks(content: string): string {
	let base = stripMarkedBlock(content, tableBeginMarker, tableEndMarker)
	for (let index = 0; index < legacyBeginMarkers.length; index += 1) {
		base = stripMarkedBlock(base, legacyBeginMarkers[index] ?? '', legacyEndMarkers[index] ?? '')
	}
	base = base.replace(bareProviderTable, '')
	return (
		base
			.split('\n')
			// Drop selections of our own provider, including previously disabled
			// ones — restoring those on uninstall would point codex at a provider
			// that no longer exists.
			.filter(line => !ownProviderSelection.test(line.replace(disabledPrefix, '')))
			.map(line =>
				/^\s*model_provider\s*=/.test(line) ? `# tokenmaxx-disabled: ${line.trimStart()}` : line
			)
			.join('\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	)
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
	const carriesOurConfig = (content: string): boolean =>
		[...legacyBeginMarkers, tableBeginMarker].some(marker => content.includes(marker)) ||
		content.match(bareProviderTable) !== null ||
		content.split('\n').some(line => ownProviderSelection.test(line.replace(disabledPrefix, '')))
	if (existing === null || !carriesOurConfig(existing)) {
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
		([...legacyBeginMarkers, tableBeginMarker].some(marker => codexRaw.includes(marker)) ||
			codexRaw.match(bareProviderTable) !== null)

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

export interface PiResult {
	path: string
	applied: boolean
	manual: string | null
}

function piModelsPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'models.json')
}

const piProviderKeys = ['tokenmaxx-anthropic', 'tokenmaxx-openai']

// The anthropic ids pair with an API-key account (subscription auth is not for
// third-party harnesses); gpt-5.6-sol is the one id the ChatGPT codex backend
// accepts for subscription accounts.
const piAnthropicModelIds = ['claude-opus-4-8', 'claude-sonnet-4-6']
const piOpenaiModelIds = ['gpt-5.6-sol']

function piProviders(paths: ApplicationPaths): Record<string, unknown> {
	const models = (ids: readonly string[]) => ids.map(id => ({ id, reasoning: true }))
	return {
		'tokenmaxx-anthropic': {
			api: 'anthropic-messages',
			apiKey: dummyAuthToken,
			baseUrl: proxyBaseUrl(paths, 'anthropic'),
			models: models(piAnthropicModelIds)
		},
		'tokenmaxx-openai': {
			api: 'openai-responses',
			apiKey: dummyAuthToken,
			baseUrl: proxyBaseUrl(paths, 'openai'),
			models: models(piOpenaiModelIds)
		}
	}
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
	if (raw.trim().length === 0) {
		return {}
	}
	try {
		const parsed = JSON.parse(raw)
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = parent[key]
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		parent[key] = {}
	}
	return parent[key] as Record<string, unknown>
}

async function writePiProviders(
	providers: Record<string, unknown> | null,
	manual: string
): Promise<PiResult> {
	const path = piModelsPath()
	const raw = await readFileOrEmpty(path)
	const config = parseJsonObject(raw)
	if (config === null) {
		return { applied: false, manual, path }
	}
	const bucket = ensureObject(config, 'providers')
	for (const key of piProviderKeys) {
		delete bucket[key]
	}
	if (providers !== null) {
		Object.assign(bucket, providers)
	}
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
	return { applied: true, manual: null, path }
}

// pi re-reads models.json every time /model opens, so no restart is needed.
export async function installPiConfig(paths: ApplicationPaths): Promise<PiResult> {
	return writePiProviders(
		piProviders(paths),
		`could not parse it as JSON — add this under providers yourself:\n${JSON.stringify(piProviders(paths), null, 2)}`
	)
}

export async function uninstallPiConfig(): Promise<PiResult> {
	const raw = await readFile(piModelsPath(), 'utf8').catch(() => null)
	if (raw === null) {
		return { applied: false, manual: null, path: piModelsPath() }
	}
	return writePiProviders(
		null,
		'could not parse it as JSON — remove the tokenmaxx-anthropic and tokenmaxx-openai providers yourself'
	)
}

export interface PiStatus {
	present: boolean
	routed: boolean
}

// pi counts as present when its binary is on PATH or its agent directory
// exists — someone who installed pi but never launched it has only the binary.
export async function piStatus(
	which: (binary: string) => string | null = Bun.which
): Promise<PiStatus> {
	const path = piModelsPath()
	const raw = await readFile(path, 'utf8').catch(() => null)
	const present =
		raw !== null ||
		which('pi') !== null ||
		(await stat(dirname(dirname(path))).then(
			() => true,
			() => false
		))
	return { present, routed: raw?.includes('tokenmaxx-anthropic') ?? false }
}
