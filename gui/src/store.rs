use std::cmp::Ordering;
use std::future::Future;
use std::time::Duration;

use anyhow::Result;
use gpui_kit::*;

use crate::cli::{self, CommandLineTool, Runtime};
use crate::ipc;
use crate::model::{AnalyticsSnapshot, Provider, RoutingStatus};
use crate::prefs::{self, Preferences};
use crate::terminal::{self, Terminal};

const POLL: Duration = Duration::from_secs(2);
const RESOLVE: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq)]
pub enum Connection {
    Connecting,
    Ready,
    Failed(SharedString),
}

pub enum StoreEvent {
    Notice(SharedString),
    Error(SharedString),
    PreferencesChanged,
}

/// The daemon's state as last read, plus the one mutation in flight. Every screen and the menu bar read from here.
pub struct Store {
    pub connection: Connection,
    pub analytics: AnalyticsSnapshot,
    pub routing: RoutingStatus,
    pub runtime: Option<Runtime>,
    pub latest: Option<String>,
    pub busy: Option<SharedString>,
    pub preferences: Preferences,
    pub terminals: Vec<Terminal>,
}

impl EventEmitter<StoreEvent> for Store {}

async fn read_state() -> Result<(AnalyticsSnapshot, RoutingStatus)> {
    let (analytics, routing) = smol::future::zip(ipc::analytics(), ipc::routing()).await;
    Ok((analytics?, routing?))
}

/// Starts the daemon with the resolved `tokenmaxx` unless one at least as new already answers.
async fn connect() -> Result<Runtime> {
    let runtime = cli::resolve()?;
    let running = ipc::ping().await.ok().and_then(|ping| ping.version);
    let behind = running
        .as_deref()
        .is_none_or(|running| cli::compare_versions(running, &runtime.version) == Ordering::Less);
    if behind {
        cli::start_daemon(&runtime.binary)?;
    }
    Ok(runtime)
}

impl Store {
    pub fn new(cx: &mut Context<Self>) -> Self {
        cx.spawn(async move |this, cx| Self::run(this, cx).await)
            .detach();
        Self {
            connection: Connection::Connecting,
            analytics: AnalyticsSnapshot::default(),
            routing: RoutingStatus::default(),
            runtime: None,
            latest: None,
            busy: None,
            preferences: prefs::load(),
            terminals: terminal::installed_terminals(),
        }
    }

    async fn run(this: WeakEntity<Self>, cx: &mut AsyncApp) {
        loop {
            let connected = cx.background_executor().spawn(connect()).await;
            let failed = connected
                .as_ref()
                .err()
                .map(|error| SharedString::from(error.to_string()));
            let alive = this.update(cx, |this, cx| {
                match connected {
                    Ok(runtime) => {
                        this.runtime = Some(runtime);
                        this.connection = Connection::Ready;
                    }
                    Err(_) => {
                        this.connection = Connection::Failed(failed.clone().unwrap_or_default())
                    }
                }
                cx.notify();
            });
            if alive.is_err() {
                return;
            }
            if failed.is_none() {
                break;
            }
            cx.background_executor().timer(Duration::from_secs(5)).await;
        }
        this.update(cx, |this, cx| this.check_background_state(cx))
            .ok();
        loop {
            let state = cx.background_executor().spawn(read_state()).await;
            let alive = this.update(cx, |this, cx| {
                if this.busy.is_none() {
                    this.apply(state, cx);
                }
            });
            if alive.is_err() {
                return;
            }
            cx.background_executor().timer(POLL).await;
        }
    }

    fn apply(&mut self, state: Result<(AnalyticsSnapshot, RoutingStatus)>, cx: &mut Context<Self>) {
        match state {
            Ok((analytics, routing)) => {
                self.connection = Connection::Ready;
                if self.analytics != analytics || self.routing != routing {
                    self.analytics = analytics;
                    self.routing = routing;
                    cx.notify();
                }
            }
            Err(error) => {
                let failed = Connection::Failed(error.to_string().into());
                if self.connection != failed {
                    self.connection = failed;
                    cx.notify();
                }
            }
        }
    }

