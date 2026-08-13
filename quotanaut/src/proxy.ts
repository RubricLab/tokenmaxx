import { createHash, timingSafeEqual } from 'node:crypto'
import type { FetchImplementation, ProviderId } from './domain.ts'
import { ApplicationError, errorMessage, isNetworkFailure } from './errors.ts'
import { observeRateLimitHeaders, type RateLimitObservation } from './ratelimit.ts'

export interface UpstreamInjection {
	accountId: string
	baseUrl: string
	headers: Record<string, string>
	appendHeaders?: Record<string, string>
	stripHeaders?: readonly string[]
}

interface ProxyCredentialSource {
	resolve(provider: ProviderId): Promise<UpstreamInjection | null>
	refresh(provider: ProviderId): Promise<void>
}

interface ProxyUsageEvent {
	at: number
	provider: ProviderId
	accountId: string
	model: string | null
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheCreationTokens: number
}

export interface ProxyLimitEvent {
	at: number
	provider: ProviderId
	accountId: string
	observation: RateLimitObservation
}

export interface ProxyOptions {
	clientToken: string
	source: ProxyCredentialSource
	fetchImplementation?: FetchImplementation
	record?: (event: ProxyUsageEvent) => void
	observeLimits?: (event: ProxyLimitEvent) => Promise<void> | void
}

interface SseUsage {
	input_tokens?: number
	prompt_tokens?: number
	output_tokens?: number
	completion_tokens?: number
	input_tokens_details?: { cached_tokens?: number }
}

interface SseEvent {
	model?: string
	usage?: SseUsage
	response?: { model?: string; usage?: SseUsage }
}

export function createUsageObserver(
	onUsage: (usage: {
		model: string | null
		inputTokens: number
		outputTokens: number
		cacheReadTokens: number
		cacheCreationTokens: number
	}) => void
) {
	const decoder = new TextDecoder()
	const maxBuffered = 4_000_000
	let lineBuffer = ''
	let raw = ''
	let sawSseData = false
	let model: string | null = null
	let input = 0
	let output = 0
	let cacheRead = 0
	const cacheCreation = 0
	let saw = false

	const consume = (text: string): void => {
		let event: SseEvent
		try {
			event = JSON.parse(text) as SseEvent
		} catch {
			return
		}
		const usage = event.response?.usage ?? event.usage
		if (usage) {
			const cached = usage.input_tokens_details?.cached_tokens ?? 0
			input = Math.max(0, (usage.input_tokens ?? usage.prompt_tokens ?? input) - cached)
			cacheRead = cached
			output = usage.output_tokens ?? usage.completion_tokens ?? output
			model = event.response?.model ?? event.model ?? model
			saw = true
		}
	}

	const consumeLine = (line: string): void => {
		if (!line.startsWith('data:')) {
			return
		}
		sawSseData = true
		const payload = line.slice(5).trim()
		if (payload.length > 0 && payload !== '[DONE]') {
			consume(payload)
		}
	}

	return {
		finish(): void {
			consumeLine(lineBuffer.trim())
			if (!saw && !sawSseData && raw.trim().length > 0) {
				consume(raw.trim())
			}
			if (saw && input + output + cacheRead > 0) {
				onUsage({
					cacheCreationTokens: cacheCreation,
					cacheReadTokens: cacheRead,
					inputTokens: input,
					model: model && model.length > 0 ? model : null,
					outputTokens: output
				})
			}
		},
		push(chunk: Uint8Array): void {
			const text = decoder.decode(chunk, { stream: true })
			if (raw.length < maxBuffered) {
				raw += text
			}
			lineBuffer += text
			let newline = lineBuffer.indexOf('\n')
			while (newline >= 0) {
				consumeLine(lineBuffer.slice(0, newline).trim())
				lineBuffer = lineBuffer.slice(newline + 1)
				newline = lineBuffer.indexOf('\n')
			}
			if (lineBuffer.length > maxBuffered) {
				lineBuffer = ''
			}
		}
	}
}

function observeStream(
	body: ReadableStream<Uint8Array>,
	observer: ReturnType<typeof createUsageObserver>
): ReadableStream<Uint8Array> {
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			flush() {
				try {
					observer.finish()
				} catch {}
			},
			transform(chunk, controller) {
				controller.enqueue(chunk)
				try {
					observer.push(chunk)
				} catch {}
			}
		})
	)
}

