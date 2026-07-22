import type { FetchImplementation, ProviderId } from './domain.ts'
import { ApplicationError, errorMessage, isNetworkFailure } from './errors.ts'
import { observeRateLimitHeaders, type RateLimitObservation } from './ratelimit.ts'

export interface UpstreamInjection {
	accountId: string
	baseUrl: string
	headers: Record<string, string>
	appendHeaders?: Record<string, string>
	stripHeaders?: readonly string[]
	dialect?: 'chatgpt'
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

interface ProxyOptions {
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
	cache_read_input_tokens?: number
	cache_creation_input_tokens?: number
	input_tokens_details?: { cached_tokens?: number }
}

interface SseEvent {
	type?: string
	model?: string
	message?: { model?: string; usage?: SseUsage }
	usage?: SseUsage
	response?: { model?: string; usage?: SseUsage }
}

export function createUsageObserver(
	provider: ProviderId,
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
	let cacheCreation = 0
	let saw = false

	const consume = (text: string): void => {
		let event: SseEvent
		try {
			event = JSON.parse(text) as SseEvent
		} catch {
			return
		}
		if (provider === 'anthropic') {
			if (event.type === 'message_start' && event.message) {
				model = event.message.model ?? model
				const usage = event.message.usage ?? {}
				input += usage.input_tokens ?? 0
				cacheCreation += usage.cache_creation_input_tokens ?? 0
				cacheRead += usage.cache_read_input_tokens ?? 0
				saw = true
			} else if (event.type === 'message_delta' && event.usage) {
				output = event.usage.output_tokens ?? output
				saw = true
			} else if (event.type === 'message' && event.usage) {
				model = event.model ?? model
				input += event.usage.input_tokens ?? 0
				cacheCreation += event.usage.cache_creation_input_tokens ?? 0
				cacheRead += event.usage.cache_read_input_tokens ?? 0
				output += event.usage.output_tokens ?? 0
				saw = true
			}
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
			if (saw && input + output + cacheRead + cacheCreation > 0) {
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

const proxyFingerprint = 'tokenmaxx proxy'

export async function proxyIdentity(port: number): Promise<'tokenmaxx' | 'foreign' | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			signal: AbortSignal.timeout(1_000)
		})
		const body = await response.text()
		return body.startsWith(proxyFingerprint) ? 'tokenmaxx' : 'foreign'
	} catch {
		return null
	}
}

interface ResponsesInputMessage {
	role?: string
	content?: { type?: string; text?: string }[]
}

function messageText(item: ResponsesInputMessage): string {
	return (Array.isArray(item.content) ? item.content : [])
		.map(part => part.text ?? '')
		.filter(text => text.length > 0)
		.join('\n')
}

// The ChatGPT codex backend rejects requests third-party harnesses send to a
// standard Responses endpoint: system messages must ride in `instructions`
// ("System messages are not allowed") and `max_output_tokens` is unsupported.
export function adaptChatGptRequest(raw: string): string {
	let parsed: { input?: unknown; instructions?: unknown; [key: string]: unknown }
	try {
		parsed = JSON.parse(raw) as typeof parsed
	} catch {
		return raw
	}
	if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.input)) {
		return raw
	}
	const isSystem = (item: unknown): item is ResponsesInputMessage => {
		const role = (item as ResponsesInputMessage | null)?.role
		return role === 'system' || role === 'developer'
	}
	const lifted = parsed.input.filter(isSystem).map(messageText)
	const instructions = [
		...(typeof parsed.instructions === 'string' ? [parsed.instructions] : []),
		...lifted
	]
		.filter(text => text.length > 0)
		.join('\n\n')
	const { max_output_tokens: _dropped, ...rest } = parsed
	return JSON.stringify({
		...rest,
		input: parsed.input.filter(item => !isSystem(item)),
		...(instructions.length > 0 ? { instructions } : {})
	})
}

const strippedRequestHeaders = [
	'host',
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
const strippedResponseHeaders = ['content-encoding', 'content-length', 'transfer-encoding']

function routeProvider(pathname: string): { provider: ProviderId; rest: string } | null {
	const match = pathname.match(/^\/(openai|anthropic)(\/.*)?$/)
	if (match === null) {
		return null
	}
	return { provider: match[1] as ProviderId, rest: match[2] ?? '/' }
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

function proxyErrorResponse(
	provider: ProviderId,
	status: number,
	kind: string,
	message: string
): Response {
	const payload =
		provider === 'anthropic'
			? { error: { message, type: 'api_error' }, type: 'error' }
			: { error: { code: kind, message, type: 'api_error' } }
	return new Response(`${JSON.stringify(payload)}\n`, {
		headers: { 'content-type': 'application/json', 'x-tokenmaxx-error': kind },
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

interface ProxyHandler {
	handle(request: Request): Promise<Response>
}

function createProxyHandler(options: ProxyOptions): ProxyHandler {
	const doFetch = options.fetchImplementation ?? fetch
	return {
		async handle(request) {
			const url = new URL(request.url)
			const route = routeProvider(url.pathname)
			if (route === null) {
				return new Response(`${proxyFingerprint}: unknown route\n`, { status: 404 })
			}
			const body =
				request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
			const send = (injection: UpstreamInjection): Promise<Response> =>
				doFetch(`${injection.baseUrl.replace(/\/$/, '')}${route.rest}${url.search}`, {
					body:
						injection.dialect === 'chatgpt' && body !== undefined
							? adaptChatGptRequest(new TextDecoder().decode(body))
							: body,
					headers: forwardHeaders(request.headers, injection),
					method: request.method,
					redirect: 'manual',
					signal: request.signal
				})
			const reportLimits = (
				accountId: string,
				response: Response
			): { observation: RateLimitObservation; deliver: () => Promise<void> } | null => {
				const observation = observeRateLimitHeaders(route.provider, response.headers, response.status)
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

			const providerLabel = route.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
			let injection: UpstreamInjection | null
			try {
				injection = await options.source.resolve(route.provider)
			} catch (error) {
				if (isNetworkFailure(error)) {
					return proxyErrorResponse(
						route.provider,
						502,
						'credential-refresh-unreachable',
						`tokenmaxx proxy: could not refresh ${route.provider} credentials — ${errorMessage(error)}. The refresh token is still valid; retry shortly.`
					)
				}
				return proxyErrorResponse(
					route.provider,
					503,
					'credential-unusable',
					`tokenmaxx proxy: ${errorMessage(error)}`
				)
			}
			if (injection === null) {
				return proxyErrorResponse(
					route.provider,
					503,
					'no-active-account',
					`tokenmaxx proxy: no active ${route.provider} account`
				)
			}

			let served = injection
			let response: Response
			try {
				response = await send(served)
			} catch (error) {
				return proxyErrorResponse(
					route.provider,
					502,
					'upstream-unreachable',
					`tokenmaxx proxy: could not reach ${served.baseUrl} — ${errorMessage(error)}. The request never left this machine (local network/DNS/VPN problem), so this is not an ${providerLabel} API error.`
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
					void finalReport.deliver()
				}
			}

			const forwarded = passThrough(response)
			if (options.record !== undefined && response.ok && forwarded.body !== null) {
				const servedAccountId = served.accountId
				const observer = createUsageObserver(route.provider, usage =>
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

export function upstreamFor(provider: ProviderId): string {
	switch (provider) {
		case 'openai':
			return 'https://chatgpt.com/backend-api/codex'
		case 'anthropic':
			return 'https://api.anthropic.com'
	}
	throw new ApplicationError('UNKNOWN_PROVIDER', `No upstream for provider ${provider}`)
}
