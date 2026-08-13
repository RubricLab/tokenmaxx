import { constants } from 'node:fs'
import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApplicationPaths } from './paths.ts'
import { ensureProxyToken, proxyBaseUrl, readProxyTokenIfPresent } from './paths.ts'

const providerName = 'quotanaut'
const topBeginMarker = '# >>> quotanaut managed (do not edit) >>>'
const topEndMarker = '# <<< quotanaut managed <<<'
const tableBeginMarker = '# >>> quotanaut provider (do not edit) >>>'
const tableEndMarker = '# <<< quotanaut provider <<<'
const disabledPrefix = /^#\s*quotanaut-disabled:\s*/

function codexConfigPath(): string {
	return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
}

async function readFileOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, 'utf8')
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return ''
		}
		throw error
	}
}

async function readFileOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf8')
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return null
		}
		throw error
	}
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && Reflect.get(error, 'code') === code
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

async function writePrivateFileAtomically(path: string, content: string): Promise<void> {
	const directory = dirname(path)
	await mkdir(directory, { recursive: true })
	const temporaryPath = join(
		directory,
		`.quotanaut-config-${process.pid}-${crypto.randomUUID()}.tmp`
	)
	let handle: FileHandle | null = null
	try {
		handle = await open(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600
		)
		await handle.writeFile(content, 'utf8')
		await handle.sync()
		await handle.chmod(0o600)
		await handle.close()
		handle = null
		await rename(temporaryPath, path)
		await syncDirectory(directory)
	} finally {
		await handle?.close().catch(() => undefined)
		await unlink(temporaryPath).catch(() => undefined)
	}
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
	let insideTable = false
	return stripMarkedBlock(
		stripMarkedBlock(content, tableBeginMarker, tableEndMarker),
		topBeginMarker,
		topEndMarker
	)
		.split('\n')
		.map(line => {
			const trimmed = line.trimStart()
			if (!trimmed.startsWith('#') && trimmed.startsWith('[')) {
				insideTable = true
			}
			return !insideTable && /^model_provider\s*=/.test(trimmed)
				? `# quotanaut-disabled: ${trimmed}`
				: line
		})
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

function buildCodexManagedConfig(
	paths: ApplicationPaths,
	clientToken: string
): {
	top: string
	table: string
} {
	return {
		table: [
			tableBeginMarker,
			`[model_providers.${providerName}]`,
			`name = "${providerName}"`,
			`base_url = "${proxyBaseUrl(paths)}"`,
			'wire_api = "responses"',
			'requires_openai_auth = false',
			`experimental_bearer_token = "${clientToken}"`,
			tableEndMarker
		].join('\n'),
		top: [topBeginMarker, `model_provider = "${providerName}"`, topEndMarker].join('\n')
	}
}

export async function installCodexConfig(paths: ApplicationPaths): Promise<string> {
	const path = codexConfigPath()
	const clientToken = await ensureProxyToken(paths)
	const base = stripCodexManagedBlocks(await readFileOrEmpty(path))
	const managed = buildCodexManagedConfig(paths, clientToken)
	const body = base.length === 0 ? '' : `${base}\n\n`
	await writePrivateFileAtomically(path, `${managed.top}\n\n${body}${managed.table}\n`)
	return path
}

export async function uninstallCodexConfig(): Promise<string | null> {
	const path = codexConfigPath()
	const existing = await readFileOrNull(path)
	if (
		existing === null ||
		![topBeginMarker, tableBeginMarker].some(marker => existing.includes(marker))
	) {
		return null
	}
	await writePrivateFileAtomically(path, restoreCodexContent(existing))
	return path
}

export interface InstallStatus {
	codexRouted: boolean
	codexStale: boolean
}

export async function installStatus(paths: ApplicationPaths): Promise<InstallStatus> {
	const codexRaw = await readFileOrEmpty(codexConfigPath())
	const clientToken = await readProxyTokenIfPresent(paths)
	let codexRouted = false
	try {
		const parsed = Bun.TOML.parse(codexRaw) as {
			model_provider?: unknown
			model_providers?: Record<
				string,
				{
					base_url?: unknown
					experimental_bearer_token?: unknown
					requires_openai_auth?: unknown
				}
			>
		}
		const selected = typeof parsed.model_provider === 'string' ? parsed.model_provider : null
		const provider = selected === null ? undefined : parsed.model_providers?.[selected]
		codexRouted =
			selected === providerName &&
			provider?.base_url === proxyBaseUrl(paths) &&
			provider.requires_openai_auth === false &&
			clientToken !== null &&
			provider.experimental_bearer_token === clientToken
	} catch {
		codexRouted = false
	}
	const codexStale =
		!codexRouted && [topBeginMarker, tableBeginMarker].some(marker => codexRaw.includes(marker))
	return { codexRouted, codexStale }
}
