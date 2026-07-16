import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Frame, Wordmark } from "./Frame";
import { MONO, pressure, type Theme, type ThemeName, themes } from "./theme";

const ROW_H = 68;
const SWITCH = 102; // frame the rotation commits

const Meter: React.FC<{ theme: Theme; percent: number; width: number }> = ({
  theme,
  percent,
  width,
}) => {
  const color = pressure(theme, percent);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width, height: 14, borderRadius: 4, background: theme.selected, overflow: "hidden" }}>
        <div style={{ width: `${percent}%`, height: "100%", background: color, borderRadius: 4 }} />
      </div>
      <span style={{ color, fontWeight: 700, fontSize: 20, width: 58 }}>{Math.round(percent)}%</span>
    </div>
  );
};

const Row: React.FC<{
  theme: Theme;
  email: string;
  active: boolean;
  percent: number;
}> = ({ theme, email, active, percent }) => (
  <div style={{ display: "flex", alignItems: "center", height: ROW_H, padding: "0 20px", gap: 18 }}>
    <span style={{ color: active ? theme.good : theme.faint, fontSize: 22, width: 18 }}>
      {active ? "●" : "○"}
    </span>
    <span
      style={{
        color: active ? theme.fg : theme.dim,
        fontWeight: active ? 700 : 400,
        fontSize: 21,
        width: 300,
      }}
    >
      {email}
    </span>
    <span style={{ color: theme.dim, fontSize: 18 }}>5h</span>
    <Meter theme={theme} percent={percent} width={300} />
  </div>
);

export const SwitchRotation: React.FC<{ themeName: ThemeName }> = ({ themeName }) => {
  const theme = themes[themeName];
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // dexter climbs to the limit, then rotation hands off to the cool standby.
  const dexterPct = interpolate(frame, [0, SWITCH], [72, 97], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shipPct = 21;
  const switched = frame >= SWITCH;

  // The active highlight slides from row 0 to row 1 on the switch.
  const slide = spring({ frame: frame - SWITCH, fps, config: { damping: 16, mass: 0.7 } });
  const highlightTop = interpolate(slide, [0, 1], [0, ROW_H]);

  const rotating = interpolate(frame, [SWITCH - 8, SWITCH, SWITCH + 26, SWITCH + 40], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const done = interpolate(frame, [SWITCH + 26, SWITCH + 44], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const generation = switched ? 8 : 7;

  return (
    <Frame theme={theme} title="tokenmaxx">
      <div style={{ color: theme.fg }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
          <span style={{ color: theme.good, fontSize: 19 }}>OpenAI · Codex</span>
          <span style={{ color: theme.dim, fontSize: 18, marginLeft: 16 }}>
            ⟳ auto-rotate 95% · gen {generation}
          </span>
          <div style={{ flex: 1 }} />
          <Wordmark theme={theme} />
        </div>

        <div
          style={{
            position: "relative",
            border: `1px solid ${theme.border}`,
            borderRadius: 12,
            padding: "10px 0",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 10 + highlightTop,
              left: 8,
              right: 8,
              height: ROW_H,
              background: theme.selected,
              borderRadius: 8,
            }}
          />
          <div style={{ position: "relative" }}>
            <Row theme={theme} email="dexter@rubriclabs.com" active={!switched} percent={dexterPct} />
            <Row theme={theme} email="ship@rubriclabs.com" active={switched} percent={shipPct} />
          </div>
        </div>

        <div style={{ height: 70, marginTop: 26, fontFamily: MONO, fontSize: 20 }}>
          <div style={{ opacity: rotating, color: theme.warn }}>
            ⟳ dexter@ hit 96% on its 5-hour window — rotating…
          </div>
          <div style={{ opacity: done, color: theme.good, marginTop: rotating > 0 ? -28 : 0 }}>
            ✓ switched to ship@rubriclabs.com · the next request uses it, mid-turn · gen 8
          </div>
        </div>
      </div>
    </Frame>
  );
};
