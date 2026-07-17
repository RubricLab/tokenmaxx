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
	compactUsd,
	detectThemeName,
	healthBadge,
	meter,
	percentLabel,
	planLabel,
	pressureColor,
	relativeAge,
	resetCountdown,
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

interface Ctx {
	theme: Theme
	now: number
	columns: number
	view: ViewMode
	// How long a completed switch stays flagged. Long in fixture timelapses
	// (simulated minutes pass per paint), short in live mode.
	switchFlagMs: number
}

function labelWidth(ctx: Ctx): number {
	return ctx.columns < 100 ? 18 : 26
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
	}
	return rows
}

function accountLine(
	ctx: Ctx,
	account: Account,
	windows: readonly UsageWindow[],
	isActive: boolean,
	isSelected: boolean,
	justSwitchedTo: boolean
) {
	const badge = healthBadge(ctx.theme, account)
	const labels = labelWidth(ctx)
	const marker = justSwitchedTo && isActive ? '⟳' : isActive ? '●' : isSelected ? '▸' : '○'
	const markerColor =
		justSwitchedTo && isActive
			? ctx.theme.warn
			: isActive
				? ctx.theme.good
				: isSelected
					? ctx.theme.accent
					: ctx.theme.faint
	const children = [
		Text({ content: ` ${marker} `, fg: rgb(markerColor) }),
		Text({
			attributes: isActive ? 1 : 0,
			content: pad(account.label, labels - 2),
			fg: rgb(
				justSwitchedTo && isActive
					? ctx.theme.warn
					: isActive || isSelected
						? ctx.theme.fg
						: ctx.theme.dim
			)
		}),
		Text({ content: badge === null ? '  ' : ' *', fg: rgb(badge?.color ?? ctx.theme.dim) })
	]
	if (windows.length === 0) {
		children.push(Text({ content: account.health === 'ready' ? ' …' : ' —', fg: rgb(ctx.theme.dim) }))
		return Box(
			{
				backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
				flexDirection: 'row',
				width: '100%'
			},
			...children
		)
	}
	const hard = hardWindows(windows)
	const focused =
		ctx.view === '5h'
			? hard.filter(isFiveHour)
			: ctx.view === '7d'
				? hard.filter(window => !isFiveHour(window))
				: hard
	if (ctx.view === 'all') {
		// Fit as many windows as the terminal width allows; meters grow when
		// there is room to spare so pressure reads at a glance.
		const available = ctx.columns - labels - 7
		const budget = Math.max(1, Math.floor(available / 21))
		const shown = focused.slice(0, Math.min(3, budget))
		const meterWidth = shown.length > 0 && available / shown.length >= 30 ? 10 : 6
		for (const window of shown) {
			children.push(
				Text({ content: ` ${shortWindow(window.label)} `, fg: rgb(ctx.theme.dim) }),
				Text({
					content: `${meter(window.usedPercent, meterWidth)} ${percentLabel(window.usedPercent)}`,
					fg: rgb(pressureColor(ctx.theme, window.usedPercent))
				})
			)
		}
	} else {
		// Focused view: one wide bar — the binding window, so a scoped limit
		// (7 day · Fable) that fills first is the one on display.
		const window = focused.reduce(
			(worst, candidate) =>
				worst === undefined || candidate.usedPercent > worst.usedPercent ? candidate : worst,
			undefined as UsageWindow | undefined
		)
		if (window === undefined) {
			children.push(Text({ content: ' —', fg: rgb(ctx.theme.dim) }))
		} else {
			const reset = resetCountdown(window.resetAt, ctx.now)
			const tag = focused.length > 1 ? `${shortWindow(window.label)} ` : ''
			const barWidth = Math.max(10, ctx.columns - labels - 22 - tag.length)
			children.push(
				Text({
					content: `${meter(window.usedPercent, barWidth)} ${percentLabel(window.usedPercent)}`,
					fg: rgb(pressureColor(ctx.theme, window.usedPercent))
				}),
				Text({
					content: reset === null ? `  ${tag}`.trimEnd() : `  ${tag}↻ ${reset}`,
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

function accountDetail(ctx: Ctx, account: Account, windows: readonly UsageWindow[]) {
	const indent = ' '.repeat(5)
	const plan = planLabel(account.plan)
	const lines: ReturnType<typeof Box>[] = [
		Box(
			{ backgroundColor: rgb(ctx.theme.selected), flexDirection: 'row' },
			Text({ content: `${indent}${providerShort[account.provider]}`, fg: rgb(ctx.theme.dim) }),
			Text({
				attributes: plan === null ? 0 : 1,
				content: plan === null ? '  ·  plan —' : `  ·  ${plan}`,
				fg: rgb(plan === null ? ctx.theme.dim : ctx.theme.accent)
			})
		)
	]
	const hard = hardWindows(windows)
	if (hard.length === 0) {
		lines.push(
			Box(
				{ backgroundColor: rgb(ctx.theme.selected), flexDirection: 'row' },
				Text({
					content: `${indent}${account.health === 'ready' ? 'waiting for usage…' : 'usage unavailable'}`,
					fg: rgb(ctx.theme.dim)
				})
			)
		)
	}
	for (const window of hard) {
		const reset = resetCountdown(window.resetAt, ctx.now)
		lines.push(
			Box(
				{ backgroundColor: rgb(ctx.theme.selected), flexDirection: 'row' },
				Text({ content: `${indent}${pad(window.label, 20)} `, fg: rgb(ctx.theme.dim) }),
				Text({
					content: `${meter(window.usedPercent, 8)} ${percentLabel(window.usedPercent)}`,
					fg: rgb(pressureColor(ctx.theme, window.usedPercent))
				}),
				Text({
					content: reset === null ? '' : `   resets in ${reset}`,
					fg: rgb(ctx.theme.dim)
				})
			)
		)
	}
	const shortId = account.externalAccountId?.slice(0, 8) ?? '—'
	const added = account.createdAt.slice(0, 10)
	lines.push(
		Box(
			{ backgroundColor: rgb(ctx.theme.selected), flexDirection: 'row' },
			Text({ content: `${indent}account ${shortId}  ·  added ${added}`, fg: rgb(ctx.theme.faint) })
		)
	)
	return lines
}

function providerPanel(
	ctx: Ctx,
	snapshot: DashboardSnapshot,
	provider: ProviderId,
	rows: Row[],
	selected: number,
	expanded: boolean
) {
	const state: ProviderState | undefined = snapshot.providers.find(s => s.provider === provider)
	const switched = recentSwitch(ctx, state)
	const providerRows = rows
		.map((row, index) => ({ index, row }))
		.filter(entry => entry.row.provider === provider)
	const lines: ReturnType<typeof Box>[] =
		providerRows.length === 0
			? [
					Box(
						{ flexDirection: 'row', width: '100%' },
						Text({
							content: `   no accounts — tokenmaxx login ${providerCli[provider]}`,
							fg: rgb(ctx.theme.dim)
						})
					)
				]
			: providerRows.flatMap(entry => {
					const account = snapshot.accounts.find(a => a.id === entry.row.accountId)
					if (account === undefined) {
						return [Box({ width: '100%' })]
					}
					const windows = snapshot.usage.find(u => u.accountId === entry.row.accountId)?.windows
					const isSelected = entry.index === selected
					const line = accountLine(
						ctx,
						account,
						windows ?? [],
						state?.activeAccountId === entry.row.accountId,
						isSelected,
						switched
					)
					return isSelected && expanded ? [line, ...accountDetail(ctx, account, windows ?? [])] : [line]
				})
	const auto = state?.policy.enabled ? `⟳ auto ${state.policy.thresholdPercent}%` : 'auto off'
	const activeLabel = snapshot.accounts.find(a => a.id === state?.activeAccountId)?.label
	const title = switched
		? ` ${providerTitles[provider]}   ⟳ switched → ${activeLabel ?? '?'} `
		: ` ${providerTitles[provider]}   ${auto} `
	return Box(
		{
			border: true,
			borderColor: rgb(switched ? ctx.theme.warn : ctx.theme.border),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexShrink: 0,
			title,
			titleColor: rgb(
				switched ? ctx.theme.warn : state?.policy.enabled ? ctx.theme.good : ctx.theme.dim
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

function timeframeBar(ctx: Ctx, timeframe: Timeframe) {
	const cells = TIMEFRAMES.flatMap((option, index) => [
		...(index === 0 ? [] : [Text({ content: ' ', fg: rgb(ctx.theme.faint) })]),
		pill(ctx, option.label, option.key === timeframe.key)
	])
	return Box(
		{ flexDirection: 'row', paddingLeft: 1, width: '100%' },
		Text({ content: 'range  ', fg: rgb(ctx.theme.dim) }),
		...cells
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

function throughputChart(
	ctx: Ctx,
	tokens: TokenTimeframe,
	timeframe: Timeframe,
	height: number,
	width: number
) {
	const body: ReturnType<typeof Box>[] = []
	const axisTop = `${compactNumber(tokens.peakPerHour)}/h`
	const gutter = Math.max(6, axisTop.length)
	const chartWidth = Math.max(16, width - gutter - 1)
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

function analyticsBody(ctx: Ctx, analytics: AnalyticsSnapshot, timeframe: Timeframe) {
	const cols = process.stdout.columns ?? 80
	const rows = process.stdout.rows ?? 24
	const width = Math.max(24, Math.min(160, cols - 12))
	const height = Math.max(4, Math.min(9, rows - 20))
	const tokens = analytics.tokens?.timeframes.find(entry => entry.key === timeframe.key)
	const body: ReturnType<typeof Box>[] = []
	if (tokens === undefined || tokens.totalTokens === 0) {
		for (let index = 0; index < Math.max(1, Math.floor(height / 2)); index += 1) {
			body.push(Box({ flexDirection: 'row' }, Text({ content: ' ', fg: rgb(ctx.theme.bg) })))
		}
		body.push(
			Box(
				{ flexDirection: 'row', justifyContent: 'center', width: '100%' },
				Text({ content: 'no token usage yet — run ', fg: rgb(ctx.theme.dim) }),
				Text({ content: 'codex', fg: rgb(ctx.theme.fg) }),
				Text({ content: ' or ', fg: rgb(ctx.theme.dim) }),
				Text({ content: 'claude', fg: rgb(ctx.theme.fg) }),
				Text({ content: ' and it fills in live', fg: rgb(ctx.theme.dim) })
			)
		)
	} else {
		body.push(...throughputChart(ctx, tokens, timeframe, height, width))
		const spanHours = (tokens.bucketMs * tokens.buckets.length) / 3_600_000
		const averagePerHour = spanHours > 0 ? tokens.totalTokens / spanHours : 0
		const nowPerHour = analytics.tokens?.nowPerHour ?? 0
		const cachedShare =
			tokens.totalTokens > 0
				? Math.round(((tokens.totalCached + tokens.totalCacheCreation) / tokens.totalTokens) * 100)
				: 0
		// The hero numbers, centered: what you used, what it is worth, how fast.
		body.push(blankRow(ctx))
		body.push(
			centered(
				...stat(ctx, 'Σ', `${compactNumber(tokens.totalTokens)} tokens`),
				...stat(ctx, '≈', `${compactUsd(tokens.costUsd)} API value`, ctx.theme.good),
				Text({ content: 'now ', fg: rgb(ctx.theme.dim) }),
				Text({
					attributes: 1,
					content: `${compactNumber(nowPerHour)}/h`,
					fg: rgb(nowPerHour > 0 ? ctx.theme.accent : ctx.theme.faint)
				})
			)
		)
		// One quiet line of rates, one quieter line of composition.
		body.push(
			centered(
				Text({
					content: `peak ${compactNumber(tokens.peakPerHour)}/h    avg ${compactNumber(averagePerHour)}/h    ${cachedShare}% cached`,
					fg: rgb(ctx.theme.dim)
				})
			)
		)
		body.push(
			centered(
				Text({
					content: `in ${compactNumber(tokens.totalInput)} · out ${compactNumber(tokens.totalOutput)} · cache read ${compactNumber(tokens.totalCached)} · cache write ${compactNumber(tokens.totalCacheCreation)}`,
					fg: rgb(ctx.theme.faint)
				})
			)
		)
		// Where it went: a centered table, headers faint, numbers flush right.
		if (tokens.topModels.length > 0) {
			body.push(blankRow(ctx))
			body.push(
				centered(
					Text({ content: pad('model', 24), fg: rgb(ctx.theme.faint) }),
					Text({ content: pad('via', 8), fg: rgb(ctx.theme.faint) }),
					Text({ content: 'tokens'.padStart(8), fg: rgb(ctx.theme.faint) }),
					Text({ content: '≈ value'.padStart(10), fg: rgb(ctx.theme.faint) })
				)
			)
			for (const model of tokens.topModels) {
				body.push(
					centered(
						Text({ content: pad(model.model, 24), fg: rgb(ctx.theme.fg) }),
						Text({ content: pad(providerCli[model.provider], 8), fg: rgb(ctx.theme.faint) }),
						Text({ content: compactNumber(model.tokens).padStart(8), fg: rgb(ctx.theme.dim) }),
						Text({ content: compactUsd(model.costUsd).padStart(10), fg: rgb(ctx.theme.dim) })
					)
				)
			}
		}
		body.push(blankRow(ctx))
	}
	const card = Box(
		{
			border: true,
			borderColor: rgb(ctx.theme.border),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexGrow: 1,
			title: ' Token throughput · all accounts · both providers · metered by the proxy ',
			titleColor: rgb(ctx.theme.dim),
			width: '100%'
		},
		...body
	)
	return [timeframeBar(ctx, timeframe), card]
}

// Settings rows are a flat list across both providers so ↑↓ walks everything.
interface SettingRow {
	provider: ProviderId
	key: 'auto' | 'threshold' | 'dwell'
}

const SETTING_ROWS: readonly SettingRow[] = providerOrder.flatMap(provider => [
	{ key: 'auto' as const, provider },
	{ key: 'threshold' as const, provider },
	{ key: 'dwell' as const, provider }
])

function dwellLabel(milliseconds: number): string {
	const minutes = Math.round(milliseconds / 60_000)
	return minutes === 0 ? 'off' : `${minutes}m`
}

function settingsPanel(
	ctx: Ctx,
	snapshot: DashboardSnapshot,
	provider: ProviderId,
	selected: number
) {
	const state = snapshot.providers.find(s => s.provider === provider)
	const policy = state?.policy
	const rows = SETTING_ROWS.map((row, index) => ({ index, row })).filter(
		entry => entry.row.provider === provider
	)
	const lines = rows.map(entry => {
		const isSelected = entry.index === selected
		const marker = isSelected ? ' ▸ ' : '   '
		const value =
			entry.row.key === 'auto'
				? policy?.enabled
					? 'on'
					: 'off'
				: entry.row.key === 'threshold'
					? `${policy?.thresholdPercent ?? 90}%`
					: dwellLabel(policy?.minimumDwellMilliseconds ?? 300_000)
		const hint =
			entry.row.key === 'auto'
				? 'rotate off an account before it runs out'
				: entry.row.key === 'threshold'
					? 'switch when the fullest rate-limit window reaches this'
					: 'hold a threshold switch this long (hard limits ignore it)'
		const label =
			entry.row.key === 'auto'
				? 'auto-rotate'
				: entry.row.key === 'threshold'
					? 'switch threshold'
					: 'minimum dwell'
		const valueColor =
			entry.row.key === 'auto' ? (policy?.enabled ? ctx.theme.good : ctx.theme.dim) : ctx.theme.fg
		return Box(
			{
				backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
				flexDirection: 'row',
				width: '100%'
			},
			Text({ content: marker, fg: rgb(ctx.theme.accent) }),
			Text({
				content: pad(label, 18),
				fg: rgb(isSelected ? ctx.theme.fg : ctx.theme.dim)
			}),
			Text({ attributes: 1, content: pad(value, 6), fg: rgb(valueColor) }),
			Text({ content: hint, fg: rgb(ctx.theme.faint) })
		)
	})
	const auto = policy?.enabled ? `⟳ auto ${policy.thresholdPercent}%` : 'auto off'
	return Box(
		{
			border: true,
			borderColor: rgb(ctx.theme.border),
			borderStyle: 'rounded',
			flexDirection: 'column',
			flexShrink: 0,
			title: ` ${providerTitles[provider]}   ${auto} `,
			titleColor: rgb(policy?.enabled ? ctx.theme.good : ctx.theme.dim),
			width: '100%'
		},
		...lines
	)
}

function settingsBody(ctx: Ctx, snapshot: DashboardSnapshot, selected: number) {
	return [
		settingsPanel(ctx, snapshot, 'openai', selected),
		settingsPanel(ctx, snapshot, 'anthropic', selected),
		Box(
			{ flexDirection: 'row', paddingLeft: 1 },
			Text({
				content:
					'switches land on the next request — no restart. auto on = you confirm your provider permits it.',
				fg: rgb(ctx.theme.faint)
			})
		),
		Box({ flexGrow: 1, width: '100%' })
	]
}

function accountsBody(
	ctx: Ctx,
	snapshot: DashboardSnapshot,
	rows: Row[],
	selected: number,
	expanded: boolean
) {
	const note = legend(ctx, snapshot)
	return [
		providerPanel(ctx, snapshot, 'openai', rows, selected, expanded),
		providerPanel(ctx, snapshot, 'anthropic', rows, selected, expanded),
		Box({ flexGrow: 1, width: '100%' }),
		...(note === null ? [] : [note])
	]
}

interface ViewState {
	tab: Tab
	selected: number
	settingsSelected: number
	expanded: boolean
	timeframeIndex: number
	installed: boolean
	note: string
	updateAvailable: string | null
	updateDismissed: boolean
	view: ViewMode
}

export type DashboardAction =
	| { kind: 'relogin'; provider: ProviderId }
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
			? '↑↓ select · ⏎ switch/login · v view · space details · a auto · tab next'
			: state.tab === 'analytics'
				? '←→ range · tab next · r refresh'
				: '↑↓ select · ←→ adjust · ⏎ toggle · tab next'
	const header = Box(
		{ flexDirection: 'row' },
		Text({ attributes: 1, content: 'tokenmaxx', fg: rgb(ctx.theme.accent) }),
		Text({ content: `  ${clock}`, fg: rgb(ctx.theme.dim) }),
		Text({ content: `   ↻ ${refreshed}`, fg: rgb(ctx.theme.faint) }),
		...(state.note === '' ? [] : [Text({ content: `   ${state.note}`, fg: rgb(ctx.theme.warn) })])
	)
	const children: Array<ReturnType<typeof Box> | ReturnType<typeof Text>> = [header]
	if (!state.installed) {
		children.push(
			Box(
				{ backgroundColor: rgb(ctx.theme.warn), width: '100%' },
				Text({
					attributes: 1,
					bg: rgb(ctx.theme.warn),
					content: ' native routing is off — run  tokenmaxx install  to route codex & claude',
					fg: rgb(ctx.theme.bg)
				})
			)
		)
	}
	children.push(tabBar(ctx, state.tab))
	if (state.updateAvailable !== null && !state.updateDismissed) {
		children.push(
			Box(
				{ flexDirection: 'row', gap: 1 },
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
		...(state.tab === 'accounts'
			? accountsBody(ctx, analytics.snapshot, rows, state.selected, state.expanded)
			: state.tab === 'analytics'
				? analyticsBody(ctx, analytics, timeframe)
				: settingsBody(ctx, analytics.snapshot, state.settingsSelected))
	)
	children.push(Text({ content: footer, fg: rgb(ctx.theme.dim) }))
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
	options: { installed: boolean; fixture?: FixtureOptions }
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
		expanded: false,
		installed: options.installed,
		note: '',
		selected: 0,
		settingsSelected: 0,
		tab: 'accounts',
		timeframeIndex: 2,
		updateAvailable: null,
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
		let next: ReturnType<typeof Box>
		try {
			next = view(
				{
					columns: process.stdout.columns ?? 80,
					now: live ? Date.now() : simulatedNow,
					switchFlagMs: fixture !== undefined && fixture.timewarp > 0 ? 40 * 60_000 : 120_000,
					theme: currentTheme(),
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
		},
		message: string
	) => {
		const policy = currentPolicy(provider)
		const enable = change.enabled ?? policy?.enabled ?? false
		void withBusy(message, async () => {
			await requestPolicy(socketPath, {
				authorizationConfirmed: enable ? true : undefined,
				enabled: enable,
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

	const adjustSetting = (delta: number) => {
		const row = SETTING_ROWS[state.settingsSelected]
		if (row === undefined) {
			return
		}
		const policy = currentPolicy(row.provider)
		if (row.key === 'auto') {
			toggleAuto(row.provider)
			return
		}
		if (row.key === 'threshold') {
			const next = Math.max(10, Math.min(100, (policy?.thresholdPercent ?? 90) + delta * 5))
			applyPolicy(row.provider, { thresholdPercent: next }, `threshold ${next}%…`)
			return
		}
		const currentDwell = policy?.minimumDwellMilliseconds ?? 300_000
		const next = Math.max(0, Math.min(3_600_000, currentDwell + delta * 60_000))
		applyPolicy(row.provider, { minimumDwellMilliseconds: next }, `dwell ${dwellLabel(next)}…`)
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
				} else if (key.name === 'tab') {
					state.tab = TABS[(TABS.indexOf(state.tab) + 1) % TABS.length] as Tab
					paint()
				} else if (key.name === 'r' && live) {
					void reload(true)
				} else if (state.tab === 'analytics') {
					if (key.name === 'left' || key.name === 'up' || key.name === 'k') {
						changeTimeframe(-1)
					} else if (key.name === 'right' || key.name === 'down' || key.name === 'j') {
						changeTimeframe(1)
					}
				} else if (state.tab === 'settings') {
					if (key.name === 'up' || key.name === 'k') {
						state.settingsSelected = Math.max(0, state.settingsSelected - 1)
						paint()
					} else if (key.name === 'down' || key.name === 'j') {
						state.settingsSelected = Math.min(SETTING_ROWS.length - 1, state.settingsSelected + 1)
						paint()
					} else if (key.name === 'left' && live) {
						adjustSetting(-1)
					} else if (key.name === 'right' && live) {
						adjustSetting(1)
					} else if ((key.name === 'return' || key.name === 'space') && live) {
						const row = SETTING_ROWS[state.settingsSelected]
						if (row !== undefined) {
							if (row.key === 'auto') {
								toggleAuto(row.provider)
							} else {
								adjustSetting(1)
							}
						}
					}
				} else if (key.name === 'up' || key.name === 'k') {
					state.selected = Math.max(0, state.selected - 1)
					paint()
				} else if (key.name === 'down' || key.name === 'j') {
					state.selected = Math.max(0, Math.min(rows.length - 1, state.selected + 1))
					paint()
				} else if (key.name === 'space') {
					state.expanded = !state.expanded
					paint()
				} else if (key.name === 'return' && live) {
					switchToSelected()
				} else if (key.name === 'a' && live) {
					const row = rows[state.selected]
					if (row !== undefined) {
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