    /// Checks for a newer release once, then follows the installed `tokenmaxx` as the user updates it.
    fn check_background_state(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let latest = ipc::latest_version().await.ok().flatten();
            if this
                .update(cx, |this, cx| {
                    this.latest = latest;
                    cx.notify();
                })
                .is_err()
            {
                return;
            }
            loop {
                cx.background_executor().timer(RESOLVE).await;
                let Ok(runtime) = cx.background_executor().spawn(connect()).await else {
                    continue;
                };
                let alive = this.update(cx, |this, cx| {
                    if this.runtime.as_ref() != Some(&runtime) {
                        this.runtime = Some(runtime);
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    pub fn is_busy(&self) -> bool {
        self.busy.is_some()
    }

    /// Runs one daemon mutation, re-reads state when it lands, and reports the outcome as a notification.
    pub fn perform<T, F>(
        &mut self,
        label: impl Into<SharedString>,
        work: F,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) where
        T: Send + 'static,
        F: Future<Output = Result<T>> + Send + 'static,
    {
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(label.into());
        cx.notify();
        let work = cx.background_executor().spawn(work);
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let state = cx.background_executor().spawn(read_state()).await;
            this.update(cx, |this, cx| {
                this.busy = None;
                match result {
                    Ok(value) => done(this, value, cx),
                    Err(error) => cx.emit(StoreEvent::Error(error.to_string().into())),
                }
                this.apply(state, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.perform("Refreshing…", ipc::refresh(), |_, _, _| {}, cx);
    }

    pub fn switch(&mut self, provider: Provider, account_id: String, cx: &mut Context<Self>) {
        let label = self
            .analytics
            .snapshot
            .account(&account_id)
            .map(|account| account.label.clone())
            .unwrap_or_default();
        self.perform(
            format!("Switching to {label}…"),
            async move { ipc::switch(provider, &account_id).await },
            move |_, _, cx| {
                cx.emit(StoreEvent::Notice(
                    format!("{} now uses {label}", provider.title()).into(),
                ))
            },
            cx,
        );
    }

    pub fn set_policy(
        &mut self,
        provider: Provider,
        changes: serde_json::Value,
        cx: &mut Context<Self>,
    ) {
        self.perform(
            "Saving…",
            async move { ipc::set_policy(provider, changes).await },
            |_, _, _| {},
            cx,
        );
    }

    pub fn set_routing(
        &mut self,
        target: crate::model::RoutingTarget,
        enable: bool,
        cx: &mut Context<Self>,
    ) {
        self.perform(
            if enable {
                "Routing…"
            } else {
                "Restoring config…"
            },
            async move { ipc::set_routing(target, enable).await },
            |_, _, _| {},
            cx,
        );
    }

    pub fn set_preferences(&mut self, preferences: Preferences, cx: &mut Context<Self>) {
        if let Err(error) = prefs::save(&preferences) {
            cx.emit(StoreEvent::Error(
                format!("Preferences not saved: {error}").into(),
            ));
        }
        self.preferences = preferences;
        cx.emit(StoreEvent::PreferencesChanged);
        cx.notify();
    }

    pub fn install_command_line_tool(&mut self, cx: &mut Context<Self>) {
        self.perform(
            "Installing the command-line tool…",
            async {
                cli::install_command_line_tool()?;
                cli::resolve()
            },
            |this, runtime, cx| {
                this.runtime = Some(runtime);
                cx.emit(StoreEvent::Notice("tokenmaxx is on your PATH".into()));
            },
            cx,
        );
    }

    /// Brings an older installed `tokenmaxx` up to the app's version; the next resolve adopts it.
    pub fn update_command_line_tool(&mut self, cx: &mut Context<Self>) {
        let Some(Runtime {
            tool: CommandLineTool::Outdated { path, .. },
            bundled_version,
            ..
        }) = self.runtime.clone()
        else {
            return;
        };
        self.run_in_terminal("update", cli::update_command(&path, &bundled_version), cx);
    }

    /// Runs an interactive command in the chosen terminal; the poll picks up its result.
    fn run_in_terminal(&mut self, name: &str, command: Vec<String>, cx: &mut Context<Self>) {
        let terminal = terminal::resolve(self.preferences.terminal.as_deref());
        match terminal::run_in_terminal(terminal, name, &command) {
            Ok(()) => cx.emit(StoreEvent::Notice(
                format!("Continue in {}", terminal.name).into(),
            )),
            Err(error) => cx.emit(StoreEvent::Error(error.to_string().into())),
        }
    }

    pub fn sign_in(&mut self, provider: Provider, cx: &mut Context<Self>) {
        let binary = self
            .runtime
            .as_ref()
            .map(|runtime| runtime.binary.clone())
            .unwrap_or_else(cli::bundled_binary);
        self.run_in_terminal(
            &format!("login-{}", provider.cli()),
            vec![
                binary.display().to_string(),
                "login".into(),
                provider.cli().into(),
            ],
            cx,
        );
    }
}
