// The single source of truth for every generated screenshot. Each Shot renders
// the real tokenmaxx TUI through the hidden fixture seam (src/tui/fixtures.ts) at a
// pinned clock, then frames it with VHS (macOS window chrome + shadowless dark
// backdrop). Edit this list — never the images — and re-run `bun run
// assets:screens`.

export type ThemeName = 'dark' | 'light'
export const THEMES: readonly ThemeName[] = ['dark', 'light']

// Rendering constants shared by every frame. JetBrainsMono Nerd Font is required
// (brew install --cask font-jetbrains-mono-nerd-font) — it carries the braille,
// block, and symbol glyphs the TUI draws. LetterSpacing 0 keeps text tight.
export const FONT = 'JetBrainsMono Nerd Font'
export const FONT_SIZE = 15
export const WIDTH = 1200

// The desktop the framed window sits on: near-black for dark, soft grey for
// light, so the window edge always reads.
export const MARGIN_FILL: Record<ThemeName, string> = {
	dark: '#0b0d10',
	light: '#e6ebf2'
}

// Pins the header clock. FIXTURE_NOW (see src/tui/fixtures.ts) reads as a clean
// 9:42 AM in Pacific, so every frame shows the same time.
export const FIXTURE_TZ = 'America/Los_Angeles'

export interface Shot {
	// Output basename: generated/<name>-<theme>.png
	name: string
	// Fixture scenario from src/tui/fixtures.ts.
	scenario: string
	// Canvas height in pixels (width is fixed). Tune per view so the content fills
	// the frame without a tall empty gap.
	height: number
	// Keys sent after first paint to reach a view (e.g. ["Right"] → Analytics,
	// ["Space"] → expand the selected account). Each key waits for a repaint.
	keys?: string[]
	// false shows the "native routing is off" banner (onboarding).
	installed?: boolean
	// One-line caption for the docs manifest; not rendered into the frame.
	caption: string
}

export const SHOTS: readonly Shot[] = [
	{
		caption: 'Every account and its live rate-limit windows, at a glance.',
		height: 560,
		name: 'accounts',
		scenario: 'cruising'
	},
	{
		caption: 'The active Codex account is nearly out — auto-rotate is about to fire.',
		height: 560,
		name: 'hot',
		scenario: 'oneHot'
	},
	{
		caption: 'Press space: plan tier, per-window reset countdowns, account id.',
		height: 720,
		keys: ['Space'],
		name: 'expanded',
		scenario: 'cruising'
	},
	{
		caption: 'Combined token throughput across all accounts and both providers.',
		height: 720,
		keys: ['Tab'],
		name: 'analytics',
		scenario: 'cruising'
	},
	{
		caption: 'Total tokens and ≈ API value over the timeframe.',
		height: 720,
		keys: ['Tab', 'Right'],
		name: 'analytics-week',
		scenario: 'oneHot'
	},
	{
		caption: 'A fresh install: sign in, then route native codex & claude.',
		height: 470,
		installed: false,
		name: 'onboarding',
		scenario: 'onboarding'
	}
]
