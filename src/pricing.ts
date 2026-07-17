interface ModelPrice {
	inputPerMTok: number
	outputPerMTok: number
	cacheReadPerMTok: number
	cacheWritePerMTok: number
}

const PRICES: ReadonlyArray<{ match: string; price: ModelPrice }> = [
	{
		match: 'claude-fable',
		price: { cacheReadPerMTok: 1, cacheWritePerMTok: 12.5, inputPerMTok: 10, outputPerMTok: 50 }
	},
	{
		match: 'claude-mythos',
		price: { cacheReadPerMTok: 1, cacheWritePerMTok: 12.5, inputPerMTok: 10, outputPerMTok: 50 }
	},
	{
		match: 'claude-opus-4-1',
		price: { cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75, inputPerMTok: 15, outputPerMTok: 75 }
	},
	{
		match: 'claude-opus-4-20',
		price: { cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75, inputPerMTok: 15, outputPerMTok: 75 }
	},
	{
		match: 'claude-opus',
		price: { cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25, inputPerMTok: 5, outputPerMTok: 25 }
	},
	{
		match: 'claude-sonnet',
		price: { cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, inputPerMTok: 3, outputPerMTok: 15 }
	},
	{
		match: 'claude-haiku',
		price: { cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25, inputPerMTok: 1, outputPerMTok: 5 }
	},
	{
		match: 'gpt-5',
		price: { cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, inputPerMTok: 1.25, outputPerMTok: 10 }
	},
	{
		match: 'o4',
		price: { cacheReadPerMTok: 0.275, cacheWritePerMTok: 0, inputPerMTok: 1.1, outputPerMTok: 4.4 }
	}
]

const DEFAULT_PRICE: ModelPrice = {
	cacheReadPerMTok: 0.3,
	cacheWritePerMTok: 3.75,
	inputPerMTok: 3,
	outputPerMTok: 15
}

export function priceFor(model: string | null | undefined): ModelPrice {
	const key = (model ?? '').toLowerCase()
	return PRICES.find(entry => key.includes(entry.match))?.price ?? DEFAULT_PRICE
}

export function costUsd(
	model: string | null | undefined,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheCreationTokens = 0
): number {
	const price = priceFor(model)
	return (
		(inputTokens / 1_000_000) * price.inputPerMTok +
		(outputTokens / 1_000_000) * price.outputPerMTok +
		(cacheReadTokens / 1_000_000) * price.cacheReadPerMTok +
		(cacheCreationTokens / 1_000_000) * price.cacheWritePerMTok
	)
}
