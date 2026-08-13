import { describe, expect, test } from 'bun:test'
import { observeRateLimitHeaders } from './ratelimit.ts'

describe('observeRateLimitHeaders', () => {
	test('codex primary window and additional feature limits', () => {
		const headers = new Headers({
			'x-codex-bengalfox-limit-name': 'GPT-5.3-Codex-Spark',
			'x-codex-bengalfox-primary-reset-at': '1784847212',
			'x-codex-bengalfox-primary-used-percent': '3',
			'x-codex-bengalfox-primary-window-minutes': '10080',
			'x-codex-bengalfox-secondary-used-percent': '0',
			'x-codex-bengalfox-secondary-window-minutes': '0',
			'x-codex-primary-reset-at': '1784780264',
			'x-codex-primary-used-percent': '18',
			'x-codex-primary-window-minutes': '10080',
			'x-codex-secondary-used-percent': '0',
			'x-codex-secondary-window-minutes': '0'
		})
		const observation = observeRateLimitHeaders('openai', headers, 200)
		expect(observation?.limited).toBe(false)
		const byId = new Map(observation?.windows.map(window => [window.id, window]))
		expect(byId.get('codex:primary')).toEqual({
			id: 'codex:primary',
			kind: 'hard',
			label: '7 day',
			resetAt: new Date(1784780264 * 1000).toISOString(),
			usedPercent: 18
		})
		expect(byId.get('codex_bengalfox:primary')?.label).toBe('GPT-5.3-Codex-Spark · 7 day')
		expect(byId.has('codex:secondary')).toBe(false)
		expect(byId.has('codex_bengalfox:secondary')).toBe(false)
	})

	test('codex 429 with no headers still reports limited', () => {
		const observation = observeRateLimitHeaders('openai', new Headers(), 429)
		expect(observation?.limited).toBe(true)
		expect(observation?.windows).toEqual([])
	})

	test('responses without rate-limit headers observe nothing', () => {
		expect(
			observeRateLimitHeaders('openai', new Headers({ 'content-type': 'text/plain' }), 200)
		).toBeNull()
	})
})
