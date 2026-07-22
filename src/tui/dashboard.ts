import { Box, createCliRenderer, parseColor, type RGBA, Text } from '@opentui/core'
import type {
	Account,
	AnalyticsSnapshot,
	DashboardSnapshot,
	ProviderId,
	ProviderState,
	ResetCreditsView,
	ResetOutcome,
	TokenTimeframe,
	UsageSnapshot,
	UsageWindow
} from '../domain.ts'
import {
	readAnalytics,
	refreshUsage,
	requestAccountSave,
	requestConsumeReset,
	requestPolicy,
	requestResetCredits,
	requestSwitch
} from '../ipc.ts'
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
	routing: Record<ProviderId, boolean>
	cliPresent: Record<ProviderId, boolean>
	switchFlagMs: number
}

function labelWidth(ctx: Ctx): number {
	return ctx.tier === 'compact' ? 15 : ctx.tier === 'regular' ? 22 : 26
}

function column(
	ctx: Ctx,
	children: (ReturnType<typeof Box> | ReturnType<typeof Text>)[],
	max: number
) {
	const width = Math.max(1, Math.min(max, ctx.columns - 2))
	return Box(
		{ flexDirection: 'row', width: '100%' },
		Box({ flexGrow: 1, flexShrink: 1 }),
		Box({ flexDirection: 'column', flexShrink: 0, gap: 1, width }, ...children),
		Box({ flexGrow: 1, flexShrink: 1 })
	)
}

const ADD_ROW = '__add__'

const CONTENT_MAX = 126

const BAR: Record<Tier, number> = { compact: 9, regular: 11, wide: 14 }
function windowsShown(ctx: Ctx): number {
	return ctx.tier === 'wide' ? 3 : 2
}
function windowCellWidth(tier: Tier, window: UsageWindow): number {
	return 2 + shortWindow(window.label).length + BAR[tier] + 5 + 6
}
function accountResetCredits(usage: UsageSnapshot | undefined) {
	return usage?.provider === 'openai' ? (usage.resetCredits ?? null) : null
}

function resetGlyph(usage: UsageSnapshot | undefined): string {
	const credits = accountResetCredits(usage)
	return credits === null || credits.available === 0 ? '' : ` ↺${credits.available}`
}

function panelResetColumn(snapshot: DashboardSnapshot, provider: ProviderId): number {
	return snapshot.accounts
		.filter(account => account.provider === provider)
		.reduce(
			(widest, account) =>
				Math.max(widest, resetGlyph(snapshot.usage.find(u => u.accountId === account.id)).length),
			0
		)
}

function spendCell(
	tier: Tier,
	account: Account,
	usage: UsageSnapshot | undefined
): { label: string; bar: string; value: string; pad: string } | null {
	if (account.auth !== 'apiKey') {
		return null
	}
	const money = moneyUsd(usage?.measuredSpendUsd ?? 0)
	return {
		bar: '┄'.repeat(BAR[tier]),
		label: '31d ',
		pad: ''.padEnd(6),
		value: ` ${money.padStart(4)}`
	}
}

function extraCell(
	account: Account,
	usage: UsageSnapshot | undefined
): { label: string; value: string; usedPercent: number | null } | null {
	const extra = usage?.extraUsage
	if (account.auth === 'apiKey' || extra?.enabled !== true) {
		return null
	}
	const value =
		extra.usedPercent !== null
			? percentLabel(extra.usedPercent)
			: extra.balanceUsd !== null
				? moneyUsd(extra.balanceUsd)
				: extra.spentUsd !== null
					? moneyUsd(extra.spentUsd)
					: 'on'
	return { label: ' extra ', usedPercent: extra.usedPercent, value }
}

function panelBadgeColumn(ctx: Ctx, snapshot: DashboardSnapshot, provider: ProviderId): number {
	return snapshot.accounts.some(
		account => account.provider === provider && healthBadge(ctx.theme, account) !== null
	)
		? 2
		: 1
}

