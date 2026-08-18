import { describe, expect, test } from 'bun:test'
import {
	detectThemeName,
	type TerminalPaletteColors,
	themeFromTerminal,
	themeOverride,
	themes
} from './format.ts'

const gruvboxDark: TerminalPaletteColors = {
	defaultBackground: '#282828',
	defaultForeground: '#ebdbb2',
	palette: [
		'#282828',
		'#cc241d',
		'#98971a',
		'#d79921',
		'#458588',
		'#b16286',
		'#689d6a',
		'#a89984',
		'#928374',
		'#fb4934',
		'#b8bb26',
		'#fabd2f',
		'#83a598',
		'#d3869b',
		'#8ec07c',
		'#ebdbb2'
	]
}

const solarizedLight: TerminalPaletteColors = {
	defaultBackground: '#fdf6e3',
	defaultForeground: '#657b83',
	palette: [
		'#073642',
		'#dc322f',
		'#859900',
		'#b58900',
		'#268bd2',
		'#d33682',
		'#2aa198',
		'#eee8d5',
		'#002b36',
		'#cb4b16',
		'#586e75',
		'#657b83',
		'#839496',
		'#6c71c4',
		'#93a1a1',
		'#fdf6e3'
	]
}

const hex = /^#[0-9a-f]{6}$/

function channel(value: number): number {
	const ratio = value / 255
	return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
}

function contrast(left: string, right: string): number {
	const luminance = (color: string) => {
		const packed = Number.parseInt(color.slice(1), 16)
		return (
			0.2126 * channel((packed >> 16) & 0xff) +
			0.7152 * channel((packed >> 8) & 0xff) +
			0.0722 * channel(packed & 0xff)
		)
	}
	const a = luminance(left)
	const b = luminance(right)
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('themeOverride', () => {
	test('is absent when the variable is unset, so the stored preference wins', () => {
		expect(themeOverride({})).toBeNull()
	})

	test('honors an explicit override regardless of case or padding', () => {
		expect(themeOverride({ TOKENMAXX_THEME: '  LIGHT ' })).toBe('light')
		expect(themeOverride({ TOKENMAXX_THEME: 'dark' })).toBe('dark')
		expect(themeOverride({ TOKENMAXX_THEME: 'auto' })).toBe('auto')
	})

	test('ignores unknown values instead of pinning something arbitrary', () => {
		expect(themeOverride({ TOKENMAXX_THEME: 'gruvbox' })).toBeNull()
		expect(themeOverride({ TOKENMAXX_THEME: '' })).toBeNull()
	})
})

describe('detectThemeName', () => {
	test('reads the background slot of COLORFGBG', () => {
		expect(detectThemeName({ COLORFGBG: '0;15' })).toBe('light')
		expect(detectThemeName({ COLORFGBG: '15;0' })).toBe('dark')
	})

	test('defaults to dark when unset or unparseable', () => {
		expect(detectThemeName({})).toBe('dark')
		expect(detectThemeName({ COLORFGBG: 'default;default' })).toBe('dark')
	})

	test('no longer consumes the theme override', () => {
		expect(detectThemeName({ TOKENMAXX_THEME: 'light' })).toBe('dark')
	})
})

describe('themeFromTerminal', () => {
	test('adopts the terminal background and foreground verbatim', () => {
		const theme = themeFromTerminal(gruvboxDark)
		expect(theme?.bg).toBe('#282828')
		expect(theme?.fg).toBe('#ebdbb2')
	})

	test('maps semantic slots to the terminal palette', () => {
		const theme = themeFromTerminal(gruvboxDark)
		expect(theme?.bad).toBe('#fb4934')
		expect(theme?.good).toBe('#b8bb26')
		expect(theme?.warn).toBe('#fabd2f')
		expect(theme?.accent).toBe('#83a598')
	})

	test('prefers the bright slot when it keeps the hue and stays readable', () => {
		const theme = themeFromTerminal(solarizedLight)
		// Bright red (#cb4b16) holds the hue and clears the floor, so it wins;
		// the bright green slot is one of Solarized's greys, so good keeps the
		// normal slot instead of turning grey.
		expect(theme?.bad).toBe('#cb4b16')
		expect(theme?.good).toBe('#859900')
	})

	test('produces every field as a six digit hex string', () => {
		for (const colors of [gruvboxDark, solarizedLight]) {
			const theme = themeFromTerminal(colors)
			expect(theme).not.toBeNull()
			for (const value of Object.values(theme ?? {})) {
				expect(value).toMatch(hex)
			}
		}
	})

	test('keeps derived text colors above the contrast floor', () => {
		for (const colors of [gruvboxDark, solarizedLight]) {
			const theme = themeFromTerminal(colors)
			expect(theme).not.toBeNull()
			if (theme === null) {
				continue
			}
			expect(contrast(theme.dim, theme.bg)).toBeGreaterThanOrEqual(3.5)
			expect(contrast(theme.faint, theme.bg)).toBeGreaterThanOrEqual(2.2)
			for (const key of ['accent', 'bad', 'good', 'warn'] as const) {
				expect(contrast(theme[key], theme.bg)).toBeGreaterThanOrEqual(2.6)
			}
		}
	})

	test('lifts a washed out palette entry until it is readable', () => {
		const theme = themeFromTerminal({
			...gruvboxDark,
			palette: gruvboxDark.palette.map((entry, index) =>
				index === 2 || index === 10 ? '#2b2b2b' : entry
			)
		})
		expect(theme?.good).not.toBe('#2b2b2b')
		expect(contrast(theme?.good ?? '#000000', '#282828')).toBeGreaterThanOrEqual(2.6)
	})

	test('falls back to the built-in palette when a slot is missing', () => {
		const theme = themeFromTerminal({
			...gruvboxDark,
			palette: gruvboxDark.palette.map((entry, index) => (index === 4 || index === 12 ? null : entry))
		})
		expect(theme?.accent).toBe(themes.dark.accent)
	})

	test('returns null when the terminal did not answer', () => {
		expect(themeFromTerminal(null)).toBeNull()
		expect(
			themeFromTerminal({
				defaultBackground: null,
				defaultForeground: null,
				palette: Array(16).fill(null)
			})
		).toBeNull()
	})

	test('returns null when foreground and background are too close to read', () => {
		expect(themeFromTerminal({ ...gruvboxDark, defaultForeground: '#303030' })).toBeNull()
	})
})
