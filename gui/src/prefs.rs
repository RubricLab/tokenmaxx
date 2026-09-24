use serde::{Deserialize, Serialize};

use crate::ipc::tokenmaxx_home;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
    #[default]
    Auto,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Presence {
    #[default]
    MenuBarAndDock,
    MenuBar,
    Dock,
}

impl Presence {
    pub fn shows_menu_bar(self) -> bool {
        self != Presence::Dock
    }

    pub fn shows_dock(self) -> bool {
        self != Presence::MenuBar
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub appearance: Appearance,
    pub presence: Presence,
    /// Bundle identifier of the terminal for sign-in; `None` picks the first installed one.
    pub terminal: Option<String>,
}

fn path() -> std::path::PathBuf {
    tokenmaxx_home().join("gui.json")
}

pub fn load() -> Preferences {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(preferences: &Preferences) -> anyhow::Result<()> {
    std::fs::create_dir_all(tokenmaxx_home())?;
    std::fs::write(path(), serde_json::to_string_pretty(preferences)? + "\n")?;
    Ok(())
}
