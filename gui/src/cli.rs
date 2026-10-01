use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;

use anyhow::{Context as _, Result, bail};

const SYMLINK: &str = "/usr/local/bin/tokenmaxx";

/// The `tokenmaxx` binary shipped inside the app bundle; `TOKENMAXX_BIN` points at a dev build.
pub fn bundled_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("TOKENMAXX_BIN") {
        return std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(path));
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("Resources/bin/tokenmaxx")))
        .unwrap_or_else(|| PathBuf::from("tokenmaxx"))
}

const MARKER: &str = "__tokenmaxx__";

fn login_shell(script: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let wrapped = format!("printf '{MARKER}%s{MARKER}' \"$({script})\"");
    let output = Command::new(shell).args(["-lic", &wrapped]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let (_, rest) = text.split_once(MARKER)?;
    let (value, _) = rest.split_once(MARKER)?;
    Some(value.trim().to_string()).filter(|value| !value.is_empty())
}

/// Apps launched from Finder get a bare PATH; the daemon needs the user's to find bun, codex, claude, and pi.
pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        login_shell("printf %s \"$PATH\"")
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_else(|| "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin".into())
    })
}

fn run(binary: &Path, arguments: &[&str]) -> Result<Output> {
    let output = Command::new(binary)
        .args(arguments)
        .env("PATH", login_path())
        .output()
        .with_context(|| format!("could not run {}", binary.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("{}", stderr.trim().trim_start_matches("tokenmaxx: "));
    }
    Ok(output)
}

/// `None` for builds from before `--version`, which answer with an unknown-command error.
fn version_of(binary: &Path) -> Option<String> {
    let output = run(binary, &["--version"]).ok()?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    version
        .starts_with(|c: char| c.is_ascii_digit())
        .then_some(version)
}

/// Semver order for `major.minor.patch[-prerelease]`; a prerelease sorts before its release.
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let parse = |version: &str| {
        let (release, prerelease) = version.split_once('-').unwrap_or((version, ""));
        let numbers: Vec<u64> = release
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect();
        (numbers, prerelease.is_empty())
    };
    parse(left).cmp(&parse(right))
}

#[derive(Clone, Debug, PartialEq)]
pub enum CommandLineTool {
    /// `tokenmaxx` in the terminal is this app's own binary.
    Bundled,
    /// The user's installed `tokenmaxx` is at least as new as the app's, so the app drives it.
    Shared {
        path: String,
    },
    /// The installed `tokenmaxx` is older; the app runs its own until the user updates.
    Outdated {
        path: String,
        version: Option<String>,
    },
    Missing,
}

/// The one `tokenmaxx` the app starts the daemon with and runs sign-in through.
#[derive(Clone, Debug, PartialEq)]
pub struct Runtime {
    pub binary: PathBuf,
    pub version: String,
    pub bundled_version: String,
    pub tool: CommandLineTool,
}

/// Prefers the user's installed `tokenmaxx` whenever it is at least as new as the bundled one,
/// so the terminal and the app never restart the shared daemon on two different versions.
pub fn resolve() -> Result<Runtime> {
    let bundled = bundled_binary();
    let bundled_version = version_of(&bundled)
        .with_context(|| format!("{} did not report a version", bundled.display()))?;
    let own = |tool| Runtime {
        binary: bundled.clone(),
        version: bundled_version.clone(),
        bundled_version: bundled_version.clone(),
        tool,
    };
    let Some(found) = login_shell("command -v tokenmaxx") else {
        return Ok(own(CommandLineTool::Missing));
    };
    let installed = PathBuf::from(&found);
    if std::fs::canonicalize(&installed).is_ok_and(|resolved| resolved == bundled) {
        return Ok(own(CommandLineTool::Bundled));
    }
    match version_of(&installed) {
        Some(version) if compare_versions(&version, &bundled_version) != Ordering::Less => {
            Ok(Runtime {
                binary: installed,
                version,
                bundled_version,
                tool: CommandLineTool::Shared { path: found },
            })
        }
        version => Ok(own(CommandLineTool::Outdated {
            path: found,
            version,
        })),
    }
}

/// Starts the daemon, or replaces one another tokenmaxx version started.
pub fn start_daemon(binary: &Path) -> Result<()> {
    run(binary, &["daemon", "start"]).map(|_| ())
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// Links `/usr/local/bin/tokenmaxx` to the bundled binary, asking for an administrator password.
pub fn install_command_line_tool() -> Result<()> {
    let command = format!(
        "mkdir -p /usr/local/bin && ln -sf {} {SYMLINK}",
        shell_quote(&bundled_binary())
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = Command::new("osascript").args(["-e", &script]).output()?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

/// The package-manager command that brings an installed `tokenmaxx` up to `version`.
pub fn update_command(installed_path: &str, version: &str) -> Vec<String> {
    let package = format!("tokenmaxx@{version}");
    if installed_path.contains("/.bun/") {
        vec!["bun".into(), "add".into(), "-g".into(), package]
    } else {
        vec!["npm".into(), "install".into(), "-g".into(), package]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_order_like_semver() {
        assert_eq!(compare_versions("0.0.67", "0.0.66"), Ordering::Greater);
        assert_eq!(compare_versions("0.0.66", "0.0.66"), Ordering::Equal);
        assert_eq!(compare_versions("0.0.9", "0.0.10"), Ordering::Less);
        assert_eq!(compare_versions("0.0.67-alpha.3", "0.0.67"), Ordering::Less);
        assert_eq!(
            compare_versions("0.0.67-alpha.3", "0.0.66"),
            Ordering::Greater
        );
    }

    #[test]
    fn updates_with_the_manager_that_installed_it() {
        assert_eq!(
            update_command("/Users/me/.bun/bin/tokenmaxx", "0.0.70")[0],
            "bun"
        );
        assert_eq!(
            update_command("/opt/homebrew/bin/tokenmaxx", "0.0.70")[0],
            "npm"
        );
    }
}
