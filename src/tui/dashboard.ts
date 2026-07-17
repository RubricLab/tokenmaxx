import { Box, createCliRenderer, parseColor, type RGBA, Text } from '@opentui/core'
import type {
	Account,
	AnalyticsSnapshot,
	DashboardSnapshot,
	ProviderId,
	ProviderState,
	TokenTimeframe,
	UsageWindow
} from '../domain.ts'
import { readAnalytics, refreshUsage, requestPolicy, requestSwitch } from '../ipc.ts'
import { availableUpdate } from '../version.ts'
import { buildScenario } from './fixtures.ts'
import {
	brailleArea,
	compactNumber,
	detectThemeName,
	healthBadge,
	meter,
	moneyUsd,
	percentLabel,
	planTag,
	pressureColor,
	relativeAge,
	resetCountdown,
	shortReset,
	shortWindow,
	type Theme,
	type ThemeName,
	TIMEFRAMES,
	type Timeframe,
	themes,
	throughputColumns
} from './format.ts'

type Tab = 'accounts' | 'analytics' | 'settings'
const TABS: readonly Tab[] = ['accounts', 'analytics', 'settings']

const colorCache = new Map<string, RGBA>()
function rgb(hex: string): RGBA {
	const cached = colorCache.get(hex)
	if (cached !== undefined) {
		return cached
	}
	const value = parseColor(hex)
	colorCache.set(hex, value)
	return value
}

const providerTitles: Record<ProviderId, string> = {
	anthropic: 'Anthropic · Claude Code',
	openai: 'OpenAI · Codex'
}
const providerShort: Record<ProviderId, string> = { anthropic: 'Claude Code', openai: 'Codex' }
const providerCli: Record<ProviderId, string> = { anthropic: 'claude', openai: 'codex' }
const providerOrder: readonly ProviderId[] = ['openai', 'anthropic']
const fallbackTimeframe = TIMEFRAMES[2] as Timeframe

interface Row {
	provider: ProviderId
	accountId: string
}

type ViewMode = 'all' | '5h' | '7d'
const VIEW_MODES: readonly ViewMode[] = ['all', '5h', '7d']

// One breakpoint set drives the whole layout: narrower shows less, wider shows
// more, and everything stays centered in a column that grows with the terminal.
type Tier = 'compact' | 'regular' | 'wide'
function tierFor(columns: number): Tier {
	return columns < 96 ? 'compact' : columns < 130 ? 'regular' : 'wide'
}

interface Ctx {
	theme: Theme
	now: number
	columns: number
	rows: number
	tier: Tier
	view: ViewMode
	// Native routing per provider, so panels can show routed / not routed and
	// settings can toggle it.
	routing: Record<ProviderId, boolean>
	// How long a completed switch stays flagged. Long in fixture timelapses
	// (simulated minutes pass per paint), short in live mode.
	switchFlagMs: number
}

function labelWidth(ctx: Ctx): number {
	return ctx.tier === 'compact' ? 15 : ctx.tier === 'regular' ? 22 : 26
}

