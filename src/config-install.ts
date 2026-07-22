import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApplicationPaths } from './paths.ts'
import { proxyBaseUrl } from './paths.ts'

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
	settings.env = {
		...settings.env,
		ANTHROPIC_AUTH_TOKEN: dummyAuthToken,
		ANTHROPIC_BASE_URL: proxyBaseUrl(paths, 'anthropic')
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

export type HarnessTarget = 'openclaw' | 'pi' | 'hermes'

export interface HarnessResult {
	path: string
	applied: boolean
	manual: string | null
}

function openclawConfigPath(): string {
	return process.env.OPENCLAW_CONFIG_PATH ?? join(homedir(), '.openclaw', 'openclaw.json')
}

function piModelsPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'models.json')
}

function hermesConfigPath(): string {
	return join(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), 'config.yaml')
}

const anthropicModels = [
	{ contextWindow: 200_000, id: 'claude-opus-4-8', maxTokens: 32_000, name: 'Opus via tokenmaxx' },
	{
		contextWindow: 200_000,
		id: 'claude-sonnet-4-6',
		maxTokens: 32_000,
		name: 'Sonnet via tokenmaxx'
	}
]
// The ChatGPT codex backend accepts exactly this model id for subscription
// accounts (probed 2026-07-22; gpt-5.6-codex and friends are all rejected).
const openaiModels = [
	{ contextWindow: 400_000, id: 'gpt-5.6-sol', maxTokens: 128_000, name: 'GPT via tokenmaxx' }
]

function openclawProviders(paths: ApplicationPaths): Record<string, unknown> {
	const zeroCost = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
	const model = (entry: (typeof anthropicModels)[number]) => ({
		contextWindow: entry.contextWindow,
		cost: zeroCost,
		id: entry.id,
		input: ['text', 'image'],
		maxTokens: entry.maxTokens,
		name: entry.name,
		reasoning: true
	})
	return {
		'tokenmaxx-anthropic': {
			api: 'anthropic-messages',
			apiKey: dummyAuthToken,
			baseUrl: proxyBaseUrl(paths, 'anthropic'),
			models: anthropicModels.map(model)
		},
		'tokenmaxx-openai': {
			api: 'openai-responses',
			apiKey: dummyAuthToken,
			baseUrl: proxyBaseUrl(paths, 'openai'),
			models: openaiModels.map(model)
		}
	}
}

function piProviders(paths: ApplicationPaths): Record<string, unknown> {
	return {
		'tokenmaxx-anthropic': {
			api: 'anthropic-messages',
			apiKey: dummyAuthToken,
			baseUrl: proxyBaseUrl(paths, 'anthropic'),
			models: anthropicModels.map(entry => ({ id: entry.id, reasoning: true }))
		},
		'tokenmaxx-openai': {
			api: 'openai-responses',
			apiKey: dummyAuthToken,
			baseUrl: proxyBaseUrl(paths, 'openai'),
			models: openaiModels.map(entry => ({ id: entry.id, reasoning: true }))
		}
	}
}

function hermesManagedBlock(paths: ApplicationPaths): string {
	return [
		topBeginMarker,
		'providers:',
		'  tokenmaxx-anthropic:',
		`    base_url: "${proxyBaseUrl(paths, 'anthropic')}"`,
		`    api_key: "${dummyAuthToken}"`,
		'    api_mode: "anthropic_messages"',
		'  tokenmaxx-openai:',
		`    base_url: "${proxyBaseUrl(paths, 'openai')}"`,
		`    api_key: "${dummyAuthToken}"`,
		'    api_mode: "codex_responses"',
		topEndMarker
	].join('\n')
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

async function writeJsonProviders(
	path: string,
	providersOf: (config: Record<string, unknown>) => Record<string, unknown>,
	providers: Record<string, unknown> | null,
	manual: string
): Promise<HarnessResult> {
	const raw = await readFileOrEmpty(path)
	const config = parseJsonObject(raw)
	if (config === null) {
		return { applied: false, manual, path }
	}
	const bucket = providersOf(config)
	for (const key of ['tokenmaxx-anthropic', 'tokenmaxx-openai']) {
		delete bucket[key]
	}
	if (providers !== null) {
		Object.assign(bucket, providers)
	}
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
	return { applied: true, manual: null, path }
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = parent[key]
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		parent[key] = {}
	}
	return parent[key] as Record<string, unknown>
}

