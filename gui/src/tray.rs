use anyhow::Result;
use tray_icon::menu::{
    Icon as MenuIcon, IconMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem,
};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::format::{self, Pressure};
use crate::model::{AnalyticsSnapshot, Provider};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayCommand {
    Switch(Provider, String),
    OpenAccounts,
    OpenSettings,
    Refresh,
    Quit,
}

impl TrayCommand {
    fn id(&self) -> String {
        match self {
            TrayCommand::Switch(provider, account) => {
                format!("switch:{}:{account}", provider.cli())
            }
            TrayCommand::OpenAccounts => "open".into(),
            TrayCommand::OpenSettings => "settings".into(),
            TrayCommand::Refresh => "refresh".into(),
            TrayCommand::Quit => "quit".into(),
        }
    }

    fn parse(id: &str) -> Option<Self> {
        match id {
            "open" => Some(TrayCommand::OpenAccounts),
            "settings" => Some(TrayCommand::OpenSettings),
            "refresh" => Some(TrayCommand::Refresh),
            "quit" => Some(TrayCommand::Quit),
            _ => {
                let (provider, account) = id.strip_prefix("switch:")?.split_once(':')?;
                let provider = Provider::ALL
                    .into_iter()
                    .find(|candidate| candidate.cli() == provider)?;
                Some(TrayCommand::Switch(provider, account.to_string()))
            }
        }
    }
}

