import type { UsageWindow } from '../domain.ts'

export function isFiveHourUsageWindow(window: UsageWindow): boolean {
	return /5 ?h/i.test(window.label) || window.id === 'session' || window.id === 'five-hour'
}

function usageWindowPriority(window: UsageWindow): number {
	const identity = `${window.id} ${window.label}`
	switch (true) {
		case isFiveHourUsageWindow(window):
			return 0
		case /^(7 day(?: · all models)?)$/i.test(window.label):
		case /^(weekly_all|seven_day|weekly|codex:primary)$/.test(window.id):
			return 1
		case /scoped|fable|opus|sonnet|spark/i.test(identity):
			return 2
		default:
			return 3
	}
}

export function visibleUsageWindows(
	windows: readonly UsageWindow[],
	hiddenWindowIds: readonly string[]
): UsageWindow[] {
	return windows
		.filter(window => window.kind === 'hard' && !hiddenWindowIds.includes(window.id))
		.sort((left, right) => usageWindowPriority(left) - usageWindowPriority(right))
}
