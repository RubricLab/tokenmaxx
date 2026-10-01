use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
    Xai,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Openai, Provider::Anthropic];

    pub fn cli(self) -> &'static str {
        match self {
            Provider::Openai => "codex",
            Provider::Anthropic => "claude",
            Provider::Xai => "grok",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Provider::Openai => "Codex",
            Provider::Anthropic => "Claude Code",
            Provider::Xai => "Grok",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Health {
    Unchecked,
    Ready,
    RefreshDue,
    Refreshing,
    LoginExpiring,
    ScopeMissing,
    ReauthenticationRequired,
    TemporarilyUnreachable,
    UsageRateLimited,
    Disabled,
}

impl Health {
    pub fn needs_login(self) -> bool {
        matches!(
            self,
            Health::ReauthenticationRequired | Health::LoginExpiring | Health::ScopeMissing
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Oauth,
    ApiKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnThreshold {
    Switch,
    Spill,
}

/// Round-trips through `account/save`, so every field the daemon's strict schema knows is kept.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub auth: AuthKind,
    pub created_at: String,
    pub enabled: bool,
    pub external_account_id: Option<String>,
    #[serde(default)]
    pub external_user_id: Option<String>,
    pub health: Health,
    pub id: String,
    pub identity: String,
    pub label: String,
    pub on_threshold: OnThreshold,
    #[serde(default)]
    pub plan: Option<String>,
    pub profile_path: Option<String>,
    pub provider: Provider,
    pub secret_reference: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowKind {
    Hard,
    Soft,
    Spend,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub kind: WindowKind,
    pub label: String,
    pub reset_at: Option<String>,
    pub used_percent: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub balance_usd: Option<f64>,
    pub enabled: bool,
    pub exhausted: bool,
    pub limit_usd: Option<f64>,
    pub spent_usd: Option<f64>,
    pub used_percent: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCreditCounts {
    pub applicable: u32,
    pub available: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub account_id: String,
    pub hard_limit_reached: bool,
    pub observed_at: String,
    pub provider: Provider,
    pub windows: Vec<UsageWindow>,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsage>,
    #[serde(default)]
    pub measured_spend_usd: Option<f64>,
    #[serde(default)]
    pub reset_credits: Option<ResetCreditCounts>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPolicy {
    pub enabled: bool,
    pub hidden_window_ids: Vec<String>,
    pub hysteresis_percent: f64,
    pub minimum_dwell_milliseconds: u64,
    pub threshold_percent: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderState {
    pub active_account_id: Option<String>,
    pub policy: AutomationPolicy,
    pub provider: Provider,
    pub switched_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub accounts: Vec<Account>,
    pub providers: Vec<ProviderState>,
    pub sampled_at: String,
    pub usage: Vec<UsageSnapshot>,
}

impl DashboardSnapshot {
    pub fn state(&self, provider: Provider) -> Option<&ProviderState> {
        self.providers
            .iter()
            .find(|state| state.provider == provider)
    }

    pub fn usage(&self, account_id: &str) -> Option<&UsageSnapshot> {
        self.usage
            .iter()
            .find(|usage| usage.account_id == account_id)
    }

    pub fn account(&self, account_id: &str) -> Option<&Account> {
        self.accounts
            .iter()
            .find(|account| account.id == account_id)
    }

    pub fn active_account(&self, provider: Provider) -> Option<&Account> {
        let active = self.state(provider)?.active_account_id.as_deref()?;
        self.account(active)
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub cache_creation: f64,
    pub cached: f64,
    pub cost_usd: f64,
    pub input: f64,
    pub output: f64,
    pub tokens: f64,
    pub provider: Provider,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTimeframe {
    pub bucket_ms: f64,
    pub buckets: Vec<f64>,
    pub by_provider: Vec<TokenBreakdown>,
    pub cost_cache_creation: f64,
    pub cost_cached: f64,
    pub cost_input: f64,
    pub cost_output: f64,
    pub cost_usd: f64,
    pub key: String,
    pub models: Vec<TokenBreakdown>,
    pub peak_per_hour: f64,
    pub total_cache_creation: f64,
    pub total_cached: f64,
    pub total_input: f64,
    pub total_output: f64,
    pub total_tokens: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAnalytics {
    pub now_per_hour: f64,
    pub timeframes: Vec<TokenTimeframe>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSnapshot {
    pub snapshot: DashboardSnapshot,
    #[serde(default)]
    pub tokens: Option<TokenAnalytics>,
}

impl AnalyticsSnapshot {
    pub fn timeframe(&self, key: &str) -> Option<&TokenTimeframe> {
        self.tokens
            .as_ref()?
            .timeframes
            .iter()
            .find(|timeframe| timeframe.key == key)
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    pub expires_at: Option<String>,
    pub id: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCreditsView {
    pub available: u32,
    pub credits: Vec<ResetCredit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetCode {
    Reset,
    NothingToReset,
    NoCredit,
    AlreadyRedeemed,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetOutcome {
    pub code: ResetCode,
    pub windows_reset: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
pub struct ProviderFlags {
    pub openai: bool,
    pub anthropic: bool,
    #[serde(default)]
    pub xai: bool,
}

impl ProviderFlags {
    pub fn get(&self, provider: Provider) -> bool {
        match provider {
            Provider::Openai => self.openai,
            Provider::Anthropic => self.anthropic,
            Provider::Xai => self.xai,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
pub struct PiStatus {
    pub present: bool,
    pub routed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingStatus {
    pub clis: ProviderFlags,
    pub codex_stale: bool,
    pub pi: PiStatus,
    pub routed: ProviderFlags,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutingTarget {
    Openai,
    Anthropic,
    Xai,
    Pi,
}

impl From<Provider> for RoutingTarget {
    fn from(provider: Provider) -> Self {
        match provider {
            Provider::Openai => RoutingTarget::Openai,
            Provider::Anthropic => RoutingTarget::Anthropic,
            Provider::Xai => RoutingTarget::Xai,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ping {
    #[serde(default)]
    pub version: Option<String>,
}

pub const TIMEFRAMES: [&str; 5] = ["1h", "5h", "24h", "7d", "31d"];

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: [&str; 7] = [
        include_str!("../tests/fixtures/blitz.json"),
        include_str!("../tests/fixtures/cruising.json"),
        include_str!("../tests/fixtures/onboarding.json"),
        include_str!("../tests/fixtures/oneHot.json"),
        include_str!("../tests/fixtures/relay.json"),
        include_str!("../tests/fixtures/rotated.json"),
        include_str!("../tests/fixtures/tuned.json"),
    ];

    #[test]
    fn parses_every_dashboard_scenario() {
        for fixture in FIXTURES {
            let analytics: AnalyticsSnapshot = serde_json::from_str(fixture).unwrap();
            for provider in Provider::ALL {
                assert!(analytics.snapshot.state(provider).is_some());
            }
        }
    }

    #[test]
    fn relay_has_every_timeframe() {
        let analytics: AnalyticsSnapshot = serde_json::from_str(FIXTURES[4]).unwrap();
        for key in TIMEFRAMES {
            assert!(analytics.timeframe(key).is_some(), "{key}");
        }
    }
}