// The single centering + max-width wrapper. Content sits in a column that is
// centered at any terminal width and grows with it up to `max` — so more space
// genuinely means more room, never a left-hugged block.
function column(
	ctx: Ctx,
	children: (ReturnType<typeof Box> | ReturnType<typeof Text>)[],
	max: number
) {
	const width = Math.max(1, Math.min(max, ctx.columns - 2))
	return Box(
		{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
		Box({ flexDirection: 'column', gap: 1, width }, ...children)
	)
}

// The synthetic "add an account" row id, so navigation and Enter can target it
// like any account row.
const ADD_ROW = '__add__'

function isFiveHour(window: UsageWindow): boolean {
	return /5 ?h/i.test(window.label) || window.id === 'session' || window.id === 'five-hour'
}

function recentSwitch(ctx: Ctx, state: ProviderState | undefined): boolean {
	if (state?.switchedAt == null) {
		return false
	}
	const elapsed = ctx.now - Date.parse(state.switchedAt)
	return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < ctx.switchFlagMs
}

function pad(value: string, width: number): string {
	const fitted = value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`
	return fitted.padEnd(width)
}

function hardWindows(windows: readonly UsageWindow[]): UsageWindow[] {
	return windows.filter(window => window.kind === 'hard')
}

function orderedRows(snapshot: DashboardSnapshot): Row[] {
	const rows: Row[] = []
	for (const provider of providerOrder) {
		const state = snapshot.providers.find(s => s.provider === provider)
		const accounts = snapshot.accounts
			.filter(account => account.provider === provider)
			.sort((left, right) => {
				const active =
					Number(state?.activeAccountId !== left.id) - Number(state?.activeAccountId !== right.id)
				return active !== 0 ? active : left.label.localeCompare(right.label)
			})
		for (const account of accounts) {
			rows.push({ accountId: account.id, provider })
		}
		// A navigable "add an account" affordance closes every provider, so signing
		// in a new account is always ⏎ away — and it is the whole panel when empty.
		rows.push({ accountId: ADD_ROW, provider })
	}
	return rows
}

// Windows the operator hasn't hidden, hard limits only, ordered 5h → 7d → scoped
// so the row always reads the same way.
function visibleWindows(
	windows: readonly UsageWindow[],
	hiddenIds: readonly string[]
): UsageWindow[] {
	const rank = (window: UsageWindow): number =>
		isFiveHour(window) ? 0 : /scoped|fable|opus|sonnet|spark/i.test(window.id) ? 2 : 1
	return hardWindows(windows)
		.filter(window => !hiddenIds.includes(window.id))
		.sort((left, right) => rank(left) - rank(right))
}

function bindingWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
	return windows.reduce<UsageWindow | undefined>(
		(worst, candidate) =>
			worst === undefined || candidate.usedPercent > worst.usedPercent ? candidate : worst,
		undefined
	)
}

// One window's cell on an account row: name, bar, %, and its own reset — the
// reset that used to hide inside the expand pane now lives inline.
function windowCell(ctx: Ctx, window: UsageWindow, barWidth: number, withReset: boolean) {
	const reset = withReset ? shortReset(window.resetAt, ctx.now) : null
	return [
		Text({ content: ` ${shortWindow(window.label)} `, fg: rgb(ctx.theme.dim) }),
		Text({
			content: `${meter(window.usedPercent, barWidth)} ${percentLabel(window.usedPercent)}`,
			fg: rgb(pressureColor(ctx.theme, window.usedPercent))
		}),
		Text({ content: reset === null ? '' : ` ↻${reset}`, fg: rgb(ctx.theme.faint) })
	]
}

// The "＋ add a Codex account" row — selectable like an account, ⏎ signs one in.
function addAccountLine(ctx: Ctx, provider: ProviderId, isSelected: boolean, sole: boolean) {
	const color = isSelected ? ctx.theme.accent : sole ? ctx.theme.dim : ctx.theme.faint
	return Box(
		{
			backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
			flexDirection: 'row',
			width: '100%'
		},
		Text({ content: ` ${isSelected ? '▸' : '＋'} `, fg: rgb(color) }),
		Text({
			attributes: sole ? 1 : 0,
			content: `add a ${providerShort[provider]} account`,
			fg: rgb(color)
		}),
		Text({ content: '   ⏎', fg: rgb(ctx.theme.faint) })
	)
}

function accountLine(
	ctx: Ctx,
	account: Account,
	windows: readonly UsageWindow[],
	hiddenIds: readonly string[],
	isActive: boolean,
	isSelected: boolean,
	justSwitchedTo: boolean
) {
	const badge = healthBadge(ctx.theme, account)
	const labels = labelWidth(ctx)
	const tag = ctx.tier === 'compact' ? null : planTag(account.plan)
	const marker = justSwitchedTo && isActive ? '⟳' : isActive ? '●' : isSelected ? '▸' : '○'
	const markerColor =
		justSwitchedTo && isActive
			? ctx.theme.warn
			: isActive
				? ctx.theme.good
				: isSelected
					? ctx.theme.accent
					: ctx.theme.faint
	const labelText = pad(account.label, labels - 2)
	const children = [
		Text({ content: ` ${marker} `, fg: rgb(markerColor) }),
		Text({
			attributes: isActive ? 1 : 0,
			content: labelText,
			fg: rgb(
				justSwitchedTo && isActive
					? ctx.theme.warn
					: isActive || isSelected
						? ctx.theme.fg
						: ctx.theme.dim
			)
		}),
		Text({ content: tag === null ? '' : ` ${tag}`, fg: rgb(ctx.theme.faint) }),
		Text({ content: badge === null ? ' ' : ' *', fg: rgb(badge?.color ?? ctx.theme.dim) })
	]
	const visible = visibleWindows(windows, hiddenIds)
	const focused =
		ctx.view === '5h'
			? visible.filter(isFiveHour)
			: ctx.view === '7d'
				? visible.filter(window => !isFiveHour(window))
				: visible
	if (focused.length === 0) {
		children.push(Text({ content: ' …', fg: rgb(ctx.theme.dim) }))
	} else if (ctx.view === 'all' && ctx.tier === 'compact') {
		// No room for more than the fullest window; show it with its reset. Bar
		// stays modest — wide unicode markers eat into the true column budget.
		const window = bindingWindow(focused)
		if (window !== undefined) {
			children.push(
				...windowCell(ctx, window, Math.max(8, Math.min(20, ctx.columns - labels - 26)), true)
			)
		}
	} else if (ctx.view === 'all') {
		// Show 2 windows at regular, all at wide, each with its reset. Bars widen
		// with the tier.
		const shown = ctx.tier === 'wide' ? focused : focused.slice(0, 2)
		const tagCols = tag === null ? 0 : tag.length + 1
		const perWindow = Math.floor((ctx.columns - labels - tagCols - 8) / shown.length)
		const barWidth = Math.max(6, Math.min(ctx.tier === 'wide' ? 14 : 9, perWindow - 14))
		for (const window of shown) {
			children.push(...windowCell(ctx, window, barWidth, true))
		}
	} else {
		// Focused 5h / 7d view: one wide bar for the binding window, with a
		// countdown — the switching story in bold.
		const window = bindingWindow(focused)
		if (window === undefined) {
			children.push(Text({ content: ' —', fg: rgb(ctx.theme.dim) }))
		} else {
			const reset = resetCountdown(window.resetAt, ctx.now)
			const cellTag = focused.length > 1 ? `${shortWindow(window.label)} ` : ''
			const barWidth = Math.max(10, ctx.columns - labels - 24 - cellTag.length)
			children.push(
				Text({ content: ' ', fg: rgb(ctx.theme.bg) }),
				Text({
					content: `${meter(window.usedPercent, barWidth)} ${percentLabel(window.usedPercent)}`,
					fg: rgb(pressureColor(ctx.theme, window.usedPercent))
				}),
				Text({
					content: reset === null ? `  ${cellTag}`.trimEnd() : `  ${cellTag}↻ ${reset}`,
					fg: rgb(ctx.theme.faint)
				})
			)
		}
	}
	return Box(
		{
			backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
			flexDirection: 'row',
			width: '100%'
		},
		...children
	)
}

function providerPanel(
	ctx: Ctx,
	snapshot: DashboardSnapshot,
	provider: ProviderId,
	rows: Row[],
	selected: number
) {
	const state: ProviderState | undefined = snapshot.providers.find(s => s.provider === provider)
	const switched = recentSwitch(ctx, state)
	const hiddenIds = state?.policy.hiddenWindowIds ?? []
	const providerRows = rows
		.map((row, index) => ({ index, row }))
		.filter(entry => entry.row.provider === provider)
	const accountCount = providerRows.filter(entry => entry.row.accountId !== ADD_ROW).length
	const lines = providerRows.map(entry => {
		const isSelected = entry.index === selected
		if (entry.row.accountId === ADD_ROW) {
			return addAccountLine(ctx, provider, isSelected, accountCount === 0)
		}
		const account = snapshot.accounts.find(a => a.id === entry.row.accountId)
		if (account === undefined) {
			return Box({ width: '100%' })
		}
		const windows = snapshot.usage.find(u => u.accountId === entry.row.accountId)?.windows
		return accountLine(
			ctx,
			account,
			windows ?? [],
			hiddenIds,
			state?.activeAccountId === entry.row.accountId,
			isSelected,
			switched
		)
	})
	// Title carries routing state (the onboarding gate) plus the auto/switch
	// status, so the panel answers "is this wired up?" at a glance.
	const routed = ctx.routing[provider]
	const routeTag = routed ? '' : ' · not routed'
	const auto = state?.policy.enabled ? `⟳ auto ${state.policy.thresholdPercent}%` : 'auto off'
	const activeLabel = snapshot.accounts.find(a => a.id === state?.activeAccountId)?.label
	const title = switched
		? ` ${providerTitles[provider]}   ⟳ switched → ${activeLabel ?? '?'} `
		: ` ${providerTitles[provider]}   ${auto}${routeTag} `
	return Box(
		{
			border: true,
			borderColor: rgb(switched ? ctx.theme.warn : !routed ? ctx.theme.faint : ctx.theme.border),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexShrink: 0,
			title,
			titleColor: rgb(
				switched
					? ctx.theme.warn
					: !routed
						? ctx.theme.dim
						: state?.policy.enabled
							? ctx.theme.good
							: ctx.theme.dim
			),
			width: '100%'
		},
		...lines
	)
}

function legend(ctx: Ctx, snapshot: DashboardSnapshot): ReturnType<typeof Box> | null {
	const flagged = snapshot.accounts
		.map(account => healthBadge(ctx.theme, account))
		.filter((badge): badge is NonNullable<typeof badge> => badge !== null)
	if (flagged.length === 0) {
		return null
	}
	const distinct = [...new Map(flagged.map(badge => [badge.text, badge])).values()]
	return Box(
		{ flexDirection: 'row' },
		Text({ content: ' * ', fg: rgb(ctx.theme.warn) }),
		...distinct.flatMap(badge => [
			Text({ content: badge.text.replace(/^[⚠·]\s*/, ''), fg: rgb(badge.color) }),
			Text({ content: ' ', fg: rgb(ctx.theme.dim) })
		]),
		Text({ content: '— run tokenmaxx list', fg: rgb(ctx.theme.dim) })
	)
}

function pill(ctx: Ctx, label: string, active: boolean) {
	return Text({
		attributes: active ? 1 : 0,
		bg: rgb(active ? ctx.theme.accent : ctx.theme.bg),
		content: ` ${label} `,
		fg: rgb(active ? ctx.theme.bg : ctx.theme.dim)
	})
}

function tabBar(ctx: Ctx, tab: Tab) {
	return Box(
		{ flexDirection: 'row', gap: 1 },
		pill(ctx, 'Accounts', tab === 'accounts'),
		pill(ctx, 'Analytics', tab === 'analytics'),
		pill(ctx, 'Settings', tab === 'settings')
	)
}

// The analytics header: the time ranges on the left, the chart/metrics toggle
// on the right — one row that says both "over what window" and "which view".
function analyticsBar(ctx: Ctx, timeframe: Timeframe, view: AnalyticsView) {
	const ranges = TIMEFRAMES.flatMap((option, index) => [
		...(index === 0 ? [] : [Text({ content: ' ', fg: rgb(ctx.theme.faint) })]),
		pill(ctx, option.label, option.key === timeframe.key)
	])
	return Box(
		{ flexDirection: 'row', width: '100%' },
		Text({ content: 'range  ', fg: rgb(ctx.theme.dim) }),
		...ranges,
		Box({ flexGrow: 1 }),
		Text({
			attributes: view === 'chart' ? 1 : 0,
			content: 'chart',
			fg: rgb(view === 'chart' ? ctx.theme.accent : ctx.theme.faint)
		}),
		Text({ content: ' · ', fg: rgb(ctx.theme.faint) }),
		Text({
			attributes: view === 'table' ? 1 : 0,
			content: 'metrics',
			fg: rgb(view === 'table' ? ctx.theme.accent : ctx.theme.faint)
		})
	)
}

// One stat: dim label, bright bold value, a wide fixed gutter. The metrics
// read as three calm columns instead of a run-on line.
function stat(ctx: Ctx, label: string, value: string, valueColor?: string) {
	return [
		Text({ content: `${label} `, fg: rgb(ctx.theme.dim) }),
		Text({ attributes: 1, content: value, fg: rgb(valueColor ?? ctx.theme.fg) }),
		Text({ content: '      ', fg: rgb(ctx.theme.bg) })
	]
}

function blankRow(ctx: Ctx) {
	return Box({ flexDirection: 'row' }, Text({ content: ' ', fg: rgb(ctx.theme.bg) }))
}

function centered(...children: ReturnType<typeof Text>[]) {
	return Box({ flexDirection: 'row', justifyContent: 'center', width: '100%' }, ...children)
}

function throughputChart(ctx: Ctx, tokens: TokenTimeframe, timeframe: Timeframe, width: number) {
	const height = Math.max(4, Math.min(10, ctx.rows - 15))
	const body: ReturnType<typeof Box>[] = []
	const axisTop = `${compactNumber(tokens.peakPerHour)}/h`
	const gutter = Math.max(6, axisTop.length)
	const chartWidth = Math.max(16, width - gutter - 2)
	const columns = throughputColumns(tokens.buckets, chartWidth * 2)
	const peak = Math.max(...columns, 1)
	const chart = brailleArea(columns, chartWidth, height, peak)
	chart.forEach((line, index) => {
		const label = index === 0 ? axisTop : index === chart.length - 1 ? '0' : ''
		body.push(
			Box(
				{ flexDirection: 'row' },
				Text({ content: `${label.padStart(gutter)} `, fg: rgb(ctx.theme.faint) }),
				Text({ content: line, fg: rgb(ctx.theme.accent) })
			)
		)
	})
	body.push(
		Box(
			{ flexDirection: 'row' },
			Text({ content: ' '.repeat(gutter + 1), fg: rgb(ctx.theme.bg) }),
			Text({
				content: `${timeframe.label} ago`.padEnd(Math.max(0, chartWidth - 3)),
				fg: rgb(ctx.theme.faint)
			}),
			Text({ content: 'now', fg: rgb(ctx.theme.faint) })
		)
	)
	return body
}

// A metrics row: a name and right-aligned numeric cells, all fixed width so
// every row aligns into a real grid even though each is independently centered.
function metricRow(
	ctx: Ctx,
	name: { text: string; color: string; bold?: boolean },
	cells: { text: string; color: string }[],
	nameWidth: number
) {
	return centered(
		Text({ attributes: name.bold ? 1 : 0, content: pad(name.text, nameWidth), fg: rgb(name.color) }),
		...cells.map(cell => Text({ content: cell.text.padStart(9), fg: rgb(cell.color) }))
	)
}

function metricsView(ctx: Ctx, tokens: TokenTimeframe, scroll: number) {
	const body: ReturnType<typeof Box>[] = []
	const nameWidth = ctx.tier === 'compact' ? 16 : 20
	const num = (value: number) => compactNumber(value)
	for (const provider of tokens.byProvider) {
		body.push(
			metricRow(
				ctx,
				{ color: ctx.theme.fg, text: providerShort[provider.provider] },
				[
					{ color: ctx.theme.dim, text: `↑${num(provider.input)}` },
					{ color: ctx.theme.dim, text: `↓${num(provider.output)}` },
					{ color: ctx.theme.dim, text: `⛁${num(provider.cached + provider.cacheCreation)}` },
					{ color: ctx.theme.good, text: moneyUsd(provider.costUsd) }
				],
				nameWidth
			)
		)
	}
	body.push(
		centered(
			Text({
				content: '─'.repeat(Math.max(10, Math.min(nameWidth + 40, ctx.columns - 10))),
				fg: rgb(ctx.theme.border)
			})
		)
	)
	body.push(
		metricRow(
			ctx,
			{ bold: true, color: ctx.theme.fg, text: 'Σ total' },
			[
				{ color: ctx.theme.fg, text: `↑${num(tokens.totalInput)}` },
				{ color: ctx.theme.fg, text: `↓${num(tokens.totalOutput)}` },
				{ color: ctx.theme.fg, text: `⛁${num(tokens.totalCached + tokens.totalCacheCreation)}` },
				{ color: ctx.theme.good, text: moneyUsd(tokens.costUsd) }
			],
			nameWidth
		)
	)
	if (ctx.tier === 'wide') {
		body.push(
			centered(
				Text({
					content: `input ${moneyUsd(tokens.costInput)}  ·  output ${moneyUsd(tokens.costOutput)}  ·  cache ${moneyUsd(tokens.costCached + tokens.costCacheCreation)}`,
					fg: rgb(ctx.theme.faint)
				})
			)
		)
	}
	// Per-model, scrollable — no header row, the units live in the numbers.
	body.push(blankRow(ctx))
	const maxRows = Math.max(3, ctx.rows - 17)
	const start = Math.max(0, Math.min(scroll, Math.max(0, tokens.models.length - maxRows)))
	const shown = tokens.models.slice(start, start + maxRows)
	for (const model of shown) {
		body.push(
			metricRow(
				ctx,
				{ color: ctx.theme.fg, text: model.model },
				[
					{ color: ctx.theme.dim, text: num(model.tokens) },
					{ color: ctx.theme.good, text: moneyUsd(model.costUsd) }
				],
				nameWidth + 9
			)
		)
	}
	const hiddenBelow = tokens.models.length - (start + shown.length)
	if (start > 0 || hiddenBelow > 0) {
		const parts = [start > 0 ? `↑ ${start} more` : '', hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : '']
		body.push(
			centered(Text({ content: parts.filter(Boolean).join('   '), fg: rgb(ctx.theme.faint) }))
		)
	}
	return body
}

function chartView(ctx: Ctx, tokens: TokenTimeframe, timeframe: Timeframe, width: number) {
	const body: ReturnType<typeof Box>[] = [...throughputChart(ctx, tokens, timeframe, width)]
	body.push(blankRow(ctx))
	const headline = [
		...stat(ctx, 'Σ', `${compactNumber(tokens.totalTokens)} tokens`),
		...stat(ctx, '≈', `${moneyUsd(tokens.costUsd)} value`, ctx.theme.good)
	]
	if (ctx.tier === 'wide') {
		headline.push(
			Text({ content: 'peak ', fg: rgb(ctx.theme.dim) }),
			Text({
				attributes: 1,
				content: `${compactNumber(tokens.peakPerHour)}/h`,
				fg: rgb(ctx.theme.accent)
			})
		)
	}
	body.push(centered(...headline))
	body.push(
		centered(Text({ content: 'press m for the full pricing breakdown', fg: rgb(ctx.theme.faint) }))
	)
	return body
}

function analyticsBody(
	ctx: Ctx,
	analytics: AnalyticsSnapshot,
	timeframe: Timeframe,
	state: ViewState
) {
	const width = Math.max(24, Math.min(150, ctx.columns - 10))
	const tokens = analytics.tokens?.timeframes.find(entry => entry.key === timeframe.key)
	const isTable = state.analyticsView === 'table'
	const body: ReturnType<typeof Box>[] = []
	if (tokens === undefined || tokens.totalTokens === 0) {
		for (let index = 0; index < Math.max(1, Math.floor((ctx.rows - 14) / 2)); index += 1) {
			body.push(blankRow(ctx))
		}
		body.push(
			centered(
				Text({ content: 'no token usage yet — run ', fg: rgb(ctx.theme.dim) }),
				Text({ content: 'codex', fg: rgb(ctx.theme.fg) }),
				Text({ content: ' or ', fg: rgb(ctx.theme.dim) }),
				Text({ content: 'claude', fg: rgb(ctx.theme.fg) }),
				Text({ content: ' and it fills in live', fg: rgb(ctx.theme.dim) })
			)
		)
	} else if (isTable) {
		body.push(...metricsView(ctx, tokens, state.modelScroll))
	} else {
		body.push(...chartView(ctx, tokens, timeframe, width))
	}
	const card = Box(
		{
			border: true,
			borderColor: rgb(ctx.theme.border),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexGrow: 1,
			paddingTop: 1,
			title: isTable
				? ` Value · ${timeframe.label} · priced at API list rates `
				: ' Token throughput · all accounts · both providers ',
			titleColor: rgb(ctx.theme.dim),
			width: '100%'
		},
		...body
	)
	return column(ctx, [analyticsBar(ctx, timeframe, state.analyticsView), card], 150)
}

function dwellLabel(milliseconds: number): string {
	const minutes = Math.round(milliseconds / 60_000)
	return minutes === 0 ? 'off' : `${minutes}m`
}

// Settings rows are a flat list across both providers so ↑↓ walks everything.
// The rate-limit rows are dynamic — one per window a provider actually reports —
// so they must be derived from the snapshot, not a static table.
interface SettingRow {
	provider: ProviderId
	key: 'routing' | 'auto' | 'threshold' | 'dwell' | 'window'
	windowId?: string
	windowLabel?: string
}

function providerWindows(snapshot: DashboardSnapshot, provider: ProviderId): UsageWindow[] {
	const seen = new Map<string, UsageWindow>()
	for (const account of snapshot.accounts.filter(a => a.provider === provider)) {
		const windows = snapshot.usage.find(u => u.accountId === account.id)?.windows ?? []
		for (const window of hardWindows(windows)) {
			if (!seen.has(window.id)) {
				seen.set(window.id, window)
			}
		}
	}
	return [...seen.values()].sort(
		(left, right) => (isFiveHour(left) ? 0 : 1) - (isFiveHour(right) ? 0 : 1)
	)
}

function buildSettingRows(snapshot: DashboardSnapshot): SettingRow[] {
	return providerOrder.flatMap(provider => [
		{ key: 'routing' as const, provider },
		{ key: 'auto' as const, provider },
		{ key: 'threshold' as const, provider },
		{ key: 'dwell' as const, provider },
		...providerWindows(snapshot, provider).map(window => ({
			key: 'window' as const,
			provider,
			windowId: window.id,
			windowLabel: window.label
		}))
	])
}

function settingsPanel(
	ctx: Ctx,
	snapshot: DashboardSnapshot,
	allRows: SettingRow[],
	provider: ProviderId,
	selected: number
) {
	const state = snapshot.providers.find(s => s.provider === provider)
	const policy = state?.policy
	const routed = ctx.routing[provider]
	const rows = allRows.map((row, index) => ({ index, row })).filter(e => e.row.provider === provider)
	const lines = rows.map(entry => {
		const { row } = entry
		const isSelected = entry.index === selected
		const hidden =
			row.windowId !== undefined && (policy?.hiddenWindowIds ?? []).includes(row.windowId)
		const label =
			row.key === 'routing'
				? 'native routing'
				: row.key === 'auto'
					? 'auto-rotate'
					: row.key === 'threshold'
						? 'switch threshold'
						: row.key === 'dwell'
							? 'minimum dwell'
							: `show ${shortWindow(row.windowLabel ?? '')}`
		const value =
			row.key === 'routing'
				? routed
					? 'on'
					: 'off'
				: row.key === 'auto'
					? policy?.enabled
						? 'on'
						: 'off'
					: row.key === 'threshold'
						? `${policy?.thresholdPercent ?? 90}%`
						: row.key === 'dwell'
							? dwellLabel(policy?.minimumDwellMilliseconds ?? 300_000)
							: hidden
								? 'hidden'
								: 'shown'
		const hint =
			row.key === 'routing'
				? `route native ${providerCli[provider]} through tokenmaxx`
				: row.key === 'auto'
					? 'rotate off an account before it runs out'
					: row.key === 'threshold'
						? 'switch when the fullest window reaches this'
						: row.key === 'dwell'
							? 'hold a threshold switch this long (hard limits ignore it)'
							: `${row.windowLabel ?? 'this window'} on the accounts view`
		const on =
			(row.key === 'routing' && routed) ||
			(row.key === 'auto' && (policy?.enabled ?? false)) ||
			(row.key === 'window' && !hidden)
		const valueColor =
			row.key === 'routing' || row.key === 'auto' || row.key === 'window'
				? on
					? ctx.theme.good
					: ctx.theme.dim
				: ctx.theme.fg
		return Box(
			{
				backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
				flexDirection: 'row',
				width: '100%'
			},
			Text({ content: isSelected ? ' ▸ ' : '   ', fg: rgb(ctx.theme.accent) }),
			Text({ content: pad(label, 18), fg: rgb(isSelected ? ctx.theme.fg : ctx.theme.dim) }),
			Text({ attributes: 1, content: pad(value, 7), fg: rgb(valueColor) }),
			Text({ content: hint, fg: rgb(ctx.theme.faint) })
		)
	})
	const status = !routed
		? 'not routed'
		: policy?.enabled
			? `⟳ auto ${policy.thresholdPercent}%`
			: 'routed'
	return Box(
		{
			border: true,
			borderColor: rgb(routed ? ctx.theme.border : ctx.theme.faint),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexShrink: 0,
			title: ` ${providerTitles[provider]}   ${status} `,
			titleColor: rgb(!routed ? ctx.theme.dim : policy?.enabled ? ctx.theme.good : ctx.theme.dim),
			width: '100%'
		},
		...lines
	)
}

function settingsBody(ctx: Ctx, snapshot: DashboardSnapshot, rows: SettingRow[], selected: number) {
	return column(
		ctx,
		[
			settingsPanel(ctx, snapshot, rows, 'openai', selected),
			settingsPanel(ctx, snapshot, rows, 'anthropic', selected),
			Box(
				{ flexDirection: 'row' },
				Text({
					content: 'add accounts, then turn routing on. switches land on the next request — no restart.',
					fg: rgb(ctx.theme.faint)
				})
			)
		],
		96
	)
}

function accountsBody(ctx: Ctx, snapshot: DashboardSnapshot, rows: Row[], selected: number) {
	const note = legend(ctx, snapshot)
	return column(
		ctx,
		[
			providerPanel(ctx, snapshot, 'openai', rows, selected),
			providerPanel(ctx, snapshot, 'anthropic', rows, selected),
			...(note === null ? [] : [note])
		],
		118
	)
}

type AnalyticsView = 'chart' | 'table'

interface ViewState {
	tab: Tab
	selected: number
	settingsSelected: number
	timeframeIndex: number
	analyticsView: AnalyticsView
	modelScroll: number
	note: string
	updateAvailable: string | null
	updateDismissed: boolean
	view: ViewMode
}

export type DashboardAction =
	| { kind: 'relogin'; provider: ProviderId }
	| { kind: 'login'; provider: ProviderId }
	| { kind: 'routing'; provider: ProviderId; enable: boolean }
	| { kind: 'update'; version: string }

function view(ctx: Ctx, analytics: AnalyticsSnapshot, rows: Row[], state: ViewState) {
	const clock = new Date(ctx.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
	const freshestMillis = analytics.snapshot.usage
		.map(u => Date.parse(u.observedAt))
		.filter(millis => Number.isFinite(millis))
		.reduce((max, millis) => Math.max(max, millis), 0)
	const refreshed = freshestMillis === 0 ? '—' : `${relativeAge(freshestMillis, ctx.now)} ago`
	const timeframe = TIMEFRAMES[state.timeframeIndex] ?? fallbackTimeframe
	const footer =
		state.tab === 'accounts'
			? '↑↓ select · ⏎ switch/add · v view · a auto · tab next'
			: state.tab === 'analytics'
				? '←→ range · m chart/metrics · ↑↓ scroll · tab next'
				: '↑↓ select · ←→ adjust · ⏎ toggle · tab next'
	const header = Box(
		{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
		Box(
			{ flexDirection: 'row', width: Math.min(118, ctx.columns - 2) },
			Text({ attributes: 1, content: 'tokenmaxx', fg: rgb(ctx.theme.accent) }),
			Text({ content: `  ${clock}`, fg: rgb(ctx.theme.dim) }),
			Text({ content: `   ↻ ${refreshed}`, fg: rgb(ctx.theme.faint) }),
			...(state.note === '' ? [] : [Text({ content: `   ${state.note}`, fg: rgb(ctx.theme.warn) })])
		)
	)
	const children: Array<ReturnType<typeof Box> | ReturnType<typeof Text>> = [header]
	children.push(
		Box(
			{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
			Box({ flexDirection: 'row', width: Math.min(118, ctx.columns - 2) }, tabBar(ctx, state.tab))
		)
	)
	if (state.updateAvailable !== null && !state.updateDismissed) {
		children.push(
			Box(
				{ flexDirection: 'row', gap: 1, justifyContent: 'center', width: '100%' },
				Text({
					attributes: 1,
					bg: rgb(ctx.theme.accent),
					content: ` ⬆ v${state.updateAvailable} is ready `,
					fg: rgb(ctx.theme.bg)
				}),
				Text({ attributes: 1, bg: rgb(ctx.theme.selected), content: ' u ', fg: rgb(ctx.theme.fg) }),
				Text({ content: 'update now', fg: rgb(ctx.theme.dim) }),
				Text({ attributes: 1, bg: rgb(ctx.theme.selected), content: ' x ', fg: rgb(ctx.theme.fg) }),
				Text({ content: 'later', fg: rgb(ctx.theme.dim) })
			)
		)
	}
	children.push(
		state.tab === 'accounts'
			? accountsBody(ctx, analytics.snapshot, rows, state.selected)
			: state.tab === 'analytics'
				? analyticsBody(ctx, analytics, timeframe, state)
				: settingsBody(
						ctx,
						analytics.snapshot,
						buildSettingRows(analytics.snapshot),
						state.settingsSelected
					)
	)
	children.push(Box({ flexGrow: 1 }))
	children.push(
		Box(
			{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
			Box(
				{ flexDirection: 'row', width: Math.min(118, ctx.columns - 2) },
				Text({ content: footer, fg: rgb(ctx.theme.dim) })
			)
		)
	)
	return Box(
		{
			backgroundColor: rgb(ctx.theme.bg),
			flexDirection: 'column',
			gap: 1,
			height: '100%',
			padding: 1,
			width: '100%'
		},
		...children
	)
}

export interface FixtureOptions {
	name: string
	now: number
	// Simulated milliseconds that pass per real millisecond. Zero freezes the
	// clock (stills); anything above plays the scenario as a timelapse.
	timewarp: number
}

export async function runTuiDashboard(
	socketPath: string,
	options: { routing: Record<ProviderId, boolean>; fixture?: FixtureOptions }
): Promise<DashboardAction | undefined> {
	const fixture = options.fixture
	const live = fixture === undefined
	const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
	await renderer.waitForThemeMode(400).catch(() => null)
	const envFallback: ThemeName = detectThemeName(process.env)
	const currentTheme = (): Theme => themes[live ? (renderer.themeMode ?? envFallback) : envFallback]
	let simulatedNow = fixture?.now ?? Date.now()
	let analytics =
		fixture === undefined
			? await readAnalytics(socketPath)
			: buildScenario(fixture.name, simulatedNow)
	let rows = orderedRows(analytics.snapshot)
	const state: ViewState = {
		analyticsView: 'chart',
		modelScroll: 0,
		note: '',
		selected: 0,
		settingsSelected: 0,
		tab: 'accounts',
		timeframeIndex: 2,
		updateAvailable: live ? null : (process.env.TOKENMAXX_FAKE_UPDATE ?? null),
		updateDismissed: false,
		view: 'all'
	}
	if (live) {
		void availableUpdate().then(version => {
			if (version !== null) {
				state.updateAvailable = version
				paint()
			}
		})
	}
	let busy = false

	const clampSelection = () => {
		state.selected = rows.length === 0 ? 0 : Math.max(0, Math.min(state.selected, rows.length - 1))
	}

	const paint = () => {
		clampSelection()
		const columns = process.stdout.columns ?? 80
		let next: ReturnType<typeof Box>
		try {
			next = view(
				{
					columns,
					now: live ? Date.now() : simulatedNow,
					routing: options.routing,
					rows: process.stdout.rows ?? 24,
					switchFlagMs: fixture !== undefined && fixture.timewarp > 0 ? 55 * 60_000 : 120_000,
					theme: currentTheme(),
					tier: tierFor(columns),
					view: state.view
				},
				analytics,
				rows,
				state
			)
		} catch {
			return
		}
		for (const child of [...renderer.root.getChildren()]) {
			renderer.root.remove(child)
			child.destroyRecursively()
		}
		renderer.root.add(next)
	}

	const withBusy = async (message: string, work: () => Promise<void>) => {
		if (busy) {
			return
		}
		busy = true
		state.note = message
		paint()
		try {
			await work()
			state.note = ''
		} catch (error) {
			state.note = error instanceof Error ? error.message : 'failed'
		} finally {
			busy = false
			paint()
		}
	}

	const reload = (refresh: boolean) =>
		withBusy(refresh ? 'refreshing…' : '', async () => {
			if (refresh) {
				await refreshUsage(socketPath)
			}
			analytics = await readAnalytics(socketPath)
			rows = orderedRows(analytics.snapshot)
			clampSelection()
		})

	const needsLogin = (accountId: string): boolean => {
		const account = analytics.snapshot.accounts.find(a => a.id === accountId)
		return (
			account?.health === 'reauthenticationRequired' ||
			account?.health === 'loginExpiring' ||
			account?.health === 'scopeMissing'
		)
	}

	const switchToSelected = () => {
		const row = rows[state.selected]
		if (row === undefined) {
			return
		}
		// The "＋ add an account" row signs a fresh account into this provider.
		if (row.accountId === ADD_ROW) {
			finish({ kind: 'login', provider: row.provider })
			return
		}
		if (needsLogin(row.accountId)) {
			finish({ kind: 'relogin', provider: row.provider })
			return
		}
		void withBusy('switching…', async () => {
			await requestSwitch(socketPath, row.provider, row.accountId)
			analytics = await readAnalytics(socketPath)
			rows = orderedRows(analytics.snapshot)
			const moved = rows.findIndex(r => r.accountId === row.accountId)
			if (moved >= 0) {
				state.selected = moved
			}
		})
	}

	const currentPolicy = (provider: ProviderId) =>
		analytics.snapshot.providers.find(s => s.provider === provider)?.policy

	const applyPolicy = (
		provider: ProviderId,
		change: {
			enabled?: boolean
			thresholdPercent?: number
			minimumDwellMilliseconds?: number
			hiddenWindowIds?: string[]
		},
		message: string
	) => {
		void withBusy(message, async () => {
			await requestPolicy(socketPath, {
				authorizationConfirmed: change.enabled ? true : undefined,
				enabled: change.enabled,
				hiddenWindowIds: change.hiddenWindowIds,
				minimumDwellMilliseconds: change.minimumDwellMilliseconds,
				provider,
				thresholdPercent: change.thresholdPercent
			})
			analytics = await readAnalytics(socketPath)
		})
	}

	const toggleAuto = (provider: ProviderId) => {
		const enable = !(currentPolicy(provider)?.enabled ?? false)
		applyPolicy(
			provider,
			{ enabled: enable },
			`auto-rotate ${providerCli[provider]} ${enable ? 'on' : 'off'}…`
		)
	}

	const toggleWindow = (provider: ProviderId, windowId: string) => {
		const hidden = currentPolicy(provider)?.hiddenWindowIds ?? []
		const next = hidden.includes(windowId)
			? hidden.filter(id => id !== windowId)
			: [...hidden, windowId]
		applyPolicy(provider, { hiddenWindowIds: next }, 'rate-limit view…')
	}

	const adjustSetting = (delta: number) => {
		const row = buildSettingRows(analytics.snapshot)[state.settingsSelected]
		if (row === undefined) {
			return
		}
		const policy = currentPolicy(row.provider)
		if (row.key === 'routing') {
			// Routing is a config-file change done by the CLI process; hand it out.
			finish({ enable: !options.routing[row.provider], kind: 'routing', provider: row.provider })
			return
		}
		if (row.key === 'auto') {
			toggleAuto(row.provider)
			return
		}
		if (row.key === 'window' && row.windowId !== undefined) {
			toggleWindow(row.provider, row.windowId)
			return
		}
		if (row.key === 'threshold') {
			const next = Math.max(10, Math.min(100, (policy?.thresholdPercent ?? 90) + delta * 5))
			applyPolicy(row.provider, { thresholdPercent: next }, `threshold ${next}%…`)
			return
		}
		if (row.key === 'dwell') {
			const currentDwell = policy?.minimumDwellMilliseconds ?? 300_000
			const next = Math.max(0, Math.min(3_600_000, currentDwell + delta * 60_000))
			applyPolicy(row.provider, { minimumDwellMilliseconds: next }, `dwell ${dwellLabel(next)}…`)
		}
	}

	let action: DashboardAction | undefined
	let finish: (result?: DashboardAction) => void = () => {}
	await new Promise<void>(resolve => {
		const tick = 250
		const interval = live
			? setInterval(() => void reload(false).catch(() => undefined), 2_000)
			: fixture.timewarp > 0
				? setInterval(() => {
						simulatedNow += tick * fixture.timewarp
						analytics = buildScenario(fixture.name, simulatedNow)
						rows = orderedRows(analytics.snapshot)
						paint()
					}, tick)
				: null
		let finished = false
		finish = (result?: DashboardAction) => {
			if (finished) {
				return
			}
			finished = true
			action = result
			if (interval !== null) {
				clearInterval(interval)
			}
			try {
				renderer.destroy()
			} catch {}
			resolve()
		}
		const changeTimeframe = (delta: number) => {
			state.timeframeIndex = Math.max(0, Math.min(TIMEFRAMES.length - 1, state.timeframeIndex + delta))
			paint()
		}
		renderer.keyInput.on('keypress', (key: { name: string; ctrl: boolean }) => {
			try {
				if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
					finish()
				} else if (
					key.name === 'u' &&
					state.updateAvailable !== null &&
					!state.updateDismissed &&
					live
				) {
					finish({ kind: 'update', version: state.updateAvailable })
				} else if (key.name === 'x' && state.updateAvailable !== null && !state.updateDismissed) {
					state.updateDismissed = true
					paint()
				} else if (key.name === 'v' && state.tab === 'accounts') {
					state.view = VIEW_MODES[(VIEW_MODES.indexOf(state.view) + 1) % VIEW_MODES.length] as ViewMode
					paint()
				} else if (key.name === 'm' && state.tab === 'analytics') {
					state.analyticsView = state.analyticsView === 'chart' ? 'table' : 'chart'
					state.modelScroll = 0
					paint()
				} else if (key.name === 'tab') {
					state.tab = TABS[(TABS.indexOf(state.tab) + 1) % TABS.length] as Tab
					paint()
				} else if (key.name === 'r' && live) {
					void reload(true)
				} else if (state.tab === 'analytics') {
					// In the metrics table ↑↓ scroll the model list; ←→ always move
					// the time range. In the chart view every arrow moves the range.
					if (key.name === 'left' || key.name === 'h') {
						changeTimeframe(-1)
					} else if (key.name === 'right' || key.name === 'l') {
						changeTimeframe(1)
					} else if (key.name === 'up' || key.name === 'k') {
						if (state.analyticsView === 'table') {
							state.modelScroll = Math.max(0, state.modelScroll - 1)
							paint()
						} else {
							changeTimeframe(-1)
						}
					} else if (key.name === 'down' || key.name === 'j') {
						if (state.analyticsView === 'table') {
							state.modelScroll += 1
							paint()
						} else {
							changeTimeframe(1)
						}
					}
				} else if (state.tab === 'settings') {
					const settingCount = buildSettingRows(analytics.snapshot).length
					if (key.name === 'up' || key.name === 'k') {
						state.settingsSelected = Math.max(0, state.settingsSelected - 1)
						paint()
					} else if (key.name === 'down' || key.name === 'j') {
						state.settingsSelected = Math.min(settingCount - 1, state.settingsSelected + 1)
						paint()
					} else if (key.name === 'left' && live) {
						adjustSetting(-1)
					} else if (key.name === 'right' && live) {
						adjustSetting(1)
					} else if ((key.name === 'return' || key.name === 'space') && live) {
						adjustSetting(1)
					}
				} else if (key.name === 'up' || key.name === 'k') {
					state.selected = Math.max(0, state.selected - 1)
					paint()
				} else if (key.name === 'down' || key.name === 'j') {
					state.selected = Math.max(0, Math.min(rows.length - 1, state.selected + 1))
					paint()
				} else if (key.name === 'return' && live) {
					switchToSelected()
				} else if (key.name === 'a' && live) {
					const row = rows[state.selected]
					if (row !== undefined && row.accountId !== ADD_ROW) {
						toggleAuto(row.provider)
					}
				}
			} catch {}
		})
		paint()
		renderer.start()
	})
	return action
}
