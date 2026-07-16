#!/usr/bin/env bun
// Renders the flagship composite (dark + light): the real tokenmaxx dashboard beside
// mock Claude Code and Codex sessions, arranged in a tmux layout and framed by
// VHS. The layout is built by flagship/build.sh; the sessions are the static
// mock-claude.sh / mock-codex.sh (modelled on the real TUIs). Deterministic.
//
//   bun run assets/flagship.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_NOW } from '../src/tui/fixtures.ts'
import { FONT, FONT_SIZE, MARGIN_FILL, THEMES, type ThemeName } from './assets.config.ts'

const assetsDir = import.meta.dir
const outDir = join(assetsDir, 'generated')
const tapeDir = join(assetsDir, 'tapes')
const tmpDir = join(assetsDir, '.tmp')
for (const dir of [outDir, tapeDir, tmpDir]) {
	mkdirSync(dir, { recursive: true })
}

const vhs = existsSync('/opt/homebrew/bin/vhs') ? '/opt/homebrew/bin/vhs' : 'vhs'
const buildScript = join(assetsDir, 'flagship', 'build.sh')

// The whole terminal background must match the tokenmaxx theme, otherwise the mock
// panes (which don't paint their own background) show VHS's default and their
// theme-coloured text vanishes. Single-pane shots don't need this — tokenmaxx fills
// the frame — but the flagship's mock panes do.
const TERM_BG: Record<ThemeName, string> = { dark: '#0b0d10', light: '#fbfcfe' }
const TERM_FG: Record<ThemeName, string> = { dark: '#e6e6e6', light: '#1c2430' }

function tape(theme: ThemeName, png: string, gif: string): string {
	return [
		`Output "${gif}"`,
		`Set Theme '{ "background": "${TERM_BG[theme]}", "foreground": "${TERM_FG[theme]}" }'`,
		`Set FontFamily "${FONT}"`,
		`Set FontSize ${FONT_SIZE - 1}`,
		'Set LetterSpacing 0',
		'Set Width 1560',
		'Set Height 860',
		'Set Padding 22',
		'Set Margin 46',
		`Set MarginFill "${MARGIN_FILL[theme]}"`,
		'Set WindowBar Colorful',
		'Set WindowBarSize 40',
		'Set BorderRadius 12',
		'Set TypingSpeed 1ms',
		`Env TOKENMAXX_NOW "${FIXTURE_NOW}"`,
		`Type "THEME=${theme} bash ${buildScript}"`,
		'Enter',
		'Sleep 9s',
		`Screenshot "${png}"`,
		''
	].join('\n')
}

let ok = 0
const failed: string[] = []
for (const theme of THEMES) {
	const base = `flagship-${theme}`
	const png = join(outDir, `${base}.png`)
	const gif = join(tmpDir, `${base}.gif`)
	const tapePath = join(tapeDir, `${base}.tape`)
	writeFileSync(tapePath, tape(theme, png, gif))
	spawnSync('rm', ['-f', png])
	let landed = false
	for (let attempt = 1; attempt <= 4 && !landed; attempt += 1) {
		spawnSync(vhs, [tapePath], { stdio: 'ignore' })
		// build.sh runs tmux inside VHS's own shell, but kill any stray session too.
		spawnSync('tmux', ['kill-session', '-t', 'fs'], { stdio: 'ignore' })
		landed = existsSync(png)
		if (!landed) {
			Bun.sleepSync(1500)
		}
	}
	if (landed) {
		ok += 1
		console.log(`  ok    ${base}.png`)
	} else {
		failed.push(base)
		console.log(`  FAIL  ${base}.png`)
	}
}

console.log(
	`\n${ok} rendered, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`
)
process.exitCode = failed.length > 0 ? 1 : 0
