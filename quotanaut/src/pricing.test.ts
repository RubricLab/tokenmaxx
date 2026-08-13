import { describe, expect, test } from 'bun:test'
import { costUsd, priceFor } from './pricing.ts'

describe('priceFor', () => {
	test('Codex model families retain their prices', () => {
		expect(priceFor('gpt-5.6-sol')).toMatchObject({ inputPerMTok: 1.25, outputPerMTok: 10 })
		expect(priceFor('gpt-5.3-codex')).toMatchObject({ inputPerMTok: 1.25, outputPerMTok: 10 })
		expect(priceFor('o4-mini')).toMatchObject({ inputPerMTok: 1.1, outputPerMTok: 4.4 })
	})

	test('Codex cache reads are discounted and cache creation is not charged separately', () => {
		const codex = priceFor('gpt-5.6-sol')
		expect(codex.cacheReadPerMTok).toBeCloseTo(codex.inputPerMTok * 0.1)
		expect(codex.cacheWritePerMTok).toBe(0)
	})
})

describe('costUsd', () => {
	test('prices each token class at its own rate', () => {
		expect(costUsd('gpt-5.6-sol', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(11.375)
	})

	test('cache-heavy traffic uses the Codex cache-read rate', () => {
		const cost = costUsd('gpt-5.6-sol', 10_000, 5_000, 10_000_000, 100_000)
		expect(cost).toBeCloseTo(0.0125 + 0.05 + 1.25, 5)
	})
})