const proxyFingerprint = 'quotanaut proxy'

export async function proxyIdentity(port: number): Promise<'quotanaut' | 'foreign' | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			signal: AbortSignal.timeout(1_000)
		})
		const body = await response.text()
		return body.startsWith(proxyFingerprint) ? 'quotanaut' : 'foreign'
	} catch {
		return null
	}
}

const strippedRequestHeaders = [
	'host',
	'authorization',
	'chatgpt-account-id',
	'cookie',
	'openai-account-id',
	'openai-organization',
	'openai-project',
	'x-openai-account-id',
	'x-openai-organization',
	'x-openai-project',
	'x-api-key',
	'connection',
	'keep-alive',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-length'
]
const strippedResponseHeaders = [
	'content-encoding',
	'content-length',
	'set-cookie',
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]

function routeProvider(pathname: string): { provider: ProviderId; rest: string } | null {
	const match = pathname.match(/^\/openai(\/.*)?$/)
	if (match === null) {
		return null
	}
	return { provider: 'openai', rest: match[1] ?? '/' }
}

function tokensMatch(expected: string, actual: string | null): boolean {
	if (actual === null) {
		return false
	}
	const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
	const actualDigest = createHash('sha256').update(actual, 'utf8').digest()
	return timingSafeEqual(expectedDigest, actualDigest)
}

function forwardHeaders(incoming: Headers, injection: UpstreamInjection): Headers {
	const headers = new Headers(incoming)
	for (const header of [...strippedRequestHeaders, ...(injection.stripHeaders ?? [])]) {
		headers.delete(header)
	}
	for (const [name, value] of Object.entries(injection.headers)) {
		headers.set(name, value)
	}
	for (const [name, value] of Object.entries(injection.appendHeaders ?? {})) {
		const parts = new Set(
			(headers.get(name) ?? '')
				.split(',')
				.map(part => part.trim())
				.filter(part => part.length > 0)
		)
		parts.add(value)
		headers.set(name, [...parts].join(','))
	}
	return headers
}

function proxyErrorResponse(status: number, kind: string, message: string): Response {
	const payload = { error: { code: kind, message, type: 'api_error' } }
	return new Response(`${JSON.stringify(payload)}\n`, {
		headers: { 'content-type': 'application/json', 'x-quotanaut-error': kind },
		status
	})
}

function passThrough(response: Response): Response {
	const headers = new Headers(response.headers)
	for (const header of strippedResponseHeaders) {
		headers.delete(header)
	}
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText
	})
}

export interface ProxyHandler {
	handle(request: Request): Promise<Response>
}

