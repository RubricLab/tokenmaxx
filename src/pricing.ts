export interface ModelPrice {
	inputPerMTok: number
	outputPerMTok: number
	cacheReadPerMTok: number
}

const PRICES: ReadonlyArray<{ match: string; price: ModelPrice }> = [
	{ match: 'claude-opus', price: { cacheReadPerMTok: 1.5, inputPerMTok: 15, outputPerMTok: 75 } },
	{ match: 'claude-sonnet', price: { cacheReadPerMTok: 0.3, inputPerMTok: 3, outputPerMTok: 15 } },
	{ match: 'claude-haiku', price: { cacheReadPerMTok: 0.08, inputPerMTok: 0.8, outputPerMTok: 4 } },
	{ match: 'claude-fable', price: { cacheReadPerMTok: 0.1, inputPerMTok: 1, outputPerMTok: 5 } },
	{ match: 'gpt-5', price: { cacheReadPerMTok: 0.125, inputPerMTok: 1.25, outputPerMTok: 10 } },
	{ match: 'o4', price: { cacheReadPerMTok: 0.28, inputPerMTok: 1.1, outputPerMTok: 4.4 } }
]

const DEFAULT_PRICE: ModelPrice = { cacheReadPerMTok: 0.3, inputPerMTok: 3, outputPerMTok: 15 }

export function priceFor(model: string | null | undefined): ModelPrice {
	const key = (model ?? '').toLowerCase()
	return PRICES.find(entry => key.includes(entry.match))?.price ?? DEFAULT_PRICE
}

export function costUsd(
	model: string | null | undefined,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0
): number {
	const price = priceFor(model)
	return (
		(inputTokens / 1_000_000) * price.inputPerMTok +
		(outputTokens / 1_000_000) * price.outputPerMTok +
		(cacheReadTokens / 1_000_000) * price.cacheReadPerMTok
	)
}
