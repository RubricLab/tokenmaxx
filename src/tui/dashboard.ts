import { Box, createCliRenderer, parseColor, type RGBA, Text } from "@opentui/core";
import type {
  Account,
  AnalyticsSnapshot,
  DashboardSnapshot,
  ProviderId,
  ProviderState,
  TokenTimeframe,
  UsageWindow,
} from "../domain.ts";
import { readAnalytics, refreshUsage, requestPolicy, requestSwitch } from "../ipc.ts";
import {
  brailleLine,
  compactNumber,
  compactUsd,
  detectThemeName,
  healthBadge,
  meter,
  percentLabel,
  planLabel,
  pressureColor,
  relativeAge,
  resetCountdown,
  shortWindow,
  type Theme,
  type ThemeName,
  TIMEFRAMES,
  type Timeframe,
  themes,
  throughputColumns,
} from "./format.ts";

type Tab = "accounts" | "analytics";

const colorCache = new Map<string, RGBA>();
function rgb(hex: string): RGBA {
  const cached = colorCache.get(hex);
  if (cached !== undefined) {
    return cached;
  }
  const value = parseColor(hex);
  colorCache.set(hex, value);
  return value;
}

const labelWidth = 24;
const providerTitles: Record<ProviderId, string> = {
  openai: "OpenAI · Codex",
  anthropic: "Anthropic · Claude Code",
};
const providerShort: Record<ProviderId, string> = { openai: "Codex", anthropic: "Claude Code" };
const providerCli: Record<ProviderId, string> = { openai: "codex", anthropic: "claude" };
const providerOrder: readonly ProviderId[] = ["openai", "anthropic"];
const fallbackTimeframe = TIMEFRAMES[2] as Timeframe;

interface Row {
  provider: ProviderId;
  accountId: string;
}

interface Ctx {
  theme: Theme;
  now: number;
}

function pad(value: string, width: number): string {
  const fitted = value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
  return fitted.padEnd(width);
}

function hardWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows.filter((window) => window.kind === "hard");
}

function orderedRows(snapshot: DashboardSnapshot): Row[] {
  const rows: Row[] = [];
  for (const provider of providerOrder) {
    const state = snapshot.providers.find((s) => s.provider === provider);
    const accounts = snapshot.accounts
      .filter((account) => account.provider === provider)
      .sort((left, right) => {
        const active =
          Number(state?.activeAccountId !== left.id) - Number(state?.activeAccountId !== right.id);
        return active !== 0 ? active : left.label.localeCompare(right.label);
      });
    for (const account of accounts) {
      rows.push({ provider, accountId: account.id });
    }
  }
  return rows;
}

function accountLine(
  ctx: Ctx,
  account: Account,
  windows: readonly UsageWindow[],
  isActive: boolean,
  isSelected: boolean,
) {
  const badge = healthBadge(ctx.theme, account);
  const marker = isActive ? "●" : isSelected ? "▸" : "○";
  const markerColor = isActive ? ctx.theme.good : isSelected ? ctx.theme.accent : ctx.theme.faint;
  const children = [
    Text({ content: ` ${marker} `, fg: rgb(markerColor) }),
    Text({
      content: pad(account.label, labelWidth - 2),
      fg: rgb(isActive || isSelected ? ctx.theme.fg : ctx.theme.dim),
      attributes: isActive ? 1 : 0,
    }),
    Text({ content: badge === null ? "  " : " *", fg: rgb(badge?.color ?? ctx.theme.dim) }),
  ];
  if (windows.length === 0) {
    children.push(
      Text({ content: account.health === "ready" ? " …" : " —", fg: rgb(ctx.theme.dim) }),
    );
  }
  for (const window of hardWindows(windows).slice(0, 3)) {
    children.push(
      Text({ content: ` ${shortWindow(window.label)} `, fg: rgb(ctx.theme.dim) }),
      Text({
        content: `${meter(window.usedPercent, 6)} ${percentLabel(window.usedPercent)}`,
        fg: rgb(pressureColor(ctx.theme, window.usedPercent)),
      }),
    );
  }
  return Box(
    {
      flexDirection: "row",
      width: "100%",
      backgroundColor: isSelected ? rgb(ctx.theme.selected) : rgb(ctx.theme.bg),
    },
    ...children,
  );
}

