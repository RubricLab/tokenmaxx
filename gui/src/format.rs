use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use regex::Regex;

use crate::model::{Account, DashboardSnapshot, Health, Provider, UsageWindow, WindowKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pressure {
    Unknown,
    Good,
    Warn,
    Bad,
}

pub fn pressure(used_percent: Option<f64>) -> Pressure {
    match used_percent {
        None => Pressure::Unknown,
        Some(value) if value >= 85.0 => Pressure::Bad,
        Some(value) if value >= 60.0 => Pressure::Warn,
        Some(_) => Pressure::Good,
    }
}

pub fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

pub fn percent_label(used_percent: Option<f64>) -> String {
    match used_percent {
        None => "?%".into(),
        Some(value) => format!("{}%", clamp_percent(value).round()),
    }
}

pub fn parse_time(iso: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

pub fn short_reset(reset_at: Option<&str>, now: DateTime<Utc>) -> Option<String> {
    let remaining = (parse_time(reset_at?)? - now).num_milliseconds();
    if remaining <= 0 {
        return Some("now".into());
    }
    let minutes = (remaining as f64 / 60_000.0).round();
    if minutes < 60.0 {
        return Some(format!("{minutes}m"));
    }
    let hours = (minutes / 60.0).round();
    if hours < 24.0 {
        return Some(format!("{hours}h"));
    }
    Some(format!("{}d", (hours / 24.0).round()))
}

pub fn relative_age(observed: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let seconds = ((now - observed).num_milliseconds() as f64 / 1000.0)
        .round()
        .max(0.0) as i64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 48 {
        format!("{hours}h")
    } else {
        format!("{}d", hours / 24)
    }
}

static MULTIPLIER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)\s*x").unwrap());
static WORD_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s_-]+").unwrap());

pub fn plan_label(plan: Option<&str>) -> Option<String> {
    let raw = plan?.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }
    if raw.contains("max") {
        return Some(match MULTIPLIER.captures(&raw) {
            Some(captures) => format!("Max {}×", &captures[1]),
            None => "Max".into(),
        });
    }
    Some(
        WORD_SPLIT
            .split(&raw)
            .filter(|word| !word.is_empty())
            .map(|word| {
                let mut characters = word.chars();
                characters
                    .next()
                    .map(|first| first.to_uppercase().chain(characters).collect::<String>())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

pub struct HealthBadge {
    pub text: &'static str,
    pub pressure: Pressure,
}

pub fn health_badge(health: Health) -> Option<HealthBadge> {
    let (text, pressure) = match health {
        Health::Ready | Health::Unchecked | Health::RefreshDue | Health::Refreshing => return None,
        Health::LoginExpiring => ("Login expiring", Pressure::Warn),
        Health::ScopeMissing => ("Missing scope", Pressure::Warn),
        Health::ReauthenticationRequired => ("Login required", Pressure::Bad),
        Health::TemporarilyUnreachable => ("Offline", Pressure::Warn),
        Health::UsageRateLimited => ("Rate-limited", Pressure::Warn),
        Health::Disabled => ("Off", Pressure::Unknown),
    };
    Some(HealthBadge { text, pressure })
}

static FIVE_HOUR_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(5 hour|5h session|five hour)$").unwrap());
static SEVEN_DAY_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^7 day( · all models)?$").unwrap());
static SEVEN_DAY_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^7 day · ").unwrap());
static WINDOW_TOKEN_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s·-]+").unwrap());
static NUMERIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(\.\d+)?$").unwrap());

pub fn short_window(label: &str) -> String {
    if FIVE_HOUR_LABEL.is_match(label) {
        return "5h".into();
    }
    if SEVEN_DAY_LABEL.is_match(label) {
        return "7d".into();
    }
    const GENERIC: [&str; 8] = [
        "day", "days", "hour", "hours", "week", "all", "models", "window",
    ];
    let stripped = SEVEN_DAY_PREFIX.replace(label, "");
    let chosen = WINDOW_TOKEN_SPLIT
        .split(&stripped)
        .filter(|token| {
            token.chars().count() > 1
                && !GENERIC.contains(&token.to_lowercase().as_str())
                && !NUMERIC.is_match(token)
        })
        .last()
        .unwrap_or(label);
    if chosen.chars().count() > 8 {
        format!("{}…", chosen.chars().take(7).collect::<String>())
    } else {
        chosen.to_string()
    }
}

static FIVE_HOUR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)5 ?h").unwrap());
static WEEKLY_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(7 day(?: · all models)?)$").unwrap());
static WEEKLY_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(weekly_all|seven_day|weekly|codex:primary)$").unwrap());
static SCOPED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)scoped|fable|opus|sonnet|spark").unwrap());

