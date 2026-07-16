import type { ProviderId } from './domain.ts'
import { ApplicationError, errorMessage, isNetworkFailure } from './errors.ts'
import type { FetchImplementation } from './http.ts'

export interface UpstreamInjection {
	baseUrl: string
	headers: Record<string, string>
	appendHeaders?: Record<string, string>
	stripHeaders?: readonly string[]
}

export interface ProxyCredentialSource {
	resolve(provider: ProviderId): Promise<UpstreamInjection | null>
	refresh(provider: ProviderId): Promise<void>
}

export interface ProxyUsageEvent {
	at: number
	provider: ProviderId
	model: string | null
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
}

export interface ProxyOptions {
	source: ProxyCredentialSource
	fetchImplementation?: FetchImplementation
	record?: (event: ProxyUsageEvent) => void
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

function createUsageObserver(
	provider: ProviderId,
	contentType: string,
	onUsage: (usage: {
		model: string | null
		inputTokens: number
		outputTokens: number
		cacheReadTokens: number
	}) => void
) {
	const decoder = new TextDecoder()
	const isSse = contentType.includes('text/event-stream')
	let lineBuffer = ''
	let jsonBuffer = ''
	let model: string | null = null
	let input = 0
	let output = 0
	let cacheRead = 0
	let saw = false
	const maxJson = 4_000_000

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
				input += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
				cacheRead += usage.cache_read_input_tokens ?? 0
				saw = true
			} else if (event.type === 'message_delta' && event.usage) {
				output = event.usage.output_tokens ?? output
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

	return {
		finish(): void {
			if (!isSse && jsonBuffer.length > 0) {
				consume(jsonBuffer)
			}
			if (saw && input + output + cacheRead > 0) {
				onUsage({
					cacheReadTokens: cacheRead,
					inputTokens: input,
					model: model && model.length > 0 ? model : null,
					outputTokens: output
				})
			}
		},
		push(chunk: Uint8Array): void {
			const text = decoder.decode(chunk, { stream: true })
			if (isSse) {
				lineBuffer += text
				let newline = lineBuffer.indexOf('\n')
				while (newline >= 0) {
					const line = lineBuffer.slice(0, newline).trim()
					lineBuffer = lineBuffer.slice(newline + 1)
					if (line.startsWith('data:')) {
						const payload = line.slice(5).trim()
						if (payload.length > 0 && payload !== '[DONE]') {
							consume(payload)
						}
					}
					newline = lineBuffer.indexOf('\n')
				}
			} else if (jsonBuffer.length < maxJson) {
				jsonBuffer += text
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

export interface ProxyHandler {
	handle(request: Request): Promise<Response>
}

export function createProxyHandler(options: ProxyOptions): ProxyHandler {
	const doFetch = options.fetchImplementation ?? fetch
	return {
		async handle(request) {
			const url = new URL(request.url)
			const route = routeProvider(url.pathname)
			if (route === null) {
				return new Response('tokenmaxx proxy: unknown route\n', { status: 404 })
			}
			const body =
				request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
			const send = (injection: UpstreamInjection): Promise<Response> =>
				doFetch(`${injection.baseUrl.replace(/\/$/, '')}${route.rest}${url.search}`, {
					body,
					headers: forwardHeaders(request.headers, injection),
					method: request.method,
					redirect: 'manual',
					signal: request.signal
				})

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
						`tokenmaxx proxy: could not refresh ${route.provider} credentials — ${errorMessage(error)}. This is a local network/DNS/VPN problem, not an ${providerLabel} API error.`
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

			let response: Response
			try {
				response = await send(injection)
			} catch (error) {
				return proxyErrorResponse(
					route.provider,
					502,
					'upstream-unreachable',
					`tokenmaxx proxy: could not reach ${injection.baseUrl} — ${errorMessage(error)}. The request never left this machine (local network/DNS/VPN problem), so this is not an ${providerLabel} API error.`
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
			const forwarded = passThrough(response)
			if (options.record !== undefined && response.ok && forwarded.body !== null) {
				const observer = createUsageObserver(
					route.provider,
					response.headers.get('content-type') ?? '',
					usage =>
						options.record?.({
							at: Date.now(),
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