function accountDetail(ctx: Ctx, account: Account, windows: readonly UsageWindow[]) {
  const indent = " ".repeat(5);
  const plan = planLabel(account.plan);
  const lines: ReturnType<typeof Box>[] = [
    Box(
      { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
      Text({ content: `${indent}${providerShort[account.provider]}`, fg: rgb(ctx.theme.dim) }),
      Text({
        content: plan === null ? "  ·  plan —" : `  ·  ${plan}`,
        fg: rgb(plan === null ? ctx.theme.dim : ctx.theme.accent),
        attributes: plan === null ? 0 : 1,
      }),
    ),
  ];
  const hard = hardWindows(windows);
  if (hard.length === 0) {
    lines.push(
      Box(
        { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
        Text({
          content: `${indent}${account.health === "ready" ? "waiting for usage…" : "usage unavailable"}`,
          fg: rgb(ctx.theme.dim),
        }),
      ),
    );
  }
  for (const window of hard) {
    const reset = resetCountdown(window.resetAt, ctx.now);
    lines.push(
      Box(
        { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
        Text({ content: `${indent}${pad(window.label, 16)} `, fg: rgb(ctx.theme.dim) }),
        Text({
          content: `${meter(window.usedPercent, 8)} ${percentLabel(window.usedPercent)}`,
          fg: rgb(pressureColor(ctx.theme, window.usedPercent)),
        }),
        Text({
          content: reset === null ? "" : `   resets in ${reset}`,
          fg: rgb(ctx.theme.dim),
        }),
      ),
    );
  }
  const shortId = account.externalAccountId?.slice(0, 8) ?? "—";
  const added = account.createdAt.slice(0, 10);
  lines.push(
    Box(
      { flexDirection: "row", backgroundColor: rgb(ctx.theme.selected) },
      Text({ content: `${indent}account ${shortId}  ·  added ${added}`, fg: rgb(ctx.theme.faint) }),
    ),
  );
  return lines;
}

function providerPanel(
  ctx: Ctx,
  snapshot: DashboardSnapshot,
  provider: ProviderId,
  rows: Row[],
  selected: number,
  expanded: boolean,
) {
  const state: ProviderState | undefined = snapshot.providers.find((s) => s.provider === provider);
  const providerRows = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.provider === provider);
  const lines: ReturnType<typeof Box>[] =
    providerRows.length === 0
      ? [
          Box(
            { flexDirection: "row", width: "100%" },
            Text({
              content: `   no accounts — tokenmaxx login ${providerCli[provider]}`,
              fg: rgb(ctx.theme.dim),
            }),
          ),
        ]
      : providerRows.flatMap((entry) => {
          const account = snapshot.accounts.find((a) => a.id === entry.row.accountId);
          if (account === undefined) {
            return [Box({ width: "100%" })];
          }
          const windows = snapshot.usage.find((u) => u.accountId === entry.row.accountId)?.windows;
          const isSelected = entry.index === selected;
          const line = accountLine(
            ctx,
            account,
            windows ?? [],
            state?.activeAccountId === entry.row.accountId,
            isSelected,
          );
          return isSelected && expanded
            ? [line, ...accountDetail(ctx, account, windows ?? [])]
            : [line];
        });
  const auto = state?.policy.enabled ? `⟳ auto ${state.policy.thresholdPercent}%` : "auto off";
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: rgb(ctx.theme.border),
      title: ` ${providerTitles[provider]}   ${auto} `,
      titleColor: rgb(state?.policy.enabled ? ctx.theme.good : ctx.theme.dim),
    },
    ...lines,
  );
}

function legend(ctx: Ctx, snapshot: DashboardSnapshot): ReturnType<typeof Box> | null {
  const flagged = snapshot.accounts
    .map((account) => healthBadge(ctx.theme, account))
    .filter((badge): badge is NonNullable<typeof badge> => badge !== null);
  if (flagged.length === 0) {
    return null;
  }
  const distinct = [...new Map(flagged.map((badge) => [badge.text, badge])).values()];
  return Box(
    { flexDirection: "row" },
    Text({ content: " * ", fg: rgb(ctx.theme.warn) }),
    ...distinct.flatMap((badge) => [
      Text({ content: badge.text.replace(/^[⚠·]\s*/, ""), fg: rgb(badge.color) }),
      Text({ content: " ", fg: rgb(ctx.theme.dim) }),
    ]),
    Text({ content: "— run tokenmaxx list", fg: rgb(ctx.theme.dim) }),
  );
}

