import type React from "react";
import { AbsoluteFill } from "remotion";
import { MONO, type Theme } from "./theme";

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <div style={{ width: 13, height: 13, borderRadius: 7, background: color }} />
);

// A macOS-style window on a desktop surface, matching the screenshots' chrome so
// the videos read as the same product.
export const Frame: React.FC<{
  theme: Theme;
  title?: string;
  children: React.ReactNode;
}> = ({ theme, title, children }) => (
  <AbsoluteFill
    style={{
      background: theme.desktop,
      justifyContent: "center",
      alignItems: "center",
      fontFamily: MONO,
    }}
  >
    <div
      style={{
        width: 1120,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 40px 90px rgba(0,0,0,0.45)",
        background: theme.bg,
        border: `1px solid ${theme.border}`,
      }}
    >
      <div
        style={{
          height: 44,
          background: theme.panel,
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          gap: 9,
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <Dot color="#ff5f57" />
        <Dot color="#febc2e" />
        <Dot color="#28c840" />
        {title ? (
          <span style={{ marginLeft: 14, color: theme.dim, fontSize: 16 }}>{title}</span>
        ) : null}
      </div>
      <div style={{ padding: "34px 40px" }}>{children}</div>
    </div>
  </AbsoluteFill>
);

// The tokenmaxx wordmark, used as a small brand mark in the corner of each video.
export const Wordmark: React.FC<{ theme: Theme; size?: number }> = ({ theme, size = 20 }) => (
  <span style={{ fontWeight: 700, fontSize: size, color: theme.accent, letterSpacing: 0.5 }}>
    tokenmaxx
  </span>
);