function accountsWidth(ctx: Ctx, snapshot: DashboardSnapshot): number {
	const labels = labelWidth(ctx)
	let widest = 46 // never narrower than a provider title with its routing tag
	for (const account of snapshot.accounts) {
		const state = snapshot.providers.find(s => s.provider === account.provider)
		const hidden = state?.policy.hiddenWindowIds ?? []
		const usage = snapshot.usage.find(u => u.accountId === account.id)
		const visible = visibleWindows(usage?.windows ?? [], hidden)
		const tag = ctx.tier === 'compact' ? null : planTag(account.plan)
		const base =
			3 +
			(labels - 2) +
			(tag === null ? 0 : tag.length + 1) +
			panelResetColumn(snapshot, account.provider) +
			panelBadgeColumn(ctx, snapshot, account.provider) +
			1
		const spend = spendCell(ctx.tier, account, usage)
		const extra = extraCell(account, usage)
		const body =
			(spend === null
				? visible
						.slice(0, windowsShown(ctx))
						.reduce((sum, window) => sum + windowCellWidth(ctx.tier, window), 0)
				: spend.label.length + spend.bar.length + spend.value.length + spend.pad.length) +
			(extra === null ? 0 : extra.label.length + extra.value.length)
		widest = Math.max(widest, base + body)
	}
	return Math.min(CONTENT_MAX, ctx.columns - 2, widest + 2)
}

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
		const hidden = state?.policy.hiddenWindowIds ?? []
		const pressure = (accountId: string): number => {
			const windows = snapshot.usage.find(u => u.accountId === accountId)?.windows ?? []
			return visibleWindows(windows, hidden).reduce((max, w) => Math.max(max, w.usedPercent), -1)
		}
		const accounts = snapshot.accounts
			.filter(account => account.provider === provider)
			.sort((left, right) => {
				const byPressure = pressure(right.id) - pressure(left.id)
				return byPressure !== 0 ? byPressure : left.label.localeCompare(right.label)
			})
		for (const account of accounts) {
			rows.push({ accountId: account.id, provider })
		}
		rows.push({ accountId: ADD_ROW, provider })
	}
	return rows
}

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

function windowCell(ctx: Ctx, window: UsageWindow, barWidth: number, withReset: boolean) {
	const reset = withReset ? shortReset(window.resetAt, ctx.now) : null
	return [
		Text({ content: ` ${shortWindow(window.label)} `, fg: rgb(ctx.theme.dim) }),
		Text({
			content: `${meter(window.usedPercent, barWidth)} ${percentLabel(window.usedPercent)}`,
			fg: rgb(pressureColor(ctx.theme, window.usedPercent))
		}),
		Text({ content: (reset === null ? '' : ` ↻${reset}`).padEnd(6), fg: rgb(ctx.theme.faint) })
	]
}

function addAccountLine(ctx: Ctx, provider: ProviderId, isSelected: boolean, sole: boolean) {
	const color = isSelected ? ctx.theme.accent : sole ? ctx.theme.dim : ctx.theme.faint
	const installed = ctx.cliPresent[provider]
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
		Text({
			content: installed ? '   ⏎' : ` · install ${providerCli[provider]} first`,
			fg: rgb(installed ? ctx.theme.faint : ctx.theme.warn)
		})
	)
}