function pill(ctx: Ctx, label: string, active: boolean) {
  return Text({
    content: ` ${label} `,
    fg: rgb(active ? ctx.theme.bg : ctx.theme.dim),
    bg: rgb(active ? ctx.theme.accent : ctx.theme.bg),
    attributes: active ? 1 : 0,
  });
}

function tabBar(ctx: Ctx, tab: Tab) {
  return Box(
    { flexDirection: "row", gap: 1 },
    pill(ctx, "Accounts", tab === "accounts"),
    pill(ctx, "Analytics", tab === "analytics"),
  );
}

function timeframeBar(ctx: Ctx, timeframe: Timeframe) {
  const cells = TIMEFRAMES.flatMap((option, index) => [
    ...(index === 0 ? [] : [Text({ content: " ", fg: rgb(ctx.theme.faint) })]),
    pill(ctx, option.label, option.key === timeframe.key),
  ]);
  return Box(
    { flexDirection: "row", width: "100%", paddingLeft: 1 },
    Text({ content: "range  ", fg: rgb(ctx.theme.dim) }),
    ...cells,
  );
}

function throughputCard(
  ctx: Ctx,
  tokens: TokenTimeframe | undefined,
  timeframe: Timeframe,
  height: number,
  width: number,
) {
  const body: ReturnType<typeof Box>[] = [];
  if (tokens === undefined || tokens.totalTokens === 0) {
    for (let index = 0; index < Math.max(1, height - 1); index += 1) {
      body.push(Box({ flexDirection: "row" }, Text({ content: " ", fg: rgb(ctx.theme.bg) })));
    }
    body.push(
      Box(
        { flexDirection: "row" },
        Text({ content: "  no token usage yet — run ", fg: rgb(ctx.theme.dim) }),
        Text({ content: "codex", fg: rgb(ctx.theme.fg) }),
        Text({ content: " or ", fg: rgb(ctx.theme.dim) }),
        Text({ content: "claude", fg: rgb(ctx.theme.fg) }),
        Text({ content: " and it fills in", fg: rgb(ctx.theme.dim) }),
      ),
    );
  } else {
    const columns = throughputColumns(tokens.buckets, width * 2);
    const peak = Math.max(...columns, 1);
    const chart = brailleLine(columns, width, height, peak);
    const axisTop = `${compactNumber(tokens.peakPerHour)}/h`.padStart(6);
    chart.forEach((line, index) => {
      const axis = index === 0 ? axisTop : index === chart.length - 1 ? "     0" : "      ";
      body.push(
        Box(
          { flexDirection: "row" },
          Text({ content: `${axis} `, fg: rgb(ctx.theme.faint) }),
          Text({ content: line, fg: rgb(ctx.theme.accent) }),
        ),
      );
    });
    body.push(
      Box(
        { flexDirection: "row" },
        Text({ content: "       ", fg: rgb(ctx.theme.bg) }),
        Text({
          content: `${timeframe.label} ago`.padEnd(Math.max(0, width - 3)),
          fg: rgb(ctx.theme.faint),
        }),
        Text({ content: "now", fg: rgb(ctx.theme.faint) }),
      ),
    );
    body.push(
      Box(
        { flexDirection: "row", paddingLeft: 1 },
        Text({ content: "Σ ", fg: rgb(ctx.theme.dim) }),
        Text({
          content: `${compactNumber(tokens.totalTokens)} tokens`,
          fg: rgb(ctx.theme.fg),
          attributes: 1,
        }),
        Text({ content: "   ≈ ", fg: rgb(ctx.theme.dim) }),
        Text({ content: compactUsd(tokens.costUsd), fg: rgb(ctx.theme.good), attributes: 1 }),
        Text({ content: "   peak ", fg: rgb(ctx.theme.dim) }),
        Text({ content: `${compactNumber(tokens.peakPerHour)}/h`, fg: rgb(ctx.theme.accent) }),
        Text({
          content: tokens.topModel === null ? "" : `   top ${tokens.topModel}`,
          fg: rgb(ctx.theme.faint),
        }),
      ),
    );
    body.push(
      Box(
        { flexDirection: "row", paddingLeft: 1 },
        Text({ content: "codex ", fg: rgb(ctx.theme.dim) }),
        Text({ content: compactNumber(tokens.byProvider.openai.tokens), fg: rgb(ctx.theme.fg) }),
        Text({
          content: ` · ${compactUsd(tokens.byProvider.openai.costUsd)}`,
          fg: rgb(ctx.theme.faint),
        }),
        Text({ content: "      claude ", fg: rgb(ctx.theme.dim) }),
        Text({
          content: compactNumber(tokens.byProvider.anthropic.tokens),
          fg: rgb(ctx.theme.fg),
        }),
        Text({
          content: ` · ${compactUsd(tokens.byProvider.anthropic.costUsd)}`,
          fg: rgb(ctx.theme.faint),
        }),
      ),
    );
  }
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: rgb(ctx.theme.border),
      title: " Token throughput · all accounts · both providers ",
      titleColor: rgb(ctx.theme.dim),
    },
    ...body,
  );
}

