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

export const darkTheme: Theme = {
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

export const lightTheme: Theme = {
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

export function detectThemeName(environment: NodeJS.ProcessEnv): ThemeName {
	const override = (environment.TOKENMAXX_THEME ?? environment.TOKMAX_THEME)?.toLowerCase()
	if (override === 'light' || override === 'dark') {
		return override
	}
	const colorFgBg = environment.COLORFGBG
	if (colorFgBg !== undefined) {
		const background = Number(colorFgBg.split(';').pop())
		if (Number.isFinite(background)) {
			return background >= 7 ? 'light' : 'dark'
		}
	}
	return 'dark'
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
	[0x01, 0x02, 0x04, 0x40], // left column, rows top→bottom
	[0x08, 0x10, 0x20, 0x80] // right column
]

export function brailleLine(
	columns: readonly (number | null)[],
	width: number,
	height: number,
	max = 100
): string[] {
	const dotRows = height * 4
	const dotCols = width * 2
	const scale = max <= 0 ? 1 : max
	const grid: boolean[][] = Array.from({ length: dotCols }, () => new Array(dotRows).fill(false))
	const toY = (value: number): number =>
		Math.max(0, Math.min(dotRows - 1, Math.round((value / scale) * (dotRows - 1))))
	let previousY = -1
	for (let x = 0; x < dotCols; x += 1) {
		const value = columns[x]
		if (value === null || value === undefined) {
			previousY = -1
			continue
		}
		const y = toY(value)
		const column = grid[x]
		if (column === undefined) {
			continue
		}
		if (previousY >= 0) {
			for (let fill = Math.min(previousY, y); fill <= Math.max(previousY, y); fill += 1) {
				column[fill] = true
			}
		} else {
			column[y] = true
		}
		previousY = y
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

export function resetCountdown(resetAtIso: string | null, nowMillis: number): string | null {
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
	const hours = Math.floor(minutes / 60)
	const remainderMinutes = minutes % 60
	if (hours < 24) {
		return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`
	}
	const days = Math.floor(hours / 24)
	const remainderHours = hours % 24
	return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`
}

export function planLabel(plan: string | null | undefined): string | null {
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

export interface HealthBadge {
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

export function compactUsd(value: number): string {
	if (value >= 1000) {
		return `$${(value / 1000).toFixed(1)}k`
	}
	return `$${value.toFixed(2)}`
}
