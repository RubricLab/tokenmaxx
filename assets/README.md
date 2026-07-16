# tokenmaxx assets

Every image and video in the docs is generated from source — no hand-editing.
The real tokenmaxx TUI is rendered against **synthetic fixtures** with a **pinned
clock**, so frames are deterministic and need no daemon, network, or real
accounts.

## How it works

```
src/tui/fixtures.ts     fabricates schema-valid AnalyticsSnapshots (scenarios)
        │
        ▼
tokenmaxx --fixture <name>  the real TUI renders that snapshot (hidden seam,
        │                pinned by TOKENMAXX_NOW / TOKENMAXX_THEME / TZ)
        ▼
assets/assets.config.ts  the shot list: scenario × view × theme × size
        │
        ▼
assets/render.ts         drives VHS to frame each shot (macOS window chrome)
        ▼
assets/generated/*.png   committed build products the README embeds
```

## Regenerate

```bash
bun run assets            # all screenshots, dark + light
bun run assets:screens accounts analytics   # only matching shots
```

Requirements (macOS):

```bash
brew install vhs gifski
brew install --cask font-jetbrains-mono-nerd-font   # braille + block + symbol glyphs
```

## Iterating

- **Change what a shot shows** → edit the scenario in `../src/tui/fixtures.ts`
  (or add a new one) and/or the shot's `keys`/`height` in `assets.config.ts`.
- **Add a shot** → append to `SHOTS` in `assets.config.ts`, re-run.
- **Preview one live** without rendering:

  ```bash
  TOKENMAXX_FIXTURE=oneHot TOKENMAXX_THEME=dark TZ=America/Los_Angeles \
    bun run src/index.ts        # press ←/→, space, 1–5 to explore
  ```

## Layout

| Path | Role |
|---|---|
| `assets.config.ts` | shot list + render constants (source of truth) |
| `render.ts` | VHS driver (screenshots) |
| `generated/` | committed PNGs the README embeds + `manifest.json` |
| `tapes/`, `.tmp/` | regenerated intermediates (gitignored) |

Scenarios live in `../src/tui/fixtures.ts`: `cruising`, `oneHot`, `rotated`,
`onboarding`.
