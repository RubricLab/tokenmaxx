import { chmod, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { z } from 'zod'
import type {
	Account,
	AnalyticsSnapshot,
	DashboardSnapshot,
	ProviderId,
	ResetCreditsView,
	ResetOutcome
} from './domain.ts'
import {
	AccountSchema,
	AnalyticsSnapshotSchema,
	DashboardSnapshotSchema,
	ProviderIdSchema,
	ResetCreditsViewSchema,
	ResetOutcomeSchema
} from './domain.ts'
import { ApplicationError, errorMessage } from './errors.ts'
import type { AccountManager } from './manager.ts'
import { VERSION } from './version.ts'

const RpcRequestSchema = z
	.object({
		id: z.number().int().nonnegative(),
		method: z.string().min(1),
		params: z.unknown().optional()
	})
	.strict()

const RpcResponseSchema = z
	.object({
		error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
		id: z.literal(1),
		result: z.unknown().optional()
	})
	.strict()
	.refine(response => (response.result === undefined) !== (response.error === undefined), {
		message: 'Manager response must contain exactly one result or error'
	})

const SwitchParamsSchema = z
	.object({
		provider: ProviderIdSchema,
		reason: z.string().min(1).optional(),
		targetAccountId: z.uuid()
	})
	.strict()

const PolicyParamsSchema = z
	.object({
		authorizationConfirmed: z.boolean().optional(),
		enabled: z.boolean().optional(),
		hiddenWindowIds: z.array(z.string()).optional(),
		hysteresisPercent: z.number().min(0).max(25).optional(),
		minimumDwellMilliseconds: z.number().int().min(0).optional(),
		provider: ProviderIdSchema,
		thresholdPercent: z.number().min(1).max(100).optional()
	})
	.strict()

const ResetParamsSchema = z.object({ accountId: z.uuid() }).strict()

const ReplaceCredentialParamsSchema = z
	.object({
		account: AccountSchema,
		removePrevious: z
			.object({ profilePath: z.string().nullable(), secretReference: z.string().nullable() })
			.strict()
	})
	.strict()

interface ManagerServer {
	close(): Promise<void>
	finished: Promise<void>
}

function writeResponse(socket: Socket, response: unknown): void {
	socket.write(`${JSON.stringify(response)}\n`)
}

async function dispatch(
	manager: AccountManager,
	method: string,
	params: unknown
): Promise<unknown> {
	switch (method) {
		case 'manager/ping':
			return { processId: process.pid, ready: true, version: VERSION }
		case 'dashboard/read':
			return manager.dashboard()
		case 'usage/refresh':
			await manager.refreshAll()
			return manager.dashboard()
		case 'proxy/port':
			return { port: manager.proxyPort }
		case 'dashboard/analytics':
			return manager.analytics()
		case 'provider/switch': {
			const parsed = SwitchParamsSchema.parse(params)
			await manager.switchAccount(parsed.provider, parsed.targetAccountId, parsed.reason)
			return manager.dashboard()
		}
		case 'policy/set': {
			const parsed = PolicyParamsSchema.parse(params)
			return manager.setAutomationPolicy(parsed)
		}
		case 'account/save': {
			const parsed = ReplaceCredentialParamsSchema.parse(params)
			await manager.saveAccount(parsed)
			return { saved: true }
		}
		case 'account/remove': {
			await manager.removeAccount(ResetParamsSchema.parse(params).accountId)
			return { removed: true }
		}
		case 'codex/resetCredits':
			return manager.codexResetCredits(ResetParamsSchema.parse(params).accountId)
		case 'codex/consumeReset':
			return manager.consumeCodexReset(ResetParamsSchema.parse(params).accountId)
		default:
			throw new ApplicationError('METHOD_NOT_FOUND', `Unknown manager method ${method}`)
	}
}

export async function startManagerServer(input: {
	manager: AccountManager
	socketPath: string
	onStop: () => void
}): Promise<ManagerServer> {
	await rm(input.socketPath, { force: true })
	let finish: (() => void) | undefined
	const finished = new Promise<void>(resolve => {
		finish = resolve
	})
	const server = createServer(socket => {
		socket.setEncoding('utf8')
		let buffer = ''
		socket.on('data', (chunk: string) => {
			buffer += chunk
			for (;;) {
				const newline = buffer.indexOf('\n')
				if (newline < 0) {
					return
				}
				const line = buffer.slice(0, newline).trim()
				buffer = buffer.slice(newline + 1)
				if (line.length === 0) {
					continue
				}
				void (async () => {
					let decoded: unknown
					try {
						decoded = JSON.parse(line)
					} catch {
						writeResponse(socket, {
							error: { code: 'INVALID_JSON', message: 'Request is not valid JSON' },
							id: 0
						})
						return
					}
					const parsed = RpcRequestSchema.safeParse(decoded)
					if (!parsed.success) {
						writeResponse(socket, {
							error: { code: 'INVALID_REQUEST', message: z.prettifyError(parsed.error) },
							id: 0
						})
						return
					}
					if (parsed.data.method === 'manager/stop') {
						writeResponse(socket, { id: parsed.data.id, result: { stopping: true } })
						setTimeout(input.onStop, 10)
						return
					}
					try {
						const result = await dispatch(input.manager, parsed.data.method, parsed.data.params)
						writeResponse(socket, { id: parsed.data.id, result })
					} catch (error) {
						writeResponse(socket, {
							error: {
								code: error instanceof ApplicationError ? error.code : 'INTERNAL_ERROR',
								message: errorMessage(error)
							},
							id: parsed.data.id
						})
					}
				})()
			}
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(input.socketPath, resolve)
	})
	await chmod(input.socketPath, 0o600)

	async function close(): Promise<void> {
		await new Promise<void>(resolve => server.close(() => resolve()))
		await rm(input.socketPath, { force: true })
		finish?.()
	}

	return { close, finished }
}

export async function managerRequest<Result>(input: {
	socketPath: string
	method: string
	params?: unknown
	schema: { parse(value: unknown): Result }
	timeoutMilliseconds?: number
}): Promise<Result> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(input.socketPath)
		let buffer = ''
		const timeout = setTimeout(() => {
			socket.destroy()
			reject(new ApplicationError('MANAGER_TIMEOUT', `${input.method} timed out`))
		}, input.timeoutMilliseconds ?? 15_000)
		socket.setEncoding('utf8')
		socket.once('connect', () => {
			socket.write(`${JSON.stringify({ id: 1, method: input.method, params: input.params })}\n`)
		})
		socket.on('data', (chunk: string) => {
			buffer += chunk
			const newline = buffer.indexOf('\n')
			if (newline < 0) {
				return
			}
			clearTimeout(timeout)
			socket.end()
			try {
				const response = RpcResponseSchema.parse(JSON.parse(buffer.slice(0, newline)))
				if (response.error !== undefined) {
					reject(new ApplicationError(response.error.code, response.error.message))
				} else {
					resolve(input.schema.parse(response.result))
				}
			} catch (error) {
				reject(error)
			}
		})
		socket.once('error', error => {
			clearTimeout(timeout)
			reject(error)
		})
	})
}

