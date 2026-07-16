// The tokenmaxx palette, mirrored from src/tui/format.ts so the videos read as the
// same product as the screenshots.

export interface Theme {
  fg: string;
  dim: string;
  faint: string;
  accent: string;
  bg: string;
  panel: string;
  selected: string;
  border: string;
  good: string;
  warn: string;
  bad: string;
  desktop: string; // the surface the window sits on
}

export const dark: Theme = {
  fg: "#e6e6e6",
  dim: "#8b93a1",
  faint: "#4b515c",
  accent: "#5ab0ff",
  bg: "#0b0d10",
  panel: "#0f1216",
  selected: "#1b2330",
  border: "#2a3038",
  good: "#3ad07a",
  warn: "#f0a83a",
  bad: "#ff5f6e",
  desktop: "#05070a",
};

export const light: Theme = {
  fg: "#1c2430",
  dim: "#5a6472",
  faint: "#aab2bd",
  accent: "#0b62d6",
  bg: "#fbfcfe",
  panel: "#f2f4f8",
  selected: "#e3e9f2",
  border: "#c7cedb",
  good: "#1f9d57",
  warn: "#b9770f",
  bad: "#d23b48",
  desktop: "#dfe4ec",
};

export const themes = { dark, light } as const;
export type ThemeName = keyof typeof themes;

// Usage-pressure colour, matching pressureColor() in the TUI.
export function pressure(theme: Theme, percent: number): string {
  if (percent >= 85) {
    return theme.bad;
  }
  if (percent >= 60) {
    return theme.warn;
  }
  return theme.good;
}

export const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";
