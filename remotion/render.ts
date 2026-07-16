#!/usr/bin/env node
// Renders each composition in both themes to an mp4, then converts to a
// high-quality gif (ffmpeg two-pass palette) into ../assets/generated/.
//
//   cd remotion && node render.ts        # (or: npm run render)

const { spawnSync } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");

const here = __dirname;
const outDir = join(here, "out");
const gifDir = join(here, "..", "assets", "generated");
mkdirSync(outDir, { recursive: true });
mkdirSync(gifDir, { recursive: true });

const ffmpeg = "/opt/homebrew/bin/ffmpeg";
const GIF_WIDTH = 960;
const GIF_FPS = 24;

// [composition id, output gif basename]
const comps = [
  ["UsageTimelapse", "timelapse"],
  ["SwitchRotation", "switch"],
];
const themes = ["dark", "light"];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd: cwd || here, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`${cmd} exited ${r.status}`);
  }
}

for (const [id, base] of comps) {
  for (const theme of themes) {
    const mp4 = join(outDir, `${base}-${theme}.mp4`);
    console.log(`\n▶ ${id} (${theme}) → ${mp4}`);
    run("npx", [
      "remotion",
      "render",
      "src/index.ts",
      id,
      mp4,
      `--props={"themeName":"${theme}"}`,
      "--log=error",
      "--overwrite",
    ]);

    const gif = join(gifDir, `${base}-${theme}.gif`);
    const palette = join(outDir, `${base}-${theme}-palette.png`);
    const filters = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
    console.log(`  → gif ${gif}`);
    run(ffmpeg, ["-y", "-i", mp4, "-vf", `${filters},palettegen=stats_mode=diff`, palette]);
    run(ffmpeg, [
      "-y",
      "-i",
      mp4,
      "-i",
      palette,
      "-lavfi",
      `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
      gif,
    ]);
  }
}

console.log("\n✓ videos + gifs written to assets/generated/");