export function createProxyHandler(options: ProxyOptions): ProxyHandler {
	if (options.clientToken.length === 0) {
		throw new ApplicationError('PROXY_CLIENT_TOKEN_MISSING', 'Proxy client token must not be empty')
	}
	const doFetch = options.fetchImplementation ?? fetch
	return {
		async handle(request) {
			const url = new URL(request.url)
			const route = routeProvider(url.pathname)
			if (route === null) {
				return new Response(`${proxyFingerprint}: unknown route\n`, { status: 404 })
			}
			if (!tokensMatch(`Bearer ${options.clientToken}`, request.headers.get('authorization'))) {
				return proxyErrorResponse(
					401,
					'proxy-authentication-required',
					'quotanaut proxy: valid client authentication is required'
				)
			}
			const body =
				request.method === 'GET' || request.method === 'HEAD'
					? undefined
					: await request.arrayBuffer()
			const send = (injection: UpstreamInjection): Promise<Response> =>
				doFetch(`${injection.baseUrl.replace(/\/$/, '')}${route.rest}${url.search}`, {
					body,
					headers: forwardHeaders(request.headers, injection),
					method: request.method,
					redirect: 'manual',
					signal: request.signal
				})
			const reportLimits = (
				accountId: string,
				response: Response
			): { observation: RateLimitObservation; deliver: () => Promise<void> } | null => {
				const observation = observeRateLimitHeaders(
					route.provider,
					response.headers,
					response.status
				)
				if (observation === null || options.observeLimits === undefined) {
					return null
				}
				const deliver = async () => {
					try {
						await options.observeLimits?.({
							accountId,
							at: Date.now(),
							observation,
							provider: route.provider
						})
					} catch {}
				}
				return { deliver, observation }
			}

			let injection: UpstreamInjection | null
			try {
				injection = await options.source.resolve(route.provider)
			} catch (error) {
				if (isNetworkFailure(error)) {
					return proxyErrorResponse(
						502,
						'credential-refresh-unreachable',
						`quotanaut proxy: could not refresh ${route.provider} credentials — ${errorMessage(error)}. The refresh token is still valid; retry shortly.`
					)
				}
				return proxyErrorResponse(
					503,
					'credential-unusable',
					`quotanaut proxy: ${errorMessage(error)}`
				)
			}
			if (injection === null) {
				return proxyErrorResponse(
					503,
					'no-active-account',
					`quotanaut proxy: no active ${route.provider} account`
				)
			}

			let served = injection
			let response: Response
			try {
				response = await send(served)
			} catch (error) {
				return proxyErrorResponse(
					502,
					'upstream-unreachable',
					`quotanaut proxy: could not reach ${served.baseUrl} — ${errorMessage(error)}. The request never left this machine (local network/DNS/VPN problem), so this is not an OpenAI API error.`
				)
			}
			if (response.status === 401) {
				const originalStatus = response.status
				const originalStatusText = response.statusText
				const originalHeaders = response.headers
				const originalBody = await response.arrayBuffer().catch(() => new ArrayBuffer(0))
				let retried: Response | null = null
				try {
					await options.source.refresh(route.provider)
					const refreshed = await options.source.resolve(route.provider)
					if (refreshed !== null) {
						retried = await send(refreshed)
						served = refreshed
					}
				} catch {}
				response =
					retried ??
					new Response(originalBody, {
						headers: originalHeaders,
						status: originalStatus,
						statusText: originalStatusText
					})
			}

			let reported = false
			if (response.status === 429) {
				const limitReport = reportLimits(served.accountId, response)
				if (limitReport !== null) {
					await limitReport.deliver()
					reported = true
					let next: UpstreamInjection | null = null
					try {
						next = await options.source.resolve(route.provider)
					} catch {}
					if (next !== null && next.accountId !== served.accountId) {
						try {
							const retried = await send(next)
							void response.body?.cancel().catch(() => undefined)
							served = next
							response = retried
							reported = false
						} catch {}
					}
				}
			}
			if (!reported) {
				const finalReport = reportLimits(served.accountId, response)
				if (finalReport !== null) {
					if (response.status === 429) {
						await finalReport.deliver()
					} else {
						void finalReport.deliver()
					}
				}
			}

			const forwarded = passThrough(response)
			if (options.record !== undefined && response.ok && forwarded.body !== null) {
				const servedAccountId = served.accountId
				const observer = createUsageObserver(usage =>
					options.record?.({
						accountId: servedAccountId,
						at: Date.now(),
						cacheCreationTokens: usage.cacheCreationTokens,
						cacheReadTokens: usage.cacheReadTokens,
						inputTokens: usage.inputTokens,
						model: usage.model,
						outputTokens: usage.outputTokens,
						provider: route.provider
					})
				)
				return new Response(observeStream(forwarded.body, observer), {
					headers: forwarded.headers,
					status: forwarded.status,
					statusText: forwarded.statusText
				})
			}
			return forwarded
		}
	}
}

export interface RunningProxy {
	port: number
	stop(): Promise<void>
}

export function startProxy(options: ProxyOptions & { port?: number }): RunningProxy {
	const handler = createProxyHandler(options)
	const server = Bun.serve({
		fetch: request => handler.handle(request),
		hostname: '127.0.0.1',
		idleTimeout: 0,
		port: options.port ?? 0
	})
	const port = server.port
	if (port === undefined) {
		throw new ApplicationError('PROXY_BIND_FAILED', 'Proxy did not bind a port')
	}
	return {
		port,
		async stop() {
			await server.stop(true)
		}
	}
}

export function upstreamFor(_provider: ProviderId): string {
	return 'https://chatgpt.com/backend-api/codex'
}
