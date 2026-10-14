import { describe, expect, test } from 'bun:test'
import { createTestRenderer, type KeyInput } from '@opentui/core/testing'
import { runTuiDashboard } from './dashboard.ts'
import { FIXTURE_NOW } from './fixtures.ts'

process.env.TOKENMAXX_THEME = 'dark'

interface Screen {
	frame: () => Promise<string>
	press: (...keys: KeyInput[]) => Promise<string>
	resize: (width: number, height: number) => Promise<string>
	close: () => Promise<void>
}

async function open(scenario: string, width: number, height: number): Promise<Screen> {
	const setup = await createTestRenderer({ height, width })
	const done = runTuiDashboard('', {
		fixture: { name: scenario, now: FIXTURE_NOW, routed: true, timewarp: 0 },
		renderer: setup.renderer
	})
	const frame = async () => {
		await setup.renderOnce()
		return setup
			.captureCharFrame()
			.split('\n')
			.map(line => line.replace(/\d{1,2}:\d{2}( [AP]M)?/, 'HH:MM').trimEnd())
			.join('\n')
	}
	while (!(await frame()).includes('tokenmaxx')) {
		await Bun.sleep(1)
	}
	return {
		close: async () => {
			setup.mockInput.pressKey('c', { ctrl: true })
			await done
		},
		frame,
		press: async (...keys) => {
			for (const key of keys) {
				setup.mockInput.pressKey(key)
			}
			return frame()
		},
		resize: async (nextWidth, nextHeight) => {
			setup.resize(nextWidth, nextHeight)
			return frame()
		}
	}
}

async function capture(
	scenario: string,
	width: number,
	height: number,
	...keys: KeyInput[]
): Promise<string> {
	const screen = await open(scenario, width, height)
	const frame = await screen.press(...keys)
	await screen.close()
	return frame
}

const down = (times: number): KeyInput[] => Array.from({ length: times }, () => 'ARROW_DOWN')

describe('dashboard layout', () => {
	const sizes = [
		[44, 20],
		[60, 20],
		[80, 24],
		[106, 28],
		[160, 45]
	] as const
	const tabs: [string, KeyInput[], string][] = [
		['accounts', [], '↑↓ select'],
		['analytics', ['TAB'], '←→ range'],
		['settings', ['TAB', 'TAB'], '↑↓ select']
	]
	for (const [width, height] of sizes) {
		for (const [tab, keys, hint] of tabs) {
			test(`${tab} keeps the footer pinned at ${width}x${height}`, async () => {
				const lines = (await capture('cruising', width, height, ...keys)).split('\n')
				expect(lines[1]).toContain('tokenmaxx')
				expect(lines[height - 2]?.trimStart().startsWith(hint)).toBe(true)
				expect(lines[height - 2]).toContain('tab next')
			})
		}
	}

	test('accounts at 120x32', async () => {
		expect(await capture('cruising', 120, 32)).toMatchSnapshot()
	})

	test('accounts at 80x24', async () => {
		expect(await capture('cruising', 80, 24)).toMatchSnapshot()
	})

	test('accounts at 44x20', async () => {
		expect(await capture('cruising', 44, 20)).toMatchSnapshot()
	})

	test('accounts scroll to the selected row', async () => {
		expect(await capture('blitz', 100, 24, ...down(13))).toMatchSnapshot()
	})

	test('settings at 106x28', async () => {
		expect(await capture('cruising', 106, 28, 'TAB', 'TAB')).toMatchSnapshot()
	})

	test('settings scroll to the last row', async () => {
		expect(await capture('cruising', 106, 28, 'TAB', 'TAB', ...down(30))).toMatchSnapshot()
	})

	test('analytics chart at 80x24', async () => {
		expect(await capture('cruising', 80, 24, 'TAB')).toMatchSnapshot()
	})

	test('analytics metrics at 80x20', async () => {
		expect(await capture('cruising', 80, 20, 'TAB', 'm')).toMatchSnapshot()
	})

	test('add account card at 80x24', async () => {
		expect(await capture('cruising', 80, 24, ...down(2), 'RETURN')).toMatchSnapshot()
	})

	test('onboarding at 80x24', async () => {
		expect(await capture('onboarding', 80, 24)).toMatchSnapshot()
	})

	test('a resize lays the dashboard out again', async () => {
		const screen = await open('cruising', 120, 32)
		const resized = await screen.resize(60, 20)
		await screen.close()
		expect(resized).toBe(await capture('cruising', 60, 20))
	})
})
