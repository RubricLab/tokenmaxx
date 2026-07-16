import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Frame, Wordmark } from "./Frame";
import { MONO, pressure, type ThemeName, themes } from "./theme";

// A synthetic 5-hour-sawtooth-over-24h usage series — the same shape the TUI
// charts, generated deterministically here so the video needs no runtime data.
function series(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const cyclePos = (t * 4.8) % 1; // ~4.8 five-hour cycles across the day
    const ramp = Math.min(1, cyclePos / 0.9);
    const peak = 62 + 30 * t; // the day trends busier
    const wobble = 3 * Math.sin(i * 1.7);
    out.push(Math.max(0, Math.min(100, peak * ramp + wobble)));
  }
  return out;
}

const N = 220;
const DATA = series(N);

const CHART = { w: 1040, h: 300, x: 0, y: 0 };

function path(values: number[], upto: number): string {
  const pts = values.slice(0, Math.max(2, upto));
  return pts
    .map((v, i) => {
      const x = (i / (N - 1)) * CHART.w;
      const y = CHART.h - (v / 100) * CHART.h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

const Pill: React.FC<{ label: string; active: boolean; theme: (typeof themes)[ThemeName] }> = ({
  label,
  active,
  theme,
}) => (
  <span
    style={{
      padding: "3px 10px",
      borderRadius: 6,
      fontSize: 16,
      color: active ? theme.bg : theme.dim,
      background: active ? theme.accent : "transparent",
      fontWeight: active ? 700 : 400,
    }}
  >
    {label}
  </span>
);

export const UsageTimelapse: React.FC<{ themeName: ThemeName }> = ({ themeName }) => {
  const theme = themes[themeName];
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Ease the reveal, hold full at the end.
  const reveal = interpolate(frame, [8, durationInFrames - 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const frontier = Math.max(1, Math.floor(reveal * (N - 1)));
  const now = DATA[frontier] ?? 0;
  const shown = DATA.slice(0, frontier + 1);
  const peak = Math.max(...shown);
  const avg = shown.reduce((s, v) => s + v, 0) / shown.length;
  const color = pressure(theme, now);
  const frontierX = (frontier / (N - 1)) * CHART.w;
  const frontierY = CHART.h - (now / 100) * CHART.h;

  return (
    <Frame theme={theme} title="tokenmaxx — analytics">
      <div style={{ color: theme.fg, fontSize: 18 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
          <span style={{ color: theme.dim }}>
            Codex · <span style={{ color: theme.fg }}>dexter@rubriclabs.com</span> ·{" "}
            <span style={{ color: theme.accent, fontWeight: 700 }}>Pro</span>
          </span>
          <div style={{ flex: 1 }} />
          {["1h", "5h", "24h", "7d", "31d"].map((l) => (
            <Pill key={l} label={l} active={l === "24h"} theme={theme} />
          ))}
        </div>

        <div style={{ position: "relative", height: CHART.h, marginTop: 6 }}>
          <span style={{ position: "absolute", left: -34, top: -8, color: theme.faint, fontSize: 14 }}>
            100
          </span>
          <span style={{ position: "absolute", left: -20, bottom: -8, color: theme.faint, fontSize: 14 }}>
            0
          </span>
          <svg width={CHART.w} height={CHART.h} style={{ overflow: "visible" }}>
            <title>usage over 24 hours</title>
            {[0.25, 0.5, 0.75].map((g) => (
              <line
                key={g}
                x1={0}
                x2={CHART.w}
                y1={CHART.h * g}
                y2={CHART.h * g}
                stroke={theme.border}
                strokeWidth={1}
                strokeDasharray="2 6"
              />
            ))}
            <defs>
              <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {shown.length > 2 ? (
              <>
                <path
                  d={`${path(DATA, frontier + 1)} L${frontierX},${CHART.h} L0,${CHART.h} Z`}
                  fill="url(#fill)"
                />
                <path
                  d={path(DATA, frontier + 1)}
                  fill="none"
                  stroke={color}
                  strokeWidth={3}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle cx={frontierX} cy={frontierY} r={6} fill={color} />
                <circle cx={frontierX} cy={frontierY} r={12} fill={color} opacity={0.25} />
              </>
            ) : null}
          </svg>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 26, fontFamily: MONO }}>
          <div style={{ fontSize: 20 }}>
            <span style={{ color: theme.dim }}>now </span>
            <span style={{ color, fontWeight: 700 }}>{Math.round(now)}%</span>
            <span style={{ color: theme.faint }}> · peak {Math.round(peak)}% · avg {Math.round(avg)}%</span>
          </div>
          <Wordmark theme={theme} />
        </div>
      </div>
    </Frame>
  );
};
