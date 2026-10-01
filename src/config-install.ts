import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type ProviderId, ProviderIdSchema } from './domain.ts'
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

function grokConfigPath(): string {
	return join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'config.toml')
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

const endpointBeginMarker = '# >>> tokenmaxx endpoint (do not edit) >>>'
const endpointEndMarker = '# <<< tokenmaxx endpoint <<<'
const grokEndpointKey = 'cli_chat_proxy_base_url'
const ownEndpointLine =
	/^\s*(?:endpoints\.)?cli_chat_proxy_base_url\s*=\s*"[^"]*127\.0\.0\.1:\d+\/xai\/v1"\s*$/
const anyEndpointLine = /^\s*(?:endpoints\.)?cli_chat_proxy_base_url\s*=/
const endpointsHeader = /^\s*\[endpoints\]\s*$/
const tableHeader = /^\s*\[/

function withoutMarkedLines(lines: string[]): string[] {
	const begin = lines.findIndex(line => line.trim() === endpointBeginMarker)
	const end = lines.findIndex(line => line.trim() === endpointEndMarker)
	return begin === -1 || end < begin ? lines : [...lines.slice(0, begin), ...lines.slice(end + 1)]
}

function stripGrokManagedBlocks(content: string): string {
	return withoutMarkedLines(content.split('\n'))
		.filter(line => !ownEndpointLine.test(line.replace(disabledPrefix, '')))
		.map(line => (anyEndpointLine.test(line) ? `# tokenmaxx-disabled: ${line.trimStart()}` : line))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

function dropEmptyEndpointsTable(lines: string[]): string[] {
	return lines.filter((line, index) => {
		if (!endpointsHeader.test(line)) {
			return true
		}
		const rest = lines.slice(index + 1)
		const next = rest.findIndex(candidate => candidate.trim().length > 0)
		return next !== -1 && !tableHeader.test(rest[next] ?? '')
	})
}

function restoreGrokContent(content: string): string {
	const restored = stripGrokManagedBlocks(content)
		.split('\n')
		.map(line => line.replace(disabledPrefix, ''))
	return `${dropEmptyEndpointsTable(restored).join('\n').trimEnd()}\n`
}

export async function installGrokConfig(paths: ApplicationPaths): Promise<string> {
	const path = grokConfigPath()
	const base = stripGrokManagedBlocks(await readFileOrEmpty(path))
	const managedLine = `${grokEndpointKey} = "${proxyBaseUrl(paths, 'xai')}/v1"`
	const lines = base.length === 0 ? [] : base.split('\n')
	const header = lines.findIndex(line => endpointsHeader.test(line))
	const managed =
		header === -1
			? [
					...lines,
					...(lines.length === 0 ? [] : ['']),
					endpointBeginMarker,
					'[endpoints]',
					managedLine,
					endpointEndMarker
				]
			: [
					...lines.slice(0, header + 1),
					endpointBeginMarker,
					managedLine,
					endpointEndMarker,
					...lines.slice(header + 1)
				]
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${managed.join('\n')}\n`, { mode: 0o600 })
	return path
}

export async function uninstallGrokConfig(): Promise<string | null> {
	const path = grokConfigPath()
	const existing = await readFile(path, 'utf8').catch(() => null)
	const carriesOurConfig = (content: string): boolean =>
		content.includes(endpointBeginMarker) ||
		content.split('\n').some(line => ownEndpointLine.test(line) || disabledPrefix.test(line))
	if (existing === null || !carriesOurConfig(existing)) {
		return null
	}
	await writeFile(path, restoreGrokContent(existing), { mode: 0o600 })
	return path
}

export function installProviderConfig(
	provider: ProviderId,
	paths: ApplicationPaths
): Promise<string> {
	switch (provider) {
		case 'openai':
			return installCodexConfig(paths)
		case 'anthropic':
			return installClaudeConfig(paths)
		case 'xai':
			return installGrokConfig(paths)
	}
}

export function uninstallProviderConfig(provider: ProviderId): Promise<string | null> {
	switch (provider) {
		case 'openai':
			return uninstallCodexConfig()
		case 'anthropic':
			return uninstallClaudeConfig()
		case 'xai':
			return uninstallGrokConfig()
	}
}

interface InstallStatus {
	routed: Record<ProviderId, boolean>
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
		// Bun.TOML rejects configs codex accepts — bare table keys starting with a
		// digit, like [mcp_servers.1password]. Reading that as "not routed" makes
		// the dashboard show routing off while traffic flows through the proxy,
		// and turns the routing toggle into a re-install. Fall back to our own
		// active selection line, scanning only the top-level region: a
		// model_provider line under a table belongs to that table, not to codex.
		const firstTable = codexRaw.search(/^\[/m)
		const topLevel = firstTable === -1 ? codexRaw : codexRaw.slice(0, firstTable)
		codexRouted = topLevel.split('\n').some(line => ownProviderSelection.test(line))
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

	let grokRouted = false
	try {
		const parsed = Bun.TOML.parse(await readFileOrEmpty(grokConfigPath())) as {
			endpoints?: { cli_chat_proxy_base_url?: unknown }
		}
		const baseUrl = parsed.endpoints?.cli_chat_proxy_base_url
		grokRouted = typeof baseUrl === 'string' && baseUrl.includes('127.0.0.1')
	} catch {
		grokRouted = false
	}
	return { codexStale, routed: { anthropic: claudeRouted, openai: codexRouted, xai: grokRouted } }
}

// Configs written by an older version stay stale after an update (#17): re-apply
// install for whatever is currently routed, once per version change. Never adds
// routing — a harness the user uninstalled or never installed stays untouched.
export async function healInstalledConfigs(paths: ApplicationPaths): Promise<ProviderId[]> {
	const stampPath = join(paths.root, 'healed-version')
	if ((await readFileOrEmpty(stampPath)).trim() === VERSION) {
		return []
	}
	const { routed } = await installStatus()
	const healed: ProviderId[] = []
	for (const provider of ProviderIdSchema.options) {
		if (routed[provider]) {
			await installProviderConfig(provider, paths)
			healed.push(provider)
		}
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

const piProviderKeys = ['tokenmaxx-anthropic', 'tokenmaxx-openai', 'tokenmaxx-xai']

// The anthropic ids pair with an API-key account (subscription auth is not for
// third-party harnesses).
const piAnthropicModelIds = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5']
const piOpenaiModelIds = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']
const piXaiModelIds = ['grok-4.6']

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
		},
		'tokenmaxx-xai': {
			api: 'openai-responses',
			apiKey: dummyAuthToken,
			baseUrl: `${proxyBaseUrl(paths, 'xai')}/v1`,
			models: models(piXaiModelIds)
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
		`could not parse it as JSON — remove the ${piProviderKeys.join(', ')} providers yourself`
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
