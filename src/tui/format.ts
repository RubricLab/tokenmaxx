import type { Account } from '../domain.ts'

export interface Theme {
	fg: string
	dim: string
	faint: string
	accent: string
	bg: string
	panel: string
	selected: string
	border: string
	good: string
	warn: string
	bad: string
}

const darkTheme: Theme = {
	accent: '#5ab0ff',
	bad: '#ff5f6e',
	bg: '#0b0d10',
	border: '#2a3038',
	dim: '#8b93a1',
	faint: '#4b515c',
	fg: '#e6e6e6',
	good: '#3ad07a',
	panel: '#0f1216',
	selected: '#1b2330',
	warn: '#f0a83a'
}

const lightTheme: Theme = {
	accent: '#0b62d6',
	bad: '#d23b48',
	bg: '#fbfcfe',
	border: '#c7cedb',
	dim: '#5a6472',
	faint: '#aab2bd',
	fg: '#1c2430',
	good: '#1f9d57',
	panel: '#f2f4f8',
	selected: '#e3e9f2',
	warn: '#b9770f'
}

export type ThemeName = 'dark' | 'light'
export const themes: Record<ThemeName, Theme> = { dark: darkTheme, light: lightTheme }

export type ThemePreference = 'auto' | ThemeName

export function themeOverride(environment: NodeJS.ProcessEnv): ThemePreference | null {
	const value = environment.TOKENMAXX_THEME?.trim().toLowerCase()
	return value === 'light' || value === 'dark' || value === 'auto' ? value : null
}

export function detectThemeName(environment: NodeJS.ProcessEnv): ThemeName {
	const colorFgBg = environment.COLORFGBG
	if (colorFgBg !== undefined) {
		const background = Number(colorFgBg.split(';').pop())
		if (Number.isFinite(background)) {
			return background >= 7 ? 'light' : 'dark'
		}
	}
	return 'dark'
}

export interface TerminalPaletteColors {
	palette: readonly (string | null)[]
	defaultForeground: string | null
	defaultBackground: string | null
}

type Rgb = readonly [number, number, number]

// Plenty of terminal themes put their mid-tones almost on top of the background, so derived colors
// get pushed back toward the foreground until they clear these ratios or the text disappears.
const MIN_BASE_CONTRAST = 2.5
const MIN_DIM_CONTRAST = 3.5
const MIN_FAINT_CONTRAST = 2.2
const MIN_SEMANTIC_CONTRAST = 2.6
const CONTRAST_STEP = 0.08
const BLEND = { border: 0.22, dim: 0.65, faint: 0.4, panel: 0.05, selected: 0.12 } as const
// Slots 8-15 are a brighter take on 0-7 only by convention; Solarized reuses them as greys. Trust a
// bright slot only while it keeps its base hue, or `good` comes out grey.
const GREY_CHROMA = 0.1
const MAX_HUE_DRIFT = 45

function parseHex(value: string | null | undefined): Rgb | null {
	const match = value?.trim().match(/^#?([0-9a-f]{6})$/i)
	if (match?.[1] === undefined) {
		return null
	}
	const packed = Number.parseInt(match[1], 16)
	return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff]
}

