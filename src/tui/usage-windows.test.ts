import { describe, expect, test } from 'bun:test'
import type { UsageWindow } from '../domain.ts'
import { visibleUsageWindows } from './usage-windows.ts'

function usageWindow(id: string, label: string): UsageWindow {
	return { id, kind: 'hard', label, resetAt: null, usedPercent: 0 }
}

describe('visibleUsageWindows', () => {
	test('keeps recognized model limits ahead of unknown limits', () => {
		const windows = [
			usageWindow('session', '5h session'),
			usageWindow('weekly_all', '7 day · all models'),
			usageWindow('weekly_scoped:fable', '7 day · Fable'),
			usageWindow('nimbus_quill', 'Nimbus Quill')
		]

		expect(visibleUsageWindows(windows, []).map(window => window.id)).toEqual([
			'session',
			'weekly_all',
			'weekly_scoped:fable',
			'nimbus_quill'
		])
	})

	test('shows Fable in the compact pair when the all-model limit is hidden', () => {
		const windows = [
			usageWindow('session', '5h session'),
			usageWindow('weekly_all', '7 day · all models'),
			usageWindow('weekly_scoped:fable', '7 day · Fable'),
			usageWindow('nimbus_quill', 'Nimbus Quill')
		]

		expect(
			visibleUsageWindows(windows, ['weekly_all'])
				.slice(0, 2)
				.map(window => window.label)
		).toEqual(['5h session', '7 day · Fable'])
	})
})