function accountLine(
	ctx: Ctx,
	account: Account,
	usage: UsageSnapshot | undefined,
	hiddenIds: readonly string[],
	resetColumn: number,
	badgeColumn: number,
	isActive: boolean,
	isSelected: boolean,
	justSwitchedTo: boolean
) {
	const badge = healthBadge(ctx.theme, account)
	const labels = labelWidth(ctx)
	const tag = ctx.tier === 'compact' ? null : planTag(account.plan)
	const marker = justSwitchedTo && isActive ? '⟳' : isActive ? '●' : isSelected ? '▸' : '○'
	const markerColor = isActive ? ctx.theme.good : isSelected ? ctx.theme.accent : ctx.theme.faint
	const labelText = pad(account.label, labels - 2)
	const credits = accountResetCredits(usage)
	const children = [
		Text({ content: ` ${marker} `, fg: rgb(markerColor) }),
		Text({
			attributes: isActive ? 1 : 0,
			content: labelText,
			fg: rgb(isActive || isSelected ? ctx.theme.fg : ctx.theme.dim)
		}),
		Text({ content: tag === null ? '' : ` ${tag}`, fg: rgb(ctx.theme.faint) }),
		...(resetColumn === 0
			? []
			: [
					Text({
						content: resetGlyph(usage).padEnd(resetColumn),
						fg: rgb((credits?.applicable ?? 0) > 0 ? ctx.theme.good : ctx.theme.faint)
					})
				]),
		Text({
			content: (badge === null ? '' : ' *').padEnd(badgeColumn),
			fg: rgb(badge?.color ?? ctx.theme.dim)
		})
	]
	const visible = visibleWindows(usage?.windows ?? [], hiddenIds)
	const spend = spendCell(ctx.tier, account, usage)
	if (spend !== null) {
		children.push(
			Text({ content: spend.label, fg: rgb(ctx.theme.dim) }),
			Text({ content: spend.bar, fg: rgb(ctx.theme.faint) }),
			Text({ content: spend.value, fg: rgb(ctx.theme.fg) }),
			Text({ content: spend.pad, fg: rgb(ctx.theme.faint) })
		)
	} else if (visible.length === 0) {
		children.push(Text({ content: ' …', fg: rgb(ctx.theme.dim) }))
	} else {
		for (const window of visible.slice(0, windowsShown(ctx))) {
			children.push(...windowCell(ctx, window, BAR[ctx.tier], true))
		}
	}
	const extra = extraCell(account, usage)
	if (extra !== null) {
		children.push(
			Text({
				content: extra.label,
				fg: rgb(account.onThreshold === 'spill' ? ctx.theme.accent : ctx.theme.dim)
			}),
			Text({
				content: extra.value,
				fg: rgb(extra.usedPercent === null ? ctx.theme.fg : pressureColor(ctx.theme, extra.usedPercent))
			})
		)
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
	const resetColumn = panelResetColumn(snapshot, provider)
	const badgeColumn = panelBadgeColumn(ctx, snapshot, provider)
	const lines = providerRows.map(entry => {
		const isSelected = entry.index === selected
		if (entry.row.accountId === ADD_ROW) {
			return addAccountLine(ctx, provider, isSelected, accountCount === 0)
		}
		const account = snapshot.accounts.find(a => a.id === entry.row.accountId)
		if (account === undefined) {
			return Box({ width: '100%' })
		}
		const usage = snapshot.usage.find(u => u.accountId === entry.row.accountId)
		return accountLine(
			ctx,
			account,
			usage,
			hiddenIds,
			resetColumn,
			badgeColumn,
			state?.activeAccountId === entry.row.accountId,
			isSelected,
			switched
		)
	})
	const routed = ctx.routing[provider]
	const auto = state?.policy.enabled ? `auto ${state.policy.thresholdPercent}%` : 'auto off'
	const title = routed
		? ` ${providerTitles[provider]}   ● ${auto} `
		: ` ${providerTitles[provider]}   ✗ off `
	const titleColor = !routed
		? ctx.theme.warn
		: state?.policy.enabled
			? ctx.theme.good
			: ctx.theme.dim
	const banner = routed
		? []
		: [
				Box(
					{ flexDirection: 'row', width: '100%' },
					Text({
						content: ` tokenmaxx is off for ${providerCli[provider]} — turn it on in settings`,
						fg: rgb(ctx.theme.warn)
					})
				)
			]
	return Box(
		{
			border: true,
			borderColor: rgb(routed ? ctx.theme.border : ctx.theme.warn),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexShrink: 0,
			title,
			titleColor: rgb(titleColor),
			width: '100%'
		},
		...banner,
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

function metricRow(
	name: { text: string; color: string; bold?: boolean },
	cells: { text: string; color: string }[],
	nameWidth: number
) {
	return centered(
		Text({ attributes: name.bold ? 1 : 0, content: pad(name.text, nameWidth), fg: rgb(name.color) }),
		...cells.map(cell => Text({ content: cell.text.padStart(10), fg: rgb(cell.color) }))
	)
}

function metricsView(ctx: Ctx, tokens: TokenTimeframe, scroll: number) {
	const body: ReturnType<typeof Box>[] = []
	const nameWidth = ctx.tier === 'compact' ? 16 : 20
	const num = (value: number) => compactNumber(value)
	const faint = (text: string) => ({ color: ctx.theme.faint, text })
	body.push(
		metricRow(
			{ color: ctx.theme.faint, text: 'tokens by provider' },
			[faint('in'), faint('out'), faint('cache'), faint('value')],
			nameWidth
		)
	)
	for (const provider of tokens.byProvider) {
		body.push(
			metricRow(
				{ color: ctx.theme.fg, text: providerShort[provider.provider] },
				[
					{ color: ctx.theme.dim, text: num(provider.input) },
					{ color: ctx.theme.dim, text: num(provider.output) },
					{ color: ctx.theme.dim, text: num(provider.cached + provider.cacheCreation) },
					{ color: ctx.theme.good, text: moneyUsd(provider.costUsd) }
				],
				nameWidth
			)
		)
	}
	body.push(
		metricRow(
			{ bold: true, color: ctx.theme.fg, text: 'total' },
			[
				{ color: ctx.theme.fg, text: num(tokens.totalInput) },
				{ color: ctx.theme.fg, text: num(tokens.totalOutput) },
				{ color: ctx.theme.fg, text: num(tokens.totalCached + tokens.totalCacheCreation) },
				{ color: ctx.theme.good, text: moneyUsd(tokens.costUsd) }
			],
			nameWidth
		)
	)
	if (ctx.tier === 'wide') {
		body.push(
			metricRow(
				{ color: ctx.theme.faint, text: '$ by class' },
				[
					{ color: ctx.theme.faint, text: moneyUsd(tokens.costInput) },
					{ color: ctx.theme.faint, text: moneyUsd(tokens.costOutput) },
					{ color: ctx.theme.faint, text: moneyUsd(tokens.costCached + tokens.costCacheCreation) },
					{ color: ctx.theme.faint, text: moneyUsd(tokens.costUsd) }
				],
				nameWidth
			)
		)
	}
	body.push(blankRow(ctx))
	body.push(
		metricRow(
			{ color: ctx.theme.faint, text: 'by model' },
			[faint('tokens'), faint('value')],
			nameWidth + 9
		)
	)
	const maxRows = Math.max(3, ctx.rows - 18)
	const start = Math.max(0, Math.min(scroll, Math.max(0, tokens.models.length - maxRows)))
	const shown = tokens.models.slice(start, start + maxRows)
	for (const model of shown) {
		body.push(
			metricRow(
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
	const rows = allRows.map((row, index) => ({ index, row })).filter(e => e.row.provider === provider)
	const lines = rows.map(entry => {
		const { row } = entry
		const isSelected = entry.index === selected
		const hidden =
			row.windowId !== undefined && (policy?.hiddenWindowIds ?? []).includes(row.windowId)
		const routed = ctx.routing[row.provider]
		const label =
			row.key === 'routing'
				? 'tokenmaxx'
				: row.key === 'auto'
					? 'auto-rotate'
					: row.key === 'threshold'
						? 'switch at'
						: row.key === 'dwell'
							? 'cooldown'
							: `${shortWindow(row.windowLabel ?? '')} limit`
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
				? `run ${providerCli[row.provider]} through tokenmaxx`
				: row.key === 'auto'
					? 'switch accounts as the active one fills'
					: row.key === 'threshold'
						? 'switch here; the rest stays in reserve'
						: row.key === 'dwell'
							? 'min wait between switches (anti-flap)'
							: 'show on the accounts page'
		const on =
			(row.key === 'routing' && routed) ||
			(row.key === 'auto' && (policy?.enabled ?? false)) ||
			(row.key === 'window' && !hidden)
		const valueColor =
			row.key === 'routing'
				? routed
					? ctx.theme.good
					: ctx.theme.warn
				: row.key === 'auto' || row.key === 'window'
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
			Text({ content: pad(label, 12), fg: rgb(isSelected ? ctx.theme.fg : ctx.theme.dim) }),
			Text({ attributes: 1, content: pad(value, 7), fg: rgb(valueColor) }),
			Text({ content: pad(hint, 40), fg: rgb(ctx.theme.faint) })
		)
	})
	const routed = ctx.routing[provider]
	const auto = policy?.enabled ? `⟳ auto ${policy.thresholdPercent}%` : 'auto off'
	return Box(
		{
			border: true,
			borderColor: rgb(routed ? ctx.theme.border : ctx.theme.warn),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexShrink: 0,
			title: routed
				? ` ${providerTitles[provider]}   ${auto} `
				: ` ${providerTitles[provider]}   ✗ off `,
			titleColor: rgb(!routed ? ctx.theme.warn : policy?.enabled ? ctx.theme.good : ctx.theme.dim),
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
			Box({ flexDirection: 'row' }, Text({ content: 'changes apply live', fg: rgb(ctx.theme.faint) }))
		],
		78
	)
}

function accountsBody(ctx: Ctx, snapshot: DashboardSnapshot, rows: Row[], selected: number) {
	const note = legend(ctx, snapshot)
	const width = accountsWidth(ctx, snapshot)
	return column(
		ctx,
		[
			providerPanel(ctx, snapshot, 'openai', rows, selected),
			providerPanel(ctx, snapshot, 'anthropic', rows, selected),
			...(note === null ? [] : [note])
		],
		width + 2
	)
}

interface ResetConfirm {
	accountId: string
	credits: ResetCreditsView
}

interface AddConfirm {
	provider: ProviderId
	choice: 'oauth' | 'apiKey'
}

function addConfirmBody(ctx: Ctx, confirm: AddConfirm) {
	const cli = providerCli[confirm.provider]
	const installed = ctx.cliPresent[confirm.provider]
	const line = (...children: ReturnType<typeof Text>[]) =>
		Box(
			{ flexDirection: 'row', width: '100%' },
			Text({ content: '  ', fg: rgb(ctx.theme.bg) }),
			...children
		)
	const option = (selected: boolean, title: string, note: string | null, details: string[]) => [
		line(
			Text({
				content: selected ? '▸ ' : '○ ',
				fg: rgb(selected ? ctx.theme.accent : ctx.theme.faint)
			}),
			Text({
				attributes: selected ? 1 : 0,
				content: title,
				fg: rgb(selected ? ctx.theme.fg : ctx.theme.dim)
			}),
			Text({ content: note === null ? '' : ` · ${note}`, fg: rgb(ctx.theme.warn) })
		),
		...details.map(detail => line(Text({ content: `  ${detail}`, fg: rgb(ctx.theme.dim) })))
	]
	const card = Box(
		{
			border: true,
			borderColor: rgb(ctx.theme.accent),
			borderStyle: 'rounded',
			flexDirection: 'column',
			title: ` Add a ${providerShort[confirm.provider]} account `,
			titleColor: rgb(ctx.theme.accent),
			width: '100%'
		},
		blankRow(ctx),
		...option(
			confirm.choice === 'oauth',
			`sign in with ${cli}`,
			installed ? null : `install ${cli} first`,
			['your subscription account; its rate-limit windows meter here']
		),
		blankRow(ctx),
		...option(confirm.choice === 'apiKey', 'add an api key', null, [
			'bills per token at api rates; account limits do not apply',
			'finishes in the terminal: paste the key, name the account'
		]),
		blankRow(ctx),
		line(
			Text({ attributes: 1, bg: rgb(ctx.theme.selected), content: ' ⏎ ', fg: rgb(ctx.theme.fg) }),
			Text({ content: ' continue      ', fg: rgb(ctx.theme.dim) }),
			Text({ attributes: 1, bg: rgb(ctx.theme.selected), content: ' esc ', fg: rgb(ctx.theme.fg) }),
			Text({ content: ' back', fg: rgb(ctx.theme.dim) })
		),
		blankRow(ctx)
	)
	return column(ctx, [card], 70)
}

function resetNote(outcome: ResetOutcome): string {
	switch (outcome.code) {
		case 'reset':
			return `↺ reset applied — ${outcome.windowsReset === 1 ? '1 window' : `${outcome.windowsReset} windows`} cleared`
		case 'nothing_to_reset':
			return '↺ kept — nothing is at its limit'
		case 'no_credit':
			return 'no reset available on this account'
		case 'already_redeemed':
			return '↺ already used — nothing consumed'
	}
}

function resetConfirmBody(ctx: Ctx, snapshot: DashboardSnapshot, confirm: ResetConfirm) {
	const account = snapshot.accounts.find(a => a.id === confirm.accountId)
	const usage = snapshot.usage.find(u => u.accountId === confirm.accountId)
	const applicable = accountResetCredits(usage)?.applicable ?? 0
	const tag = planTag(account?.plan)
	const banked = confirm.credits.available
	const soonest = shortReset(confirm.credits.credits[0]?.expiresAt ?? null, ctx.now)
	const line = (...children: ReturnType<typeof Text>[]) =>
		Box(
			{ flexDirection: 'row', width: '100%' },
			Text({ content: '  ', fg: rgb(ctx.theme.bg) }),
			...children
		)
	const card = Box(
		{
			border: true,
			borderColor: rgb(ctx.theme.accent),
			borderStyle: 'rounded',
			flexDirection: 'column',
			title: ' Use a rate limit reset ',
			titleColor: rgb(ctx.theme.accent),
			width: '100%'
		},
		blankRow(ctx),
		line(
			Text({ attributes: 1, content: account?.label ?? '', fg: rgb(ctx.theme.fg) }),
			Text({ content: tag === null ? '' : ` · ${tag}`, fg: rgb(ctx.theme.faint) })
		),
		line(
			Text({
				content: 'clears its limited rate-limit windows immediately',
				fg: rgb(ctx.theme.dim)
			})
		),
		blankRow(ctx),
		line(
			Text({
				attributes: 1,
				content: `↺ ${banked} banked`,
				fg: rgb(applicable > 0 ? ctx.theme.good : ctx.theme.fg)
			}),
			Text({
				content: soonest === null ? '' : ` · soonest expires in ${soonest}`,
				fg: rgb(ctx.theme.dim)
			})
		),
		blankRow(ctx),
		line(
			Text({ attributes: 1, bg: rgb(ctx.theme.selected), content: ' ⏎ ', fg: rgb(ctx.theme.fg) }),
			Text({ content: ' use one now      ', fg: rgb(ctx.theme.dim) }),
			Text({ attributes: 1, bg: rgb(ctx.theme.selected), content: ' esc ', fg: rgb(ctx.theme.fg) }),
			Text({ content: ' keep it banked', fg: rgb(ctx.theme.dim) })
		),
		blankRow(ctx)
	)
	return column(ctx, [card], 60)
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
	alert: string
	addConfirm: AddConfirm | null
	resetConfirm: ResetConfirm | null
	updateAvailable: string | null
	updateDismissed: boolean
}

type DashboardAction =
	| { kind: 'relogin'; provider: ProviderId }
	| { kind: 'login'; provider: ProviderId }
	| { kind: 'loginApiKey'; provider: ProviderId }
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
	const selectedRow = rows[state.selected]
	const selectedUsage =
		selectedRow === undefined
			? undefined
			: analytics.snapshot.usage.find(u => u.accountId === selectedRow.accountId)
	const resettable =
		state.tab === 'accounts' &&
		selectedRow !== undefined &&
		selectedRow.accountId !== ADD_ROW &&
		(accountResetCredits(selectedUsage)?.available ?? 0) > 0
	const spillable = state.tab === 'accounts' && selectedUsage?.extraUsage?.enabled === true
	const footer =
		state.addConfirm !== null
			? '↑↓ choose · ⏎ continue · esc back'
			: state.resetConfirm !== null
				? '⏎ use one reset · esc keep it banked'
				: state.tab === 'accounts'
					? `↑↓ select · ⏎ switch/add · a auto${resettable ? ' · r reset' : ''}${spillable ? ' · e spill' : ''} · tab next`
					: state.tab === 'analytics'
						? '←→ range · m chart/metrics · ↑↓ scroll · tab next'
						: '↑↓ select · ←→ adjust · ⏎ toggle · tab next'
	const header = Box(
		{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
		Box(
			{ flexDirection: 'row', width: Math.min(CONTENT_MAX, ctx.columns - 2) },
			Text({ attributes: 1, content: 'tokenmaxx', fg: rgb(ctx.theme.accent) }),
			Text({ content: `  ${clock}`, fg: rgb(ctx.theme.dim) }),
			Text({ content: `   ↻ ${refreshed}`, fg: rgb(ctx.theme.faint) }),
			...(state.note === '' ? [] : [Text({ content: `   ${state.note}`, fg: rgb(ctx.theme.warn) })])
		)
	)
	const children: Array<ReturnType<typeof Box> | ReturnType<typeof Text>> = [header]
	if (state.alert !== '') {
		children.push(
			Box(
				{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
				Box(
					{ flexDirection: 'row', width: Math.min(CONTENT_MAX, ctx.columns - 2) },
					Text({ content: state.alert, fg: rgb(ctx.theme.warn) })
				)
			)
		)
	}
	children.push(
		Box(
			{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
			Box(
				{ flexDirection: 'row', width: Math.min(CONTENT_MAX, ctx.columns - 2) },
				tabBar(ctx, state.tab)
			)
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
			? state.addConfirm !== null
				? addConfirmBody(ctx, state.addConfirm)
				: state.resetConfirm !== null
					? resetConfirmBody(ctx, analytics.snapshot, state.resetConfirm)
					: accountsBody(ctx, analytics.snapshot, rows, state.selected)
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
				{ flexDirection: 'row', width: Math.min(CONTENT_MAX, ctx.columns - 2) },
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

interface FixtureOptions {
	name: string
	now: number
	timewarp: number
}

export async function runTuiDashboard(
	socketPath: string,
	options: { routing: Record<ProviderId, boolean>; fixture?: FixtureOptions; alert?: string }
): Promise<DashboardAction | undefined> {
	const fixture = options.fixture
	const live = fixture === undefined
	try {
		process.stdin.setRawMode?.(true)
	} catch {}
	const cliPresent: Record<ProviderId, boolean> = live
		? { anthropic: Bun.which('claude') !== null, openai: Bun.which('codex') !== null }
		: { anthropic: true, openai: true }
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
		addConfirm: null,
		alert: options.alert ?? '',
		analyticsView: 'chart',
		modelScroll: 0,
		note: '',
		resetConfirm: null,
		selected: 0,
		settingsSelected: 0,
		tab: 'accounts',
		timeframeIndex: 2,
		updateAvailable: live ? null : (process.env.TOKENMAXX_FAKE_UPDATE ?? null),
		updateDismissed: false
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
					cliPresent,
					columns,
					now: live ? Date.now() : simulatedNow,
					routing: options.routing,
					rows: process.stdout.rows ?? 24,
					switchFlagMs: fixture !== undefined && fixture.timewarp > 0 ? 24 * 60_000 : 120_000,
					theme: currentTheme(),
					tier: tierFor(columns)
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
		if (row.accountId === ADD_ROW) {
			state.addConfirm = {
				choice: cliPresent[row.provider] ? 'oauth' : 'apiKey',
				provider: row.provider
			}
			paint()
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

	const openResetConfirm = (): boolean => {
		const row = rows[state.selected]
		if (row === undefined || row.accountId === ADD_ROW) {
			return false
		}
		const usage = analytics.snapshot.usage.find(u => u.accountId === row.accountId)
		const credits = accountResetCredits(usage)
		if (credits === null || credits.available === 0) {
			return false
		}
		if (!live) {
			const day = 24 * 3_600_000
			state.resetConfirm = {
				accountId: row.accountId,
				credits: {
					available: credits.available,
					credits: Array.from({ length: credits.available }, (_, index) => ({
						expiresAt: new Date(simulatedNow + (11 + index * 12) * day).toISOString(),
						id: `banked-${index + 1}`,
						title: 'Full reset'
					}))
				}
			}
			paint()
			return true
		}
		void withBusy('checking resets…', async () => {
			const fresh = await requestResetCredits(socketPath, row.accountId)
			state.resetConfirm = { accountId: row.accountId, credits: fresh }
		})
		return true
	}

	const consumeReset = (confirm: ResetConfirm) => {
		state.resetConfirm = null
		if (!live) {
			state.note = '↺ reset applied — rate-limit windows cleared'
			paint()
			return
		}
		let outcome: ResetOutcome | null = null
		void withBusy('using a reset…', async () => {
			outcome = await requestConsumeReset(socketPath, confirm.accountId)
			analytics = await readAnalytics(socketPath)
			rows = orderedRows(analytics.snapshot)
		}).then(() => {
			if (outcome !== null) {
				state.note = resetNote(outcome)
				paint()
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

	const toggleRouting = (provider: ProviderId) => {
		finish({ enable: !options.routing[provider], kind: 'routing', provider })
	}

	const adjustSetting = (delta: number) => {
		const row = buildSettingRows(analytics.snapshot)[state.settingsSelected]
		if (row === undefined) {
			return
		}
		const policy = currentPolicy(row.provider)
		if (row.key === 'routing') {
			toggleRouting(row.provider)
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
		const hangup = () => finish()
		finish = (result?: DashboardAction) => {
			if (finished) {
				return
			}
			finished = true
			action = result
			if (interval !== null) {
				clearInterval(interval)
			}
			process.stdin.off('end', hangup)
			process.stdin.off('close', hangup)
			process.stdin.off('error', hangup)
			process.stdout.off('error', hangup)
			process.off('SIGHUP', hangup)
			try {
				renderer.destroy()
			} catch {}
			resolve()
		}
		process.stdin.once('end', hangup)
		process.stdin.once('close', hangup)
		process.stdin.once('error', hangup)
		process.stdout.once('error', hangup)
		process.once('SIGHUP', hangup)
		const changeTimeframe = (delta: number) => {
			state.timeframeIndex = Math.max(0, Math.min(TIMEFRAMES.length - 1, state.timeframeIndex + delta))
			paint()
		}
		renderer.keyInput.on('keypress', (key: { name: string; ctrl: boolean }) => {
			try {
				if (state.alert !== '') {
					state.alert = ''
					paint()
				}
				if (state.addConfirm !== null) {
					const confirm = state.addConfirm
					if (key.ctrl && key.name === 'c') {
						finish()
					} else if (key.name === 'up' || key.name === 'down' || key.name === 'k' || key.name === 'j') {
						state.addConfirm = {
							...confirm,
							choice: confirm.choice === 'oauth' ? 'apiKey' : 'oauth'
						}
						paint()
					} else if (key.name === 'return') {
						state.addConfirm = null
						if (live) {
							finish({
								kind: confirm.choice === 'apiKey' ? 'loginApiKey' : 'login',
								provider: confirm.provider
							})
						} else {
							paint()
						}
					} else if (key.name === 'escape' || key.name === 'q') {
						state.addConfirm = null
						paint()
					}
					return
				}
				if (state.resetConfirm !== null) {
					if (key.ctrl && key.name === 'c') {
						finish()
					} else if (key.name === 'return') {
						consumeReset(state.resetConfirm)
					} else if (key.name === 'escape' || key.name === 'q') {
						state.resetConfirm = null
						paint()
					}
					return
				}
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
				} else if (key.name === 'm' && state.tab === 'analytics') {
					state.analyticsView = state.analyticsView === 'chart' ? 'table' : 'chart'
					state.modelScroll = 0
					paint()
				} else if (key.name === 'tab') {
					state.tab = TABS[(TABS.indexOf(state.tab) + 1) % TABS.length] as Tab
					paint()
				} else if (key.name === 'r') {
					if (!(state.tab === 'accounts' && openResetConfirm()) && live) {
						void reload(true)
					}
				} else if (state.tab === 'analytics') {
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
				} else if (key.name === 'return') {
					const row = rows[state.selected]
					if (row !== undefined && row.accountId === ADD_ROW) {
						state.addConfirm = {
							choice: cliPresent[row.provider] ? 'oauth' : 'apiKey',
							provider: row.provider
						}
						paint()
					} else if (live) {
						switchToSelected()
					}
				} else if (key.name === 'a' && live) {
					const row = rows[state.selected]
					if (row !== undefined && row.accountId !== ADD_ROW) {
						toggleAuto(row.provider)
					}
				} else if (key.name === 'e' && live) {
					const row = rows[state.selected]
					const account =
						row === undefined ? undefined : analytics.snapshot.accounts.find(a => a.id === row.accountId)
					const usage =
						row === undefined
							? undefined
							: analytics.snapshot.usage.find(u => u.accountId === row.accountId)
					if (account !== undefined && usage?.extraUsage?.enabled === true) {
						const onThreshold = account.onThreshold === 'spill' ? 'switch' : 'spill'
						void withBusy(
							onThreshold === 'spill' ? 'spilling into extra usage…' : 'switching at threshold…',
							async () => {
								await requestAccountSave(
									socketPath,
									{ ...account, onThreshold, updatedAt: new Date().toISOString() },
									{ profilePath: null, secretReference: null }
								)
								analytics = await readAnalytics(socketPath)
								rows = orderedRows(analytics.snapshot)
							}
						)
					}
				}
			} catch {}
		})
		paint()
		renderer.start()
	})
	return action
}
