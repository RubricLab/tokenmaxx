import { describe, expect, test } from 'bun:test'
import { adaptChatGptRequest, createUsageObserver, proxyIdentity, startProxy } from './proxy.ts'

describe('chatgpt dialect adapter', () => {
	test('lifts system messages into instructions and drops max_output_tokens', () => {
		const adapted = JSON.parse(
			adaptChatGptRequest(
				JSON.stringify({
					input: [
						{ content: [{ text: 'You are a helpful agent.', type: 'input_text' }], role: 'system' },
						{ content: [{ text: 'hi', type: 'input_text' }], role: 'user' }
					],
					max_output_tokens: 4096,
					model: 'gpt-5.6-sol',
					store: false,
					stream: true
				})
			)
		)
		expect(adapted.instructions).toBe('You are a helpful agent.')
		expect(adapted.input).toHaveLength(1)
		expect(adapted.input[0].role).toBe('user')
		expect(adapted.max_output_tokens).toBeUndefined()
	})

	test('merges lifted developer messages after existing instructions', () => {
		const adapted = JSON.parse(
			adaptChatGptRequest(
				JSON.stringify({
					input: [
						{ content: [{ text: 'Prefer short replies.', type: 'input_text' }], role: 'developer' }
					],
					instructions: 'You are a coding agent.'
				})
			)
		)
		expect(adapted.instructions).toBe('You are a coding agent.\n\nPrefer short replies.')
		expect(adapted.input).toHaveLength(0)
	})

	test('leaves codex-shaped requests and non-json bodies alone', () => {
		const codexShaped = JSON.stringify({
			input: [{ content: [{ text: 'hi', type: 'input_text' }], role: 'user' }],
			instructions: 'You are Codex.'
		})
		expect(JSON.parse(adaptChatGptRequest(codexShaped))).toEqual(JSON.parse(codexShaped))
		expect(adaptChatGptRequest('not json')).toBe('not json')
	})
})

type Observed = {
	model: string | null
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheCreationTokens: number
}

function observe(provider: 'openai' | 'anthropic', body: string, chunkSize = 7): Observed | null {
	let seen: Observed | null = null
	const observer = createUsageObserver(provider, usage => {
		seen = usage
	})
	const bytes = new TextEncoder().encode(body)
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		observer.push(bytes.slice(offset, offset + chunkSize))
	}
	observer.finish()
	return seen
}

describe('createUsageObserver', () => {
	test('codex SSE stream without content-type', () => {
		const body = [
			'event: response.created',
			'data: {"type":"response.created","response":{"id":"resp_1"}}',
			'',
			'event: response.output_text.delta',
			'data: {"type":"response.output_text.delta","delta":"OK"}',
			'',
			'event: response.completed',
			'data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":21,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":16},"output_tokens":5,"total_tokens":26}}}',
			''
		].join('\n')
		expect(observe('openai', body)).toEqual({
			cacheCreationTokens: 0,
			cacheReadTokens: 16,
			inputTokens: 5,
			model: 'gpt-5.6-sol',
			outputTokens: 5
		})
	})

	test('anthropic SSE stream separates cache creation from input', () => {
		const body = [
			'event: message_start',
			'data: {"type":"message_start","message":{"model":"claude-fable-5","usage":{"input_tokens":8,"cache_creation_input_tokens":1200,"cache_read_input_tokens":90000,"output_tokens":1}}}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":417}}',
			'',
			'data: [DONE]',
			''
		].join('\n')
		expect(observe('anthropic', body)).toEqual({
			cacheCreationTokens: 1200,
			cacheReadTokens: 90000,
			inputTokens: 8,
			model: 'claude-fable-5',
			outputTokens: 417
		})
	})

	test('anthropic non-streaming JSON response', () => {
		const body = JSON.stringify({
			content: [{ text: 'Hello', type: 'text' }],
			model: 'claude-haiku-4-5-20251001',
			type: 'message',
			usage: {
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				input_tokens: 8,
				output_tokens: 1
			}
		})
		expect(observe('anthropic', body)).toEqual({
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			inputTokens: 8,
			model: 'claude-haiku-4-5-20251001',
			outputTokens: 1
		})
	})

	test('openai non-streaming JSON response', () => {
		const body = JSON.stringify({
			model: 'gpt-5.6-sol',
			object: 'response',
			usage: {
				input_tokens: 100,
				input_tokens_details: { cached_tokens: 60 },
				output_tokens: 20
			}
		})
		expect(observe('openai', body)).toEqual({
			cacheCreationTokens: 0,
			cacheReadTokens: 60,
			inputTokens: 40,
			model: 'gpt-5.6-sol',
			outputTokens: 20
		})
	})

	test('emits nothing for bodies without usage', () => {
		expect(observe('anthropic', '{"type":"error","error":{"message":"nope"}}')).toBeNull()
		expect(observe('openai', 'not json at all')).toBeNull()
	})

	test('final SSE line without trailing newline still counts', () => {
		const body =
			'data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":10,"output_tokens":2}}}'
		expect(observe('openai', body)?.outputTokens).toBe(2)
	})
})

describe('proxyIdentity', () => {
	test('recognizes any tokenmaxx proxy by its unknown-route response', async () => {
		const proxy = startProxy({
			source: { refresh: async () => undefined, resolve: async () => null }
		})
		expect(await proxyIdentity(proxy.port)).toBe('tokenmaxx')
		await proxy.stop()
	})

	test('reports a foreign listener without claiming it', async () => {
		const server = Bun.serve({
			fetch: () => new Response('hello'),
			hostname: '127.0.0.1',
			port: 0
		})
		const port = server.port
		if (port === undefined) {
			throw new Error('server did not bind')
		}
		expect(await proxyIdentity(port)).toBe('foreign')
		await server.stop(true)
	})

	test('reports a free port as nothing listening', async () => {
		const server = Bun.serve({
			fetch: () => new Response(''),
			hostname: '127.0.0.1',
			port: 0
		})
		const port = server.port
		if (port === undefined) {
			throw new Error('server did not bind')
		}
		await server.stop(true)
		expect(await proxyIdentity(port)).toBe(null)
	})
})