function analyticsBody(ctx: Ctx, analytics: AnalyticsSnapshot, timeframe: Timeframe) {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const width = Math.max(24, Math.min(160, cols - 12));
  const height = Math.max(4, Math.min(10, rows - 16));
  const tokens = analytics.tokens?.timeframes.find((entry) => entry.key === timeframe.key);
  return [timeframeBar(ctx, timeframe), throughputCard(ctx, tokens, timeframe, height, width)];
}

function accountsBody(
  ctx: Ctx,
  snapshot: DashboardSnapshot,
  rows: Row[],
  selected: number,
  expanded: boolean,
) {
  const note = legend(ctx, snapshot);
  return [
    providerPanel(ctx, snapshot, "openai", rows, selected, expanded),
    providerPanel(ctx, snapshot, "anthropic", rows, selected, expanded),
    Box({ flexGrow: 1, width: "100%" }),
    ...(note === null ? [] : [note]),
  ];
}

interface ViewState {
  tab: Tab;
  selected: number;
  expanded: boolean;
  timeframeIndex: number;
  installed: boolean;
  note: string;
}

function view(ctx: Ctx, analytics: AnalyticsSnapshot, rows: Row[], state: ViewState) {
  const clock = new Date(ctx.now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const freshestMillis = analytics.snapshot.usage
    .map((u) => Date.parse(u.observedAt))
    .filter((millis) => Number.isFinite(millis))
    .reduce((max, millis) => Math.max(max, millis), 0);
  const refreshed = freshestMillis === 0 ? "—" : `${relativeAge(freshestMillis, ctx.now)} ago`;
  const timeframe = TIMEFRAMES[state.timeframeIndex] ?? fallbackTimeframe;
  const footer =
    state.tab === "accounts"
      ? "↑↓ select · space details · ⏎ switch · a auto · tab analytics · r refresh"
      : "←→ range · tab accounts · r refresh";
  const header = Box(
    { flexDirection: "row" },
    Text({ content: "tokenmaxx", fg: rgb(ctx.theme.accent), attributes: 1 }),
    Text({ content: `  ${clock}`, fg: rgb(ctx.theme.dim) }),
    Text({ content: `   ↻ ${refreshed}  ·  active 60s / idle 5m`, fg: rgb(ctx.theme.faint) }),
    ...(state.note === "" ? [] : [Text({ content: `   ${state.note}`, fg: rgb(ctx.theme.warn) })]),
  );
  const children: Array<ReturnType<typeof Box> | ReturnType<typeof Text>> = [header];
  if (!state.installed) {
    children.push(
      Box(
        { width: "100%", backgroundColor: rgb(ctx.theme.warn) },
        Text({
          content: " native routing is off — run  tokenmaxx install  to route codex & claude",
          fg: rgb(ctx.theme.bg),
          bg: rgb(ctx.theme.warn),
          attributes: 1,
        }),
      ),
    );
  }
  children.push(tabBar(ctx, state.tab));
  children.push(
    ...(state.tab === "accounts"
      ? accountsBody(ctx, analytics.snapshot, rows, state.selected, state.expanded)
      : analyticsBody(ctx, analytics, timeframe)),
  );
  children.push(Text({ content: footer, fg: rgb(ctx.theme.dim) }));
  return Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      gap: 1,
      backgroundColor: rgb(ctx.theme.bg),
    },
    ...children,
  );
}

