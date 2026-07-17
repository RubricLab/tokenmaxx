export interface ModelPrice {
	inputPerMTok: number
	outputPerMTok: number
	cacheReadPerMTok: number
	cacheWritePerMTok: number
}

// API list prices per million tokens. Cache reads are 0.1× input; Anthropic
// cache writes are 1.25× input (5-minute TTL, what the CLIs use); OpenAI
// prompt-cache writes are free. Match order matters: the dated Opus 4.0/4.1
// entries must precede the generic claude-opus row (Opus 4.5+ dropped to 5/25).
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