pub fn is_five_hour_window(window: &UsageWindow) -> bool {
    FIVE_HOUR.is_match(&window.label) || window.id == "session" || window.id == "five-hour"
}

fn window_priority(window: &UsageWindow) -> u8 {
    if is_five_hour_window(window) {
        0
    } else if WEEKLY_LABEL.is_match(&window.label) || WEEKLY_ID.is_match(&window.id) {
        1
    } else if SCOPED.is_match(&format!("{} {}", window.id, window.label)) {
        2
    } else {
        3
    }
}

pub fn visible_windows<'a>(windows: &'a [UsageWindow], hidden: &[String]) -> Vec<&'a UsageWindow> {
    let mut visible: Vec<_> = windows
        .iter()
        .filter(|window| window.kind == WindowKind::Hard && !hidden.contains(&window.id))
        .collect();
    visible.sort_by_key(|window| window_priority(window));
    visible
}

pub fn account_windows<'a>(
    snapshot: &'a DashboardSnapshot,
    account: &Account,
) -> Vec<&'a UsageWindow> {
    let hidden = snapshot
        .state(account.provider)
        .map(|state| state.policy.hidden_window_ids.as_slice())
        .unwrap_or_default();
    snapshot
        .usage(&account.id)
        .map(|usage| visible_windows(&usage.windows, hidden))
        .unwrap_or_default()
}

pub fn fullest_window(snapshot: &DashboardSnapshot, account: &Account) -> Option<f64> {
    account_windows(snapshot, account)
        .into_iter()
        .map(|window| window.used_percent)
        .reduce(f64::max)
}

/// Accounts of one provider, fullest first, the order the dashboard and the menu bar share.
pub fn ordered_accounts(snapshot: &DashboardSnapshot, provider: Provider) -> Vec<&Account> {
    let mut accounts: Vec<_> = snapshot
        .accounts
        .iter()
        .filter(|account| account.provider == provider)
        .collect();
    accounts.sort_by(|left, right| {
        let peak = |account: &Account| fullest_window(snapshot, account).unwrap_or(-1.0);
        peak(right)
            .total_cmp(&peak(left))
            .then_with(|| left.label.cmp(&right.label))
    });
    accounts
}

/// Distinct hard windows across a provider's accounts, 5h first, for the per-window visibility settings.
pub fn provider_windows(snapshot: &DashboardSnapshot, provider: Provider) -> Vec<UsageWindow> {
    let mut seen: Vec<UsageWindow> = Vec::new();
    for usage in snapshot
        .usage
        .iter()
        .filter(|usage| usage.provider == provider)
    {
        for window in usage
            .windows
            .iter()
            .filter(|window| window.kind == WindowKind::Hard)
        {
            if !seen.iter().any(|known| known.id == window.id) {
                seen.push(window.clone());
            }
        }
    }
    seen.sort_by_key(window_priority);
    seen
}

pub fn compact_number(value: f64) -> String {
    let magnitude = value.abs();
    if magnitude >= 1e9 {
        format!("{:.1}B", value / 1e9)
    } else if magnitude >= 1e6 {
        format!("{:.1}M", value / 1e6)
    } else if magnitude >= 1e3 {
        format!("{:.1}k", value / 1e3)
    } else {
        format!("{}", value.round())
    }
}

pub fn money_usd(value: f64) -> String {
    let cents = (value * 100.0).round() as i64;
    let whole = (cents / 100).abs().to_string();
    let grouped: Vec<String> = whole
        .as_bytes()
        .rchunks(3)
        .rev()
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect();
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}${}.{:02}", grouped.join(","), (cents % 100).abs())
}