const PingSchema = z
	.object({
		processId: z.number().int().positive(),
		ready: z.literal(true),
		version: z.string().optional()
	})
	.loose()

export async function managerAvailable(socketPath: string): Promise<boolean> {
	return managerRequest({
		method: 'manager/ping',
		schema: PingSchema,
		socketPath,
		timeoutMilliseconds: 500
	})
		.then(() => true)
		.catch(() => false)
}

export async function managerVersion(socketPath: string): Promise<string | null> {
	return managerRequest({
		method: 'manager/ping',
		schema: PingSchema,
		socketPath,
		timeoutMilliseconds: 500
	})
		.then(result => result.version ?? 'pre-0.0.9')
		.catch(() => null)
}

export function readDashboard(socketPath: string): Promise<DashboardSnapshot> {
	return managerRequest({
		method: 'dashboard/read',
		schema: DashboardSnapshotSchema,
		socketPath,
		timeoutMilliseconds: 15_000
	})
}

export function readAnalytics(socketPath: string): Promise<AnalyticsSnapshot> {
	return managerRequest({
		method: 'dashboard/analytics',
		schema: AnalyticsSnapshotSchema,
		socketPath,
		timeoutMilliseconds: 15_000
	})
}

export function refreshUsage(socketPath: string): Promise<DashboardSnapshot> {
	return managerRequest({
		method: 'usage/refresh',
		schema: DashboardSnapshotSchema,
		socketPath,
		timeoutMilliseconds: 60_000
	})
}

export function requestSwitch(
	socketPath: string,
	provider: ProviderId,
	targetAccountId: string
): Promise<DashboardSnapshot> {
	return managerRequest({
		method: 'provider/switch',
		params: { provider, reason: 'manual', targetAccountId },
		schema: DashboardSnapshotSchema,
		socketPath,
		timeoutMilliseconds: 30_000
	})
}

export function requestAccountRemove(socketPath: string, accountId: string): Promise<unknown> {
	return managerRequest({
		method: 'account/remove',
		params: { accountId },
		schema: z.unknown(),
		socketPath,
		timeoutMilliseconds: 20_000
	})
}

export function requestResetCredits(
	socketPath: string,
	accountId: string
): Promise<ResetCreditsView> {
	return managerRequest({
		method: 'codex/resetCredits',
		params: { accountId },
		schema: ResetCreditsViewSchema,
		socketPath,
		timeoutMilliseconds: 20_000
	})
}

export function requestConsumeReset(socketPath: string, accountId: string): Promise<ResetOutcome> {
	return managerRequest({
		method: 'codex/consumeReset',
		params: { accountId },
		schema: ResetOutcomeSchema,
		socketPath,
		timeoutMilliseconds: 45_000
	})
}

export function readProxyPort(socketPath: string): Promise<number> {
	return managerRequest({
		method: 'proxy/port',
		schema: z.object({ port: z.number().int().positive() }),
		socketPath,
		timeoutMilliseconds: 15_000
	}).then(result => result.port)
}

export function requestPolicy(
	socketPath: string,
	input: {
		provider: ProviderId
		enabled?: boolean
		thresholdPercent?: number
		authorizationConfirmed?: boolean
		minimumDwellMilliseconds?: number
		hysteresisPercent?: number
		hiddenWindowIds?: string[]
	}
): Promise<void> {
	return managerRequest({
		method: 'policy/set',
		params: input,
		schema: z.unknown(),
		socketPath,
		timeoutMilliseconds: 15_000
	}).then(() => undefined)
}

export function requestAccountSave(
	socketPath: string,
	account: Account,
	removePrevious: { secretReference: string | null; profilePath: string | null }
): Promise<void> {
	return managerRequest({
		method: 'account/save',
		params: { account, removePrevious },
		schema: z.object({ saved: z.literal(true) }),
		socketPath,
		timeoutMilliseconds: 15_000
	}).then(() => undefined)
}
