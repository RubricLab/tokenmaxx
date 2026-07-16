import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApplicationPaths } from './paths.ts'
import { proxyBaseUrl } from './paths.ts'

const codexBeginMarker = '# >>> tokenmaxx managed (do not edit) >>>'
const codexEndMarker = '# <<< tokenmaxx managed <<<'
const dummyAuthToken = 'managed-by-tokenmaxx'
const legacyBeginMarkers = [codexBeginMarker, '# >>> tokmax managed (do not edit) >>>']
const legacyEndMarkers = [codexEndMarker, '# <<< tokmax managed <<<']
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

function stripCodexManagedBlock(content: string): string {
	let base = content
	for (let index = 0; index < legacyBeginMarkers.length; index += 1) {
		const beginMarker = legacyBeginMarkers[index] ?? ''
		const endMarker = legacyEndMarkers[index] ?? ''
		const begin = base.indexOf(beginMarker)
		const end = base.indexOf(endMarker)
		if (begin !== -1 && end !== -1 && end > begin) {
			base = `${base.slice(0, begin)}${base.slice(end + endMarker.length)}`
		}
	}
	return base
		.split('\n')
		.map(line =>
			/^\s*model_provider\s*=/.test(line) ? `# tokenmaxx-disabled: ${line.trimStart()}` : line
		)
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd()
}

function restoreCodexContent(content: string): string {
	const stripped = stripCodexManagedBlock(content)
	return `${stripped
		.split('\n')
		.map(line => line.replace(disabledPrefix, ''))
		.join('\n')
		.trimEnd()}\n`
}

export function buildCodexManagedBlock(paths: ApplicationPaths): string {
	const baseUrl = proxyBaseUrl(paths, 'openai')
	return [
		codexBeginMarker,
		`model_provider = "tokenmaxx"`,
		'',
		'[model_providers.tokenmaxx]',
		`name = "tokenmaxx"`,
		`base_url = "${baseUrl}"`,
		`wire_api = "responses"`,
		codexEndMarker
	].join('\n')
}

export async function installCodexConfig(paths: ApplicationPaths): Promise<string> {
	const path = codexConfigPath()
	const existing = await readFileOrEmpty(path)
	const base = stripCodexManagedBlock(existing)
	const body = base.length === 0 ? '' : `${base}\n\n`
	const next = `${body}${buildCodexManagedBlock(paths)}\n`
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, next, { mode: 0o600 })
	return path
}

export async function uninstallCodexConfig(): Promise<string | null> {
	const path = codexConfigPath()
	const existing = await readFile(path, 'utf8').catch(() => null)
	if (existing === null || !legacyBeginMarkers.some(marker => existing.includes(marker))) {
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

export async function isInstalled(): Promise<boolean> {
	return readFileOrEmpty(codexConfigPath()).then(
		content =>
			content.includes('model_providers.tokenmaxx') || content.includes('model_providers.tokmax')
	)
}