/// One menu line, compared between polls so the menu is only rebuilt when something visible changed.
#[derive(Clone, Debug, PartialEq)]
enum Line {
    Heading(String),
    Account {
        command: TrayCommand,
        text: String,
        active: bool,
        pressure: Pressure,
    },
    Note(String),
    Command(TrayCommand, &'static str),
    Separator,
}

fn lines(analytics: &AnalyticsSnapshot) -> Vec<Line> {
    let snapshot = &analytics.snapshot;
    let mut lines = Vec::new();
    for provider in Provider::ALL {
        let accounts = format::ordered_accounts(snapshot, provider);
        if accounts.is_empty() {
            continue;
        }
        let policy = snapshot.state(provider).map(|state| &state.policy);
        let auto = match policy {
            Some(policy) if policy.enabled => format!("auto at {}%", policy.threshold_percent),
            _ => "auto off".into(),
        };
        lines.push(Line::Heading(format!("{} · {auto}", provider.title())));
        let active = snapshot
            .state(provider)
            .and_then(|state| state.active_account_id.clone());
        for account in accounts {
            let windows = format::account_windows(snapshot, account)
                .into_iter()
                .take(2)
                .map(|window| {
                    format!(
                        "{} {}",
                        format::short_window(&window.label),
                        format::percent_label(Some(window.used_percent))
                    )
                })
                .collect::<Vec<_>>()
                .join(" · ");
            let text = if windows.is_empty() {
                account.label.clone()
            } else {
                format!("{}    {windows}", account.label)
            };
            lines.push(Line::Account {
                command: TrayCommand::Switch(provider, account.id.clone()),
                text,
                active: active.as_deref() == Some(account.id.as_str()),
                pressure: if account.health.needs_login() {
                    Pressure::Bad
                } else {
                    format::pressure(format::fullest_window(snapshot, account))
                },
            });
        }
        lines.push(Line::Separator);
    }
    if let Some(day) = analytics.timeframe("24h") {
        let now = analytics
            .tokens
            .as_ref()
            .map(|tokens| tokens.now_per_hour)
            .unwrap_or_default();
        lines.push(Line::Note(format!(
            "{}/h now · {} ≈ {} in 24h",
            format::compact_number(now),
            format::compact_number(day.total_tokens),
            format::money_usd(day.cost_usd)
        )));
        lines.push(Line::Separator);
    }
    lines.extend([
        Line::Command(TrayCommand::Refresh, "Refresh usage"),
        Line::Command(TrayCommand::OpenAccounts, "Open tokenmaxx"),
        Line::Command(TrayCommand::OpenSettings, "Settings…"),
        Line::Separator,
        Line::Command(TrayCommand::Quit, "Quit tokenmaxx"),
    ]);
    lines
}

fn build_menu(lines: &[Line]) -> Result<Menu> {
    let menu = Menu::new();
    for line in lines {
        match line {
            Line::Heading(text) | Line::Note(text) => {
                menu.append(&MenuItem::new(text, false, None))?
            }
            Line::Account {
                command,
                text,
                active,
                pressure,
            } => menu.append(&IconMenuItem::with_id(
                command.id(),
                text,
                true,
                Some(pressure_dot(*pressure, *active)?),
                None,
            ))?,
            Line::Command(command, text) => {
                menu.append(&MenuItem::with_id(command.id(), text, true, None))?
            }
            Line::Separator => menu.append(&PredefinedMenuItem::separator())?,
        }
    }
    Ok(menu)
}

const DOT_SIZE: u32 = 36;

/// An account's pressure as a colored dot, filled for the active account and a ring otherwise,
/// the same ● / ○ the terminal dashboard uses.
fn dot_pixels(pressure: Pressure, active: bool) -> Vec<u8> {
    const RADIUS: f32 = 8.5;
    const RING: f32 = 2.5;
    let [red, green, blue] = match pressure {
        Pressure::Good => [52, 199, 89],
        Pressure::Warn => [255, 159, 10],
        Pressure::Bad => [255, 59, 48],
        Pressure::Unknown => [142, 142, 147],
    };
    let center = DOT_SIZE as f32 / 2.;
    let mut pixels = vec![0u8; (DOT_SIZE * DOT_SIZE * 4) as usize];
    for y in 0..DOT_SIZE {
        for x in 0..DOT_SIZE {
            let distance =
                ((x as f32 + 0.5 - center).powi(2) + (y as f32 + 0.5 - center).powi(2)).sqrt();
            let outside = (RADIUS + 0.5 - distance).clamp(0., 1.);
            let coverage = if active {
                outside
            } else {
                outside.min((distance - (RADIUS - RING) + 0.5).clamp(0., 1.))
            };
            let index = ((y * DOT_SIZE + x) * 4) as usize;
            pixels[index..index + 4].copy_from_slice(&[red, green, blue, (coverage * 255.) as u8]);
        }
    }
    pixels
}

fn pressure_dot(pressure: Pressure, active: bool) -> Result<MenuIcon> {
    Ok(MenuIcon::from_rgba(
        dot_pixels(pressure, active),
        DOT_SIZE,
        DOT_SIZE,
    )?)
}

/// A gauge of three rising bars, drawn as a template image so macOS tints it for the menu bar.
fn icon() -> Result<Icon> {
    const SIZE: u32 = 36;
    let bars = [(6, 14, 16), (15, 23, 24), (24, 32, 32)];
    let mut pixels = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let filled = bars.iter().any(|&(left, right, height)| {
                x >= left && x < right && y >= SIZE - 2 - height && y < SIZE - 2
            });
            if filled {
                let index = ((y * SIZE + x) * 4) as usize;
                pixels[index..index + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    }
    Ok(Icon::from_rgba(pixels, SIZE, SIZE)?)
}

pub struct Tray {
    icon: TrayIcon,
    lines: Vec<Line>,
}

impl Tray {
    pub fn new(analytics: &AnalyticsSnapshot) -> Result<Self> {
        let lines = lines(analytics);
        let icon = TrayIconBuilder::new()
            .with_icon(icon()?)
            .with_icon_as_template(true)
            .with_tooltip("tokenmaxx")
            .with_menu(Box::new(build_menu(&lines)?))
            .build()?;
        Ok(Self { icon, lines })
    }

    pub fn update(&mut self, analytics: &AnalyticsSnapshot) {
        let next = lines(analytics);
        if next == self.lines {
            return;
        }
        if let Ok(menu) = build_menu(&next) {
            self.icon.set_menu(Some(Box::new(menu)));
            self.lines = next;
        }
    }
}

/// Forwards menu clicks, which arrive on AppKit's callback, into a channel the app drains on its own executor.
pub fn listen() -> smol::channel::Receiver<TrayCommand> {
    let (sender, receiver) = smol::channel::unbounded();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        if let Some(command) = TrayCommand::parse(&event.id.0) {
            sender.try_send(command).ok();
        }
    }));
    receiver
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_ids_round_trip() {
        for command in [
            TrayCommand::Switch(Provider::Anthropic, "0b8f-uuid".into()),
            TrayCommand::OpenAccounts,
            TrayCommand::OpenSettings,
            TrayCommand::Refresh,
            TrayCommand::Quit,
        ] {
            assert_eq!(TrayCommand::parse(&command.id()), Some(command));
        }
    }
}
