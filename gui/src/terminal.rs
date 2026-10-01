use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::Command;

use anyhow::{Result, bail};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::NSString;

use crate::cli;
use crate::ipc::tokenmaxx_home;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terminal {
    pub bundle_id: &'static str,
    pub name: &'static str,
    launch: Launch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Launch {
    OpenDocument,
    Execute,
    Argument,
    WezTerm,
}

/// Preference order for "Automatic"; Terminal.app ships with macOS and closes the list.
pub const TERMINALS: [Terminal; 6] = [
    Terminal {
        bundle_id: "com.mitchellh.ghostty",
        name: "Ghostty",
        launch: Launch::Execute,
    },
    Terminal {
        bundle_id: "com.googlecode.iterm2",
        name: "iTerm",
        launch: Launch::OpenDocument,
    },
    Terminal {
        bundle_id: "com.github.wez.wezterm",
        name: "WezTerm",
        launch: Launch::WezTerm,
    },
    Terminal {
        bundle_id: "net.kovidgoyal.kitty",
        name: "kitty",
        launch: Launch::Argument,
    },
    Terminal {
        bundle_id: "org.alacritty",
        name: "Alacritty",
        launch: Launch::Execute,
    },
    Terminal {
        bundle_id: "com.apple.Terminal",
        name: "Terminal",
        launch: Launch::OpenDocument,
    },
];

fn installed(terminal: &Terminal) -> bool {
    let workspace = NSWorkspace::sharedWorkspace();
    let identifier = NSString::from_str(terminal.bundle_id);
    workspace
        .URLForApplicationWithBundleIdentifier(&identifier)
        .is_some()
}

pub fn installed_terminals() -> Vec<Terminal> {
    TERMINALS.iter().copied().filter(installed).collect()
}

/// The preferred terminal when it is installed, otherwise the first installed one in `TERMINALS` order.
pub fn resolve(preferred: Option<&str>) -> Terminal {
    let available = installed_terminals();
    preferred
        .and_then(|id| available.iter().find(|terminal| terminal.bundle_id == id))
        .or(available.first())
        .copied()
        .unwrap_or(TERMINALS[TERMINALS.len() - 1])
}

fn single_quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

fn write_script(name: &str, command: &[String]) -> Result<std::path::PathBuf> {
    let directory = tokenmaxx_home().join("runtime");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("gui-{name}.command"));
    let command = command
        .iter()
        .map(|part| single_quoted(part))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "#!/bin/sh\nexport PATH={}\nclear\n{command}\nprintf '\\nPress return to close. '\nread _\n",
        single_quoted(cli::login_path())
    );
    std::fs::write(&path, script)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    Ok(path)
}

fn open_arguments(terminal: &Terminal, script: &Path) -> Vec<String> {
    let script = script.display().to_string();
    let name = terminal.name.to_string();
    match terminal.launch {
        Launch::OpenDocument => vec!["-a".into(), name, script],
        Launch::Execute => vec!["-na".into(), name, "--args".into(), "-e".into(), script],
        Launch::Argument => vec!["-na".into(), name, "--args".into(), script],
        Launch::WezTerm => {
            vec![
                "-na".into(),
                name,
                "--args".into(),
                "start".into(),
                "--".into(),
                script,
            ]
        }
    }
}

/// Runs `command` in a new terminal window, where interactive sign-in has a TTY.
pub fn run_in_terminal(terminal: Terminal, name: &str, command: &[String]) -> Result<()> {
    let script = write_script(name, command)?;
    let status = Command::new("open")
        .args(open_arguments(&terminal, &script))
        .status()?;
    if !status.success() {
        bail!("could not open {}", terminal.name);
    }
    Ok(())
}
