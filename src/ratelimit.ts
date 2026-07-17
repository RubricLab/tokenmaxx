import type { ProviderId, UsageWindow } from './domain.ts'

// Both upstreams report live rate-limit state on every response, which makes
// the proxy the freshest possible usage source — no polling, no probe quota:
//
//   Anthropic  anthropic-ratelimit-unified-5h-utilization: 0.06   (fraction)
//              anthropic-ratelimit-unified-5h-reset: 1784259000   (unix s)
//              anthropic-ratelimit-unified-status: allowed | allowed_warning | rejected
//   Codex      x-codex-primary-used-percent: 18                   (percent)
//              x-codex-primary-window-minutes: 10080
//              x-codex-primary-reset-at: 1784780264               (unix s)
//              x-codex-<feature>-primary-used-percent: …          (additional limits)
//
// Window ids must match the ones the usage-endpoint probes produce so history
// and rotation see one continuous series per window.

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
		// The usage endpoint names additional limits with a codex_ prefix
		// (metered_feature "codex_bengalfox") that the response headers drop
		// (x-codex-bengalfox-…). Normalize to the endpoint's ids so both sources
		// update the same window.
		const feature = match[1] === undefined ? 'codex' : `codex_${match[1]}`
		const slot = match[2] as 'primary' | 'secondary'
		const prefix = match[1] === undefined ? '' : `${match[1]}-`
		const minutes = Number(headers.get(`x-codex-${prefix}${slot}-window-minutes`))
		// A zero-minute window is the backend's way of saying the slot is unused.
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
