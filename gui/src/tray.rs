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

/// The live menu item behind each line, kept so a poll can patch text in place.
enum Item {
    Text(MenuItem),
    Account(IconMenuItem),
    Fixed,
}

fn build_menu(lines: &[Line]) -> Result<(Menu, Vec<Item>)> {
    let menu = Menu::new();
    let mut items = Vec::with_capacity(lines.len());
    for line in lines {
        match line {
            Line::Heading(text) | Line::Note(text) => {
                let item = MenuItem::new(text, false, None);
                menu.append(&item)?;
                items.push(Item::Text(item));
            }
            Line::Account {
                command,
                text,
                active,
                pressure,
            } => {
                let item = IconMenuItem::with_id(
                    command.id(),
                    text,
                    true,
                    Some(pressure_dot(*pressure, *active)?),
                    None,
                );
                menu.append(&item)?;
                items.push(Item::Account(item));
            }
            Line::Command(command, text) => {
                menu.append(&MenuItem::with_id(command.id(), text, true, None))?;
                items.push(Item::Fixed);
            }
            Line::Separator => {
                menu.append(&PredefinedMenuItem::separator())?;
                items.push(Item::Fixed);
            }
        }
    }
    Ok((menu, items))
}

/// Whether two lines can share one menu item: same kind, and the same command behind a clickable line.
fn same_slot(current: &Line, next: &Line) -> bool {
    match (current, next) {
        (Line::Heading(_), Line::Heading(_))
        | (Line::Note(_), Line::Note(_))
        | (Line::Separator, Line::Separator) => true,
        (Line::Account { command: a, .. }, Line::Account { command: b, .. }) => a == b,
        (Line::Command(a, _), Line::Command(b, _)) => a == b,
        _ => false,
    }
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

/// The tokenmaxx mark as a menu-bar template: Rubric's 5×5 grid, a one-cell ring around a 3×3
/// rising staircase cut out of the tile, cell edges snapped to whole pixels so it stays crisp.
fn icon_pixels() -> Vec<u8> {
    const SIZE: u32 = 36;
    const EDGES: [u32; 6] = [0, 7, 14, 22, 29, 36];
    const GLYPH: [[bool; 3]; 3] = [
        [false, false, true],
        [false, true, true],
        [true, true, true],
    ];
    let radius = 0.78 * SIZE as f32 / 5.;
    let cell = |value: u32| {
        EDGES
            .windows(2)
            .position(|edge| value >= edge[0] && value < edge[1])
            .unwrap_or(0)
    };
    let mut pixels = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (column, row) = (cell(x), cell(y));
            if (1..=3).contains(&column) && (1..=3).contains(&row) && GLYPH[row - 1][column - 1] {
                continue;
            }
            let (left, top) = (x as f32 + 0.5, y as f32 + 0.5);
            let nearest_x = left.clamp(radius, SIZE as f32 - radius);
            let nearest_y = top.clamp(radius, SIZE as f32 - radius);
            let corner = ((left - nearest_x).powi(2) + (top - nearest_y).powi(2)).sqrt();
            let coverage = (radius + 0.5 - corner.max(radius - 0.5)).clamp(0., 1.);
            let index = ((y * SIZE + x) * 4) as usize;
            pixels[index + 3] = (coverage * 255.) as u8;
        }
    }
    pixels
}

fn icon() -> Result<Icon> {
    Ok(Icon::from_rgba(icon_pixels(), 36, 36)?)
}

pub struct Tray {
    icon: TrayIcon,
    lines: Vec<Line>,
    items: Vec<Item>,
}

impl Tray {
    pub fn new(analytics: &AnalyticsSnapshot) -> Result<Self> {
        let lines = lines(analytics);
        let (menu, items) = build_menu(&lines)?;
        let icon = TrayIconBuilder::new()
            .with_icon(icon()?)
            .with_icon_as_template(true)
            .with_tooltip("tokenmaxx")
            .with_menu(Box::new(menu))
            .build()?;
        Ok(Self { icon, lines, items })
    }

    /// Patches the open menu in place when only its text changed; swapping in a new menu would
    /// dismiss it from under the pointer on every poll.
    pub fn update(&mut self, analytics: &AnalyticsSnapshot) {
        let next = lines(analytics);
        if next == self.lines {
            return;
        }
        let same_shape = next.len() == self.lines.len()
            && self
                .lines
                .iter()
                .zip(&next)
                .all(|(current, next)| same_slot(current, next));
        if !same_shape {
            if let Ok((menu, items)) = build_menu(&next) {
                self.icon.set_menu(Some(Box::new(menu)));
                self.lines = next;
                self.items = items;
            }
            return;
        }
        for ((current, line), item) in self.lines.iter().zip(&next).zip(&self.items) {
            if current == line {
                continue;
            }
            match (line, item) {
                (Line::Heading(text) | Line::Note(text), Item::Text(entry)) => entry.set_text(text),
                (
                    Line::Account {
                        text,
                        active,
                        pressure,
                        ..
                    },
                    Item::Account(entry),
                ) => {
                    entry.set_text(text);
                    entry.set_icon(pressure_dot(*pressure, *active).ok());
                }
                _ => {}
            }
        }
        self.lines = next;
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

    #[test]
    fn a_changed_number_patches_the_open_menu_but_a_new_order_rebuilds_it() {
        let account = |id: &str, text: &str| Line::Account {
            active: false,
            command: TrayCommand::Switch(Provider::Openai, id.into()),
            pressure: Pressure::Good,
            text: text.into(),
        };
        assert!(same_slot(&account("a", "5h 10%"), &account("a", "5h 64%")));
        assert!(same_slot(
            &Line::Note("1M/h now".into()),
            &Line::Note("2M/h now".into())
        ));
        assert!(!same_slot(&account("a", "5h 10%"), &account("b", "5h 10%")));
        assert!(!same_slot(&Line::Note("1M/h".into()), &Line::Separator));
    }
}