function toHex([red, green, blue]: Rgb): string {
	return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, '0')}`
}

function mix(from: Rgb, to: Rgb, weight: number): Rgb {
	const at = (index: 0 | 1 | 2) => Math.round(from[index] + (to[index] - from[index]) * weight)
	return [at(0), at(1), at(2)]
}

function luminance([red, green, blue]: Rgb): number {
	const channel = (value: number) => {
		const ratio = value / 255
		return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function contrastRatio(left: Rgb, right: Rgb): number {
	const a = luminance(left)
	const b = luminance(right)
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function chroma([red, green, blue]: Rgb): number {
	return (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255
}

function hue(color: Rgb): number {
	const [red, green, blue] = color
	const span = chroma(color) * 255
	if (span === 0) {
		return 0
	}
	const max = Math.max(red, green, blue)
	const degrees =
		max === red
			? ((green - blue) / span) % 6
			: max === green
				? (blue - red) / span + 2
				: (red - green) / span + 4
	return (degrees * 60 + 360) % 360
}

function hueDistance(left: Rgb, right: Rgb): number {
	const delta = Math.abs(hue(left) - hue(right))
	return Math.min(delta, 360 - delta)
}

function keepsMeaning(base: Rgb, bright: Rgb): boolean {
	if (chroma(base) < GREY_CHROMA) {
		return true
	}
	return chroma(bright) >= GREY_CHROMA && hueDistance(base, bright) <= MAX_HUE_DRIFT
}

function ensureContrast(color: Rgb, background: Rgb, foreground: Rgb, minimum: number): Rgb {
	let candidate = color
	for (let weight = CONTRAST_STEP; weight <= 1; weight += CONTRAST_STEP) {
		if (contrastRatio(candidate, background) >= minimum) {
			return candidate
		}
		candidate = mix(color, foreground, weight)
	}
	return foreground
}

export function themeFromTerminal(colors: TerminalPaletteColors | null | undefined): Theme | null {
	const bg = parseHex(colors?.defaultBackground)
	const fg = parseHex(colors?.defaultForeground)
	if (bg === null || fg === null || contrastRatio(fg, bg) < MIN_BASE_CONTRAST) {
		return null
	}
	const builtIn = themes[luminance(bg) > 0.5 ? 'light' : 'dark']
	const blend = (weight: number) => mix(bg, fg, weight)
	// Bright slots (8-15) are usually the theme's prettier, more saturated take
	// on the base hue, so prefer them whenever they keep that hue and stay
	// readable; everything else falls back to the contrast-ranked pick, which
	// still shields against Solarized-style grey bright slots and bright
	// colors that wash out on light backgrounds.
	const semantic = (normalIndex: number, brightIndex: number, fallback: Rgb): string => {
		const normal = parseHex(colors?.palette[normalIndex])
		const bright = parseHex(colors?.palette[brightIndex])
		const brightKeepsMeaning = bright !== null && (normal === null || keepsMeaning(normal, bright))
		if (bright !== null && brightKeepsMeaning && contrastRatio(bright, bg) >= MIN_SEMANTIC_CONTRAST) {
			return toHex(bright)
		}
		const candidates =
			normal === null
				? bright === null
					? [fallback]
					: [bright]
				: brightKeepsMeaning && bright !== null
					? [normal, bright]
					: [normal]
		const [best = fallback] = candidates.sort(
			(left, right) => contrastRatio(right, bg) - contrastRatio(left, bg)
		)
		return toHex(ensureContrast(best, bg, fg, MIN_SEMANTIC_CONTRAST))
	}
	const builtInColor = (value: string): Rgb => parseHex(value) ?? fg
	return {
		accent: semantic(4, 12, builtInColor(builtIn.accent)),
		bad: semantic(1, 9, builtInColor(builtIn.bad)),
		bg: toHex(bg),
		border: toHex(blend(BLEND.border)),
		dim: toHex(ensureContrast(blend(BLEND.dim), bg, fg, MIN_DIM_CONTRAST)),
		faint: toHex(ensureContrast(blend(BLEND.faint), bg, fg, MIN_FAINT_CONTRAST)),
		fg: toHex(fg),
		good: semantic(2, 10, builtInColor(builtIn.good)),
		panel: toHex(blend(BLEND.panel)),
		selected: toHex(blend(BLEND.selected)),
		warn: semantic(3, 11, builtInColor(builtIn.warn))
	}
}

export function pressureColor(theme: Theme, usedPercent: number | null): string {
	if (usedPercent === null) {
		return theme.dim
	}
	if (usedPercent >= 85) {
		return theme.bad
	}
	if (usedPercent >= 60) {
		return theme.warn
	}
	return theme.good
}

export function meter(usedPercent: number | null, width = 14): string {
	if (usedPercent === null) {
		return '·'.repeat(width)
	}
	const filled = Math.round((clamp(usedPercent) / 100) * width)
	return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export function percentLabel(usedPercent: number | null): string {
	return usedPercent === null ? '  ?%' : `${Math.round(clamp(usedPercent))}%`.padStart(4)
}

export type { Timeframe } from '../domain.ts'
export { TIMEFRAMES } from '../domain.ts'

const brailleDots: readonly [number, number, number, number][] = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80]
]

export function brailleArea(
	columns: readonly (number | null)[],
	width: number,
	height: number,
	max = 100
): string[] {
	const dotRows = height * 4
	const dotCols = width * 2
	const scale = max <= 0 ? 1 : max
	const grid: boolean[][] = Array.from({ length: dotCols }, () => new Array(dotRows).fill(false))
	for (let x = 0; x < dotCols; x += 1) {
		const value = columns[x]
		if (value === null || value === undefined || value <= 0) {
			continue
		}
		const top = Math.max(1, Math.min(dotRows, Math.round((value / scale) * dotRows)))
		const column = grid[x]
		if (column === undefined) {
			continue
		}
		for (let y = 0; y < top; y += 1) {
			column[y] = true
		}
	}
	const rows: string[] = []
	for (let charRow = 0; charRow < height; charRow += 1) {
		const topDotY = dotRows - 1 - charRow * 4
		let line = ''
		for (let charColumn = 0; charColumn < width; charColumn += 1) {
			let bits = 0
			for (let subColumn = 0; subColumn < 2; subColumn += 1) {
				const gx = charColumn * 2 + subColumn
				for (let subRow = 0; subRow < 4; subRow += 1) {
					const gy = topDotY - subRow
					if (gy >= 0 && grid[gx]?.[gy]) {
						bits |= brailleDots[subColumn]?.[subRow] ?? 0
					}
				}
			}
			line += bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits)
		}
		rows.push(line)
	}
	return rows
}

export function shortReset(resetAtIso: string | null, nowMillis: number): string | null {
	if (resetAtIso === null) {
		return null
	}
	const resetMillis = Date.parse(resetAtIso)
	if (!Number.isFinite(resetMillis)) {
		return null
	}
	const remaining = resetMillis - nowMillis
	if (remaining <= 0) {
		return 'now'
	}
	const minutes = Math.round(remaining / 60_000)
	if (minutes < 60) {
		return `${minutes}m`
	}
	const hours = Math.round(minutes / 60)
	if (hours < 24) {
		return `${hours}h`
	}
	return `${Math.round(hours / 24)}d`
}

export function planTag(plan: string | null | undefined): string | null {
	const label = planLabel(plan)
	if (label === null) {
		return null
	}
	return label.toLowerCase().replace(/\s*×/g, '').replace(/\s+/g, '')
}

function planLabel(plan: string | null | undefined): string | null {
	if (plan === null || plan === undefined) {
		return null
	}
	const raw = plan.trim().toLowerCase()
	if (raw.length === 0) {
		return null
	}
	const multiplier = raw.match(/(\d+)\s*x/)
	if (raw.includes('max')) {
		return multiplier ? `Max ${multiplier[1]}×` : 'Max'
	}
	return raw
		.split(/[\s_-]+/)
		.filter(word => word.length > 0)
		.map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join(' ')
}

export function relativeAge(observedAtMillis: number, nowMillis: number): string {
	const seconds = Math.max(0, Math.round((nowMillis - observedAtMillis) / 1000))
	if (!Number.isFinite(seconds)) {
		return '?'
	}
	if (seconds < 60) {
		return `${seconds}s`
	}
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) {
		return `${minutes}m`
	}
	const hours = Math.floor(minutes / 60)
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

interface HealthBadge {
	text: string
	color: string
}

export function healthBadge(theme: Theme, account: Account): HealthBadge | null {
	switch (account.health) {
		case 'ready':
		case 'unchecked':
		case 'refreshDue':
		case 'refreshing':
			return null
		case 'loginExpiring':
			return { color: theme.warn, text: '⚠ expiring' }
		case 'scopeMissing':
			return { color: theme.warn, text: '⚠ scope' }
		case 'reauthenticationRequired':
			return { color: theme.bad, text: '⚠ login' }
		case 'temporarilyUnreachable':
			return { color: theme.warn, text: '· offline' }
		case 'usageRateLimited':
			return { color: theme.warn, text: '· limited' }
		case 'disabled':
			return { color: theme.dim, text: '· off' }
	}
}

export function shortWindow(label: string): string {
	if (/^(5 hour|5h session|five hour)$/i.test(label)) {
		return '5h'
	}
	if (/^7 day( · all models)?$/i.test(label)) {
		return '7d'
	}
	const generic = new Set(['day', 'days', 'hour', 'hours', 'week', 'all', 'models', 'window'])
	const tokens = label
		.replace(/^7 day · /i, '')
		.split(/[\s·-]+/)
		.filter(t => t.length > 1 && !generic.has(t.toLowerCase()) && !/^\d+(\.\d+)?$/.test(t))
	const chosen = tokens[tokens.length - 1] ?? label
	return chosen.length > 8 ? `${chosen.slice(0, 7)}…` : chosen
}

export function clamp(value: number): number {
	return Math.max(0, Math.min(100, value))
}

export function throughputColumns(buckets: readonly number[], columns: number): number[] {
	const count = buckets.length
	const result = new Array<number>(Math.max(0, columns)).fill(0)
	if (count === 0 || columns <= 0) {
		return result
	}
	for (let column = 0; column < columns; column += 1) {
		const lo = Math.floor((column / columns) * count)
		const hi = Math.max(lo + 1, Math.floor(((column + 1) / columns) * count))
		let peak = 0
		for (let index = lo; index < hi && index < count; index += 1) {
			peak = Math.max(peak, buckets[index] ?? 0)
		}
		result[column] = peak
	}
	return result
}

export function compactNumber(value: number): string {
	const abs = Math.abs(value)
	if (abs >= 1_000_000_000) {
		return `${(value / 1_000_000_000).toFixed(1)}B`
	}
	if (abs >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`
	}
	if (abs >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`
	}
	return `${Math.round(value)}`
}

export function moneyUsd(value: number): string {
	return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}
