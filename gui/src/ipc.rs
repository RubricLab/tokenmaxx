use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use smol::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use smol::net::unix::UnixStream;

use crate::model::{
    Account, AnalyticsSnapshot, Ping, Provider, ResetCreditsView, ResetOutcome, RoutingStatus,
    RoutingTarget,
};

pub fn tokenmaxx_home() -> PathBuf {
    std::env::var_os("TOKENMAXX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".tokenmaxx"))
}

pub fn socket_path() -> PathBuf {
    tokenmaxx_home().join("runtime").join("manager.sock")
}

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RpcError {}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

async fn exchange(method: &str, params: Value) -> Result<Value> {
    let mut stream = UnixStream::connect(socket_path())
        .await
        .context("tokenmaxx is not running")?;
    let request = json!({ "id": 1, "method": method, "params": params });
    stream.write_all(format!("{request}\n").as_bytes()).await?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).await?;
    let response: Response = serde_json::from_str(&line)?;
    match (response.result, response.error) {
        (_, Some(error)) => Err(error.into()),
        (Some(result), None) => Ok(result),
        (None, None) => Ok(Value::Null),
    }
}

pub async fn request<T: DeserializeOwned>(
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<T> {
    let expired = async {
        smol::Timer::after(timeout).await;
        Err(anyhow!("{method} timed out"))
    };
    let value = smol::future::or(exchange(method, params), expired).await?;
    Ok(serde_json::from_value(value)?)
}

const QUICK: Duration = Duration::from_secs(15);

pub async fn ping() -> Result<Ping> {
    request("manager/ping", Value::Null, Duration::from_millis(500)).await
}

pub async fn analytics() -> Result<AnalyticsSnapshot> {
    request("dashboard/analytics", Value::Null, QUICK).await
}

pub async fn routing() -> Result<RoutingStatus> {
    request("routing/read", Value::Null, QUICK).await
}

pub async fn set_routing(target: RoutingTarget, enable: bool) -> Result<RoutingStatus> {
    request(
        "routing/set",
        json!({ "target": target, "enable": enable }),
        QUICK,
    )
    .await
}

pub async fn refresh() -> Result<Value> {
    request("usage/refresh", Value::Null, Duration::from_secs(60)).await
}

pub async fn switch(provider: Provider, account_id: &str) -> Result<Value> {
    let params = json!({ "provider": provider, "reason": "manual", "targetAccountId": account_id });
    request("provider/switch", params, Duration::from_secs(30)).await
}

pub async fn set_policy(provider: Provider, mut changes: Value) -> Result<Value> {
    changes["provider"] = json!(provider);
    request("policy/set", changes, QUICK).await
}

pub async fn save_account(account: &Account) -> Result<Value> {
    let params = json!({
        "account": account,
        "removePrevious": { "profilePath": null, "secretReference": null }
    });
    request("account/save", params, QUICK).await
}

pub async fn remove_account(account_id: &str) -> Result<Value> {
    request(
        "account/remove",
        json!({ "accountId": account_id }),
        Duration::from_secs(20),
    )
    .await
}

pub async fn add_api_key(provider: Provider, key: &str, label: &str) -> Result<Value> {
    let params = json!({ "provider": provider, "key": key, "label": label });
    request("account/addApiKey", params, Duration::from_secs(30)).await
}

pub async fn reset_credits(account_id: &str) -> Result<ResetCreditsView> {
    request(
        "codex/resetCredits",
        json!({ "accountId": account_id }),
        Duration::from_secs(20),
    )
    .await
}

pub async fn consume_reset(account_id: &str) -> Result<ResetOutcome> {
    request(
        "codex/consumeReset",
        json!({ "accountId": account_id }),
        Duration::from_secs(45),
    )
    .await
}

#[derive(Deserialize)]
struct Latest {
    latest: Option<String>,
}

pub async fn latest_version() -> Result<Option<String>> {
    let latest: Latest = request("version/latest", Value::Null, Duration::from_secs(5)).await?;
    Ok(latest.latest)
}
