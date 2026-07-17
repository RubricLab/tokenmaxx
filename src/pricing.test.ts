import { describe, expect, test } from 'bun:test'
import { costUsd, priceFor } from './pricing.ts'

describe('priceFor', () => {
	test('current model generations use current list prices', () => {
		expect(priceFor('claude-fable-5')).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 })
		expect(priceFor('claude-opus-4-8')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
		expect(priceFor('claude-sonnet-4-6')).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 })
		expect(priceFor('claude-haiku-4-5-20251001')).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 })
		expect(priceFor('gpt-5.6-sol')).toMatchObject({ inputPerMTok: 1.25, outputPerMTok: 10 })
	})

	test('legacy opus generations keep their historical 15/75 pricing', () => {
		expect(priceFor('claude-opus-4-1')).toMatchObject({ inputPerMTok: 15, outputPerMTok: 75 })
		expect(priceFor('claude-opus-4-20250514')).toMatchObject({ inputPerMTok: 15, outputPerMTok: 75 })
	})

	test('cache reads are a tenth of input, anthropic cache writes 1.25x', () => {
		const opus = priceFor('claude-opus-4-8')
		expect(opus.cacheReadPerMTok).toBeCloseTo(opus.inputPerMTok * 0.1)
		expect(opus.cacheWritePerMTok).toBeCloseTo(opus.inputPerMTok * 1.25)
		expect(priceFor('gpt-5.6-sol').cacheWritePerMTok).toBe(0)
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