export async function runTuiDashboard(
  socketPath: string,
  options: { installed: boolean; fixture?: AnalyticsSnapshot; now?: number },
): Promise<void> {
  const live = options.fixture === undefined;
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  await renderer.waitForThemeMode(400).catch(() => null);
  const envFallback: ThemeName = detectThemeName(process.env);
  const currentTheme = (): Theme =>
    themes[live ? (renderer.themeMode ?? envFallback) : envFallback];
  let analytics = options.fixture ?? (await readAnalytics(socketPath));
  let rows = orderedRows(analytics.snapshot);
  const state: ViewState = {
    tab: "accounts",
    selected: 0,
    expanded: false,
    timeframeIndex: 2,
    installed: options.installed,
    note: "",
  };
  let busy = false;

  const clampSelection = () => {
    state.selected = rows.length === 0 ? 0 : Math.max(0, Math.min(state.selected, rows.length - 1));
  };

  const paint = () => {
    clampSelection();
    let next: ReturnType<typeof Box>;
    try {
      next = view(
        { theme: currentTheme(), now: options.now ?? Date.now() },
        analytics,
        rows,
        state,
      );
    } catch {
      return;
    }
    for (const child of [...renderer.root.getChildren()]) {
      renderer.root.remove(child);
      child.destroyRecursively();
    }
    renderer.root.add(next);
  };

  const withBusy = async (message: string, work: () => Promise<void>) => {
    if (busy) {
      return;
    }
    busy = true;
    state.note = message;
    paint();
    try {
      await work();
      state.note = "";
    } catch (error) {
      state.note = error instanceof Error ? error.message : "failed";
    } finally {
      busy = false;
      paint();
    }
  };

  const reload = (refresh: boolean) =>
    withBusy(refresh ? "refreshing…" : "", async () => {
      if (refresh) {
        await refreshUsage(socketPath);
      }
      analytics = await readAnalytics(socketPath);
      rows = orderedRows(analytics.snapshot);
      clampSelection();
    });

  const switchToSelected = () => {
    const row = rows[state.selected];
    if (row === undefined) {
      return;
    }
    void withBusy("switching…", async () => {
      await requestSwitch(socketPath, row.provider, row.accountId);
      analytics = await readAnalytics(socketPath);
      rows = orderedRows(analytics.snapshot);
      const moved = rows.findIndex((r) => r.accountId === row.accountId);
      if (moved >= 0) {
        state.selected = moved;
      }
    });
  };

  const toggleAuto = () => {
    const row = rows[state.selected];
    if (row === undefined) {
      return;
    }
    const providerState = analytics.snapshot.providers.find((s) => s.provider === row.provider);
    const enable = !(providerState?.policy.enabled ?? false);
    void withBusy(
      `auto-rotate ${providerCli[row.provider]} ${enable ? "on" : "off"}…`,
      async () => {
        await requestPolicy(socketPath, {
          provider: row.provider,
          enabled: enable,
          thresholdPercent: 95,
          authorizationConfirmed: enable,
        });
        analytics = await readAnalytics(socketPath);
      },
    );
  };

  await new Promise<void>((resolve) => {
    const interval = live
      ? setInterval(() => void reload(false).catch(() => undefined), 2_000)
      : null;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (interval !== null) {
        clearInterval(interval);
      }
      try {
        renderer.destroy();
      } catch {}
      resolve();
    };
    const changeTimeframe = (delta: number) => {
      state.timeframeIndex = Math.max(
        0,
        Math.min(TIMEFRAMES.length - 1, state.timeframeIndex + delta),
      );
      paint();
    };
    renderer.keyInput.on("keypress", (key: { name: string; ctrl: boolean }) => {
      try {
        if (key.name === "q" || (key.ctrl && key.name === "c")) {
          finish();
        } else if (key.name === "tab") {
          state.tab = state.tab === "accounts" ? "analytics" : "accounts";
          paint();
        } else if (key.name === "r" && live) {
          void reload(true);
        } else if (state.tab === "analytics") {
          if (key.name === "left" || key.name === "up" || key.name === "k") {
            changeTimeframe(-1);
          } else if (key.name === "right" || key.name === "down" || key.name === "j") {
            changeTimeframe(1);
          }
        } else if (key.name === "up" || key.name === "k") {
          state.selected = Math.max(0, state.selected - 1);
          paint();
        } else if (key.name === "down" || key.name === "j") {
          state.selected = Math.max(0, Math.min(rows.length - 1, state.selected + 1));
          paint();
        } else if (key.name === "space") {
          state.expanded = !state.expanded;
          paint();
        } else if (key.name === "return" && live) {
          switchToSelected();
        } else if (key.name === "a" && live) {
          toggleAuto();
        }
      } catch {}
    });
    paint();
    renderer.start();
  });
}
