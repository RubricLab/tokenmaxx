import { describe, expect, test } from 'bun:test'
import { createUsageObserver } from './proxy.ts'

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
