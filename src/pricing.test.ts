import { describe, expect, test } from 'bun:test'
import { costUsd, priceFor } from './pricing.ts'

describe('priceFor', () => {
	test('current model generations use current list prices', () => {
		expect(priceFor('claude-fable-5-1')).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 })
		expect(priceFor('claude-opus-5-5')).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 })
		expect(priceFor('claude-opus-5')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
		expect(priceFor('claude-sonnet-5')).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 })
		expect(priceFor('claude-haiku-4-5-20251001')).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 })
		expect(priceFor('gpt-6-astra')).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 })
		expect(priceFor('gpt-6-sol')).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 })
		expect(priceFor('gpt-6-luna')).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5 })
		expect(priceFor('gpt-5.6-sol')).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 })
		expect(priceFor('gpt-5.6-terra')).toMatchObject({ inputPerMTok: 2, outputPerMTok: 12 })
		expect(priceFor('gpt-5.6-luna')).toMatchObject({ inputPerMTok: 0.2, outputPerMTok: 1.2 })
	})

	test('earlier generations keep their own prices', () => {
		expect(priceFor('claude-fable-5')).toMatchObject({ cacheReadPerMTok: 1, inputPerMTok: 10 })
		expect(priceFor('claude-opus-4-8')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
		expect(priceFor('claude-opus-4-1')).toMatchObject({ inputPerMTok: 15, outputPerMTok: 75 })
		expect(priceFor('claude-opus-4-20250514')).toMatchObject({ inputPerMTok: 15, outputPerMTok: 75 })
		expect(priceFor('claude-sonnet-4-6')).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 })
		expect(priceFor('gpt-5.5')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 30 })
		expect(priceFor('gpt-5.3-codex')).toMatchObject({ inputPerMTok: 1.75, outputPerMTok: 14 })
		expect(priceFor('gpt-5')).toMatchObject({ inputPerMTok: 1.25, outputPerMTok: 10 })
	})

	test('cache reads are a tenth of input, anthropic cache writes 1.25x', () => {
		const opus = priceFor('claude-opus-4-8')
		expect(opus.cacheReadPerMTok).toBeCloseTo(opus.inputPerMTok * 0.1)
		expect(opus.cacheWritePerMTok).toBeCloseTo(opus.inputPerMTok * 1.25)
	})

	test('fable 5.1 and opus 5.5 discount cache reads below a tenth of input', () => {
		expect(priceFor('claude-fable-5-1').cacheReadPerMTok).toBe(0.25)
		expect(priceFor('claude-opus-5-5').cacheReadPerMTok).toBe(0.2)
	})

	test('openai bills cache writes from gpt-5.6 on', () => {
		expect(priceFor('gpt-6-sol').cacheWritePerMTok).toBe(2.5)
		expect(priceFor('gpt-5.6-sol').cacheWritePerMTok).toBe(5)
		expect(priceFor('gpt-5.5').cacheWritePerMTok).toBe(0)
	})
})

describe('costUsd', () => {
	test('prices each token class at its own rate', () => {
		expect(costUsd('claude-fable-5', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(73.5)
	})

	test('cache-heavy traffic is dominated by the cache-read rate', () => {
		const cost = costUsd('claude-fable-5', 10_000, 5_000, 10_000_000, 100_000)
		expect(cost).toBeCloseTo(0.1 + 0.25 + 10 + 1.25, 5)
	})
})
