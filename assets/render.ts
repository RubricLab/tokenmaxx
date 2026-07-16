#!/usr/bin/env bun
// Renders every Shot in assets.config.ts to a framed PNG (dark + light) by
// driving the real tokenmaxx TUI through the fixture seam with VHS. Deterministic:
// no daemon, no network, a pinned clock. Re-run any time; images are build
// products under generated/.
//
//   bun run assets/render.ts            # all shots, both themes
//   bun run assets/render.ts accounts   # only shots whose name matches an arg

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_NOW } from '../src/tui/fixtures.ts'
import {
	FIXTURE_TZ,
	FONT,
	FONT_SIZE,
	MARGIN_FILL,
	SHOTS,
	type Shot,
	THEMES,
	type ThemeName,
	WIDTH
} from './assets.config.ts'

const assetsDir = import.meta.dir
const repo = join(assetsDir, '..')
const outDir = join(assetsDir, 'generated')
const tapeDir = join(assetsDir, 'tapes')
const tmpDir = join(assetsDir, '.tmp')
for (const dir of [outDir, tapeDir, tmpDir]) {
	mkdirSync(dir, { recursive: true })
}

const bun = process.execPath
const vhs = existsSync('/opt/homebrew/bin/vhs') ? '/opt/homebrew/bin/vhs' : 'vhs'
const entry = join(repo, 'src/index.ts')

function tape(shot: Shot, theme: ThemeName, pngPath: string, gifPath: string): string {
	const installed = shot.installed === false ? 'false' : 'true'
	const keyLines = (shot.keys ?? []).flatMap(key => [key, 'Sleep 900ms'])
	return [
		`Output "${gifPath}"`,
		`Set FontFamily "${FONT}"`,
		`Set FontSize ${FONT_SIZE}`,
		'Set LetterSpacing 0',
		`Set Width ${WIDTH}`,
		`Set Height ${shot.height}`,
		'Set Padding 24',
		'Set Margin 50',
		`Set MarginFill "${MARGIN_FILL[theme]}"`,
		'Set WindowBar Colorful',
		'Set WindowBarSize 40',
		'Set BorderRadius 12',
		'Set TypingSpeed 1ms',
		`Env TOKENMAXX_FIXTURE "${shot.scenario}"`,
		`Env TOKENMAXX_THEME "${theme}"`,
		`Env TOKENMAXX_NOW "${FIXTURE_NOW}"`,
		`Env TOKENMAXX_INSTALLED "${installed}"`,
		`Env TZ "${FIXTURE_TZ}"`,
		`Type "${bun} run ${entry}"`,
		'Enter',
		'Sleep 6s',
		...keyLines,
		`Screenshot "${pngPath}"`,
		''
	].join('\n')
}

const filter = process.argv.slice(2)
const wanted = (shot: Shot) => filter.length === 0 || filter.some(f => shot.name.includes(f))

let ok = 0
const failed: string[] = []
for (const theme of THEMES) {
	for (const shot of SHOTS) {
		if (!wanted(shot)) {
			continue
		}
		const base = `${shot.name}-${theme}`
		const png = join(outDir, `${base}.png`)
		const gif = join(tmpDir, `${base}.gif`)
		const tapePath = join(tapeDir, `${base}.tape`)
		writeFileSync(tapePath, tape(shot, theme, png, gif))
		rmSync(png, { force: true })
		// VHS is occasionally flaky when spawned in quick succession (its browser +
		// ttyd backend races); verify the frame landed and retry a few times, with a
		// short settle between attempts, before giving up.
		let landed = false
		for (let attempt = 1; attempt <= 4 && !landed; attempt += 1) {
			spawnSync(vhs, [tapePath], { stdio: 'ignore' })
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
}

writeFileSync(
	join(outDir, 'manifest.json'),
	`${JSON.stringify(
		SHOTS.map(shot => ({ caption: shot.caption, name: shot.name })),
		null,
		2
	)}\n`
)

console.log(
	`\n${ok} rendered, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`
)
process.exitCode = failed.length > 0 ? 1 : 0