pub fn minutes_label(milliseconds: u64) -> String {
    match milliseconds / 60_000 {
        0 => "Off".into(),
        1 => "1 min".into(),
        minutes => format!("{minutes} min"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: &str, label: &str, used: f64) -> UsageWindow {
        UsageWindow {
            id: id.into(),
            kind: WindowKind::Hard,
            label: label.into(),
            reset_at: None,
            used_percent: used,
        }
    }

    #[test]
    fn pressure_thresholds() {
        assert_eq!(pressure(None), Pressure::Unknown);
        assert_eq!(pressure(Some(59.9)), Pressure::Good);
        assert_eq!(pressure(Some(60.0)), Pressure::Warn);
        assert_eq!(pressure(Some(85.0)), Pressure::Bad);
    }

    #[test]
    fn resets_round_to_the_largest_unit() {
        let now = parse_time("2026-09-24T12:00:00Z").unwrap();
        assert_eq!(
            short_reset(Some("2026-09-24T11:00:00Z"), now).as_deref(),
            Some("now")
        );
        assert_eq!(
            short_reset(Some("2026-09-24T12:42:00Z"), now).as_deref(),
            Some("42m")
        );
        assert_eq!(
            short_reset(Some("2026-09-24T15:10:00Z"), now).as_deref(),
            Some("3h")
        );
        assert_eq!(
            short_reset(Some("2026-09-27T12:00:00Z"), now).as_deref(),
            Some("3d")
        );
        assert_eq!(short_reset(None, now), None);
    }

    #[test]
    fn ages() {
        let now = parse_time("2026-09-24T12:00:00Z").unwrap();
        assert_eq!(
            relative_age(parse_time("2026-09-24T11:59:30Z").unwrap(), now),
            "30s"
        );
        assert_eq!(
            relative_age(parse_time("2026-09-24T11:30:00Z").unwrap(), now),
            "30m"
        );
        assert_eq!(
            relative_age(parse_time("2026-09-22T11:00:00Z").unwrap(), now),
            "2d"
        );
    }

    #[test]
    fn plans() {
        assert_eq!(plan_label(Some("max_20x")).as_deref(), Some("Max 20×"));
        assert_eq!(plan_label(Some("pro")).as_deref(), Some("Pro"));
        assert_eq!(plan_label(Some("team_plus")).as_deref(), Some("Team Plus"));
        assert_eq!(plan_label(Some("  ")), None);
    }

    #[test]
    fn window_names() {
        assert_eq!(short_window("5 hour"), "5h");
        assert_eq!(short_window("7 day · all models"), "7d");
        assert_eq!(short_window("7 day · Opus"), "Opus");
        assert_eq!(short_window("GPT-5.3-Codex-Spark weekly"), "weekly");
    }

    #[test]
    fn windows_order_session_then_week_then_scoped() {
        let windows = vec![
            window("opus", "7 day · Opus", 1.0),
            window("weekly_all", "7 day", 2.0),
            window("session", "5 hour", 3.0),
            UsageWindow {
                kind: WindowKind::Soft,
                ..window("soft", "soft", 4.0)
            },
        ];
        let ids: Vec<_> = visible_windows(&windows, &[])
            .iter()
            .map(|w| w.id.as_str())
            .collect();
        assert_eq!(ids, ["session", "weekly_all", "opus"]);
        let hidden = vec!["opus".to_string()];
        assert_eq!(visible_windows(&windows, &hidden).len(), 2);
    }

    #[test]
    fn numbers() {
        assert_eq!(compact_number(950.0), "950");
        assert_eq!(compact_number(12_345.0), "12.3k");
        assert_eq!(compact_number(4_200_000.0), "4.2M");
        assert_eq!(money_usd(1234.5), "$1,234.50");
        assert_eq!(money_usd(0.004), "$0.00");
        assert_eq!(minutes_label(300_000), "5 min");
        assert_eq!(minutes_label(0), "Off");
    }
}