function openclawBucket(config: Record<string, unknown>): Record<string, unknown> {
	return ensureObject(ensureObject(config, 'models'), 'providers')
}

function piBucket(config: Record<string, unknown>): Record<string, unknown> {
	return ensureObject(config, 'providers')
}

export async function installHarnessConfig(
	target: HarnessTarget,
	paths: ApplicationPaths
): Promise<HarnessResult> {
	if (target === 'openclaw') {
		return writeJsonProviders(
			openclawConfigPath(),
			openclawBucket,
			openclawProviders(paths),
			`could not parse it as JSON (JSON5 comments?) — add this under models.providers yourself:\n${JSON.stringify(openclawProviders(paths), null, 2)}`
		)
	}
	if (target === 'pi') {
		return writeJsonProviders(
			piModelsPath(),
			piBucket,
			piProviders(paths),
			`could not parse it as JSON — add this under providers yourself:\n${JSON.stringify(piProviders(paths), null, 2)}`
		)
	}
	const path = hermesConfigPath()
	const raw = await readFileOrEmpty(path)
	const stripped = stripMarkedBlock(raw, topBeginMarker, topEndMarker).trimEnd()
	if (/^providers\s*:/m.test(stripped)) {
		return {
			applied: false,
			manual: `it already defines providers, and yaml duplicate keys silently override — merge this into that mapping yourself:\n${hermesManagedBlock(paths)}`,
			path
		}
	}
	await mkdir(dirname(path), { recursive: true })
	await writeFile(
		path,
		`${stripped.length === 0 ? '' : `${stripped}\n\n`}${hermesManagedBlock(paths)}\n`,
		{ mode: 0o600 }
	)
	return { applied: true, manual: null, path }
}

export async function uninstallHarnessConfig(target: HarnessTarget): Promise<HarnessResult> {
	if (target === 'openclaw' || target === 'pi') {
		const path = target === 'openclaw' ? openclawConfigPath() : piModelsPath()
		const raw = await readFile(path, 'utf8').catch(() => null)
		if (raw === null) {
			return { applied: false, manual: null, path }
		}
		return writeJsonProviders(
			path,
			target === 'openclaw' ? openclawBucket : piBucket,
			null,
			'could not parse it as JSON — remove the tokenmaxx-anthropic and tokenmaxx-openai providers yourself'
		)
	}
	const path = hermesConfigPath()
	const raw = await readFile(path, 'utf8').catch(() => null)
	if (raw === null || !raw.includes(topBeginMarker)) {
		return { applied: false, manual: null, path }
	}
	await writeFile(path, `${stripMarkedBlock(raw, topBeginMarker, topEndMarker).trim()}\n`, {
		mode: 0o600
	})
	return { applied: true, manual: null, path }
}

export interface HarnessStatus {
	target: HarnessTarget
	present: boolean
	routed: boolean
}

// A harness counts as present when its binary is on PATH or its config
// exists — someone who installed openclaw but never launched it has the
// binary and no config dir.
export async function harnessStatus(
	which: (binary: string) => string | null = Bun.which
): Promise<HarnessStatus[]> {
	const entries: { target: HarnessTarget; path: string }[] = [
		{ path: openclawConfigPath(), target: 'openclaw' },
		{ path: piModelsPath(), target: 'pi' },
		{ path: hermesConfigPath(), target: 'hermes' }
	]
	return Promise.all(
		entries.map(async ({ target, path }) => {
			const raw = await readFile(path, 'utf8').catch(() => null)
			const configDir = dirname(target === 'pi' ? dirname(path) : path)
			const present =
				raw !== null ||
				which(target) !== null ||
				(await stat(configDir).then(
					() => true,
					() => false
				))
			return { present, routed: raw?.includes('tokenmaxx-anthropic') ?? false, target }
		})
	)
}
