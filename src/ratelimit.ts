import type { ProviderId, UsageWindow } from './domain.ts'

export interface RateLimitObservation {
	limited: boolean
	windows: UsageWindow[]
}

function isoFromUnixSeconds(value: string | null): string | null {
	if (value === null) {
		return null
	}
	const seconds = Number(value)
	return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value))
}

function anthropicObservation(headers: Headers, status: number): RateLimitObservation | null {
	const windows: UsageWindow[] = []
	const spans = [
		{ header: '5h', id: 'session', label: '5h session' },
		{ header: '7d', id: 'weekly_all', label: '7 day · all models' }
	] as const
	let rejected = headers.get('anthropic-ratelimit-unified-status') === 'rejected'
	for (const span of spans) {
		const utilization = headers.get(`anthropic-ratelimit-unified-${span.header}-utilization`)
		if (headers.get(`anthropic-ratelimit-unified-${span.header}-status`) === 'rejected') {
			rejected = true
		}
		if (utilization === null) {
			continue
		}
		const fraction = Number(utilization)
		if (!Number.isFinite(fraction)) {
			continue
		}
		windows.push({
			id: span.id,
			kind: 'hard',
			label: span.label,
			resetAt: isoFromUnixSeconds(headers.get(`anthropic-ratelimit-unified-${span.header}-reset`)),
			usedPercent: clampPercent(fraction * 100)
		})
	}
	if (windows.length === 0 && !rejected && status !== 429) {
		return null
	}
	return { limited: rejected || status === 429, windows }
}

function codexDurationLabel(minutes: number | null): string | null {
	if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
		return null
	}
	const hours = minutes / 60
	if (Number.isInteger(hours) && hours < 24) {
		return `${hours} hour`
	}
	const days = hours / 24
	return Number.isInteger(days) ? `${days} day` : null
}

function codexObservation(headers: Headers, status: number): RateLimitObservation | null {
	const windows: UsageWindow[] = []
	const seen = new Set<string>()
	headers.forEach((value, name) => {
		const match = name.match(/^x-codex-(?:(.+)-)?(primary|secondary)-used-percent$/)
		if (match === null) {
			return
		}
		const percent = Number(value)
		if (!Number.isFinite(percent)) {
			return
		}
		const feature = match[1] === undefined ? 'codex' : `codex_${match[1]}`
		const slot = match[2] as 'primary' | 'secondary'
		const prefix = match[1] === undefined ? '' : `${match[1]}-`
		const minutes = Number(headers.get(`x-codex-${prefix}${slot}-window-minutes`))
		if (!Number.isFinite(minutes) || minutes <= 0) {
			return
		}
		const id = `${feature}:${slot}`
		if (seen.has(id)) {
			return
		}
		seen.add(id)
		const limitName = headers.get(`x-codex-${prefix}limit-name`)
		const duration = codexDurationLabel(minutes) ?? slot
		windows.push({
			id,
			kind: 'hard',
			label:
				feature === 'codex' ? duration : `${limitName ?? feature} · ${duration}`.replace(/^ · /, ''),
			resetAt: isoFromUnixSeconds(headers.get(`x-codex-${prefix}${slot}-reset-at`)),
			usedPercent: clampPercent(percent)
		})
	})
	if (windows.length === 0 && status !== 429) {
		return null
	}
	return { limited: status === 429, windows }
}

export function observeRateLimitHeaders(
	provider: ProviderId,
	headers: Headers,
	status: number
): RateLimitObservation | null {
	return provider === 'anthropic'
		? anthropicObservation(headers, status)
		: codexObservation(headers, status)
}
