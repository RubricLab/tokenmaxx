mod cli;
mod format;
mod ipc;
mod model;
mod prefs;
mod shell;
mod store;
mod terminal;
mod tray;
mod views;

use gpui_kit::*;

use crate::shell::Shell;
use crate::store::Store;
use crate::views::root::Page;

gpui_kit::actions!(tokenmaxx, [Quit, CloseWindow]);

struct MainShell(Entity<Shell>);

impl Global for MainShell {}

fn open(page: Page, cx: &mut App) {
    if let Some(MainShell(shell)) = cx
        .try_global::<MainShell>()
        .map(|global| MainShell(global.0.clone()))
    {
        shell.update(cx, |shell, cx| shell.open(page, cx));
    }
}

fn main() {
    let application = gpui_kit::application().with_assets(gpui_kit::assets::AllAssets);
    application.on_reopen(|cx| open(Page::Accounts, cx));
    application.run(|cx| {
        gpui_kit::init(cx);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-w", CloseWindow, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &CloseWindow, cx| {
            if let Some(window) = cx.active_window() {
                window
                    .update(cx, |_, window, _| window.remove_window())
                    .ok();
            }
        });
        cx.set_menus([Menu {
            name: "tokenmaxx".into(),
            items: vec![MenuItem::action("Quit tokenmaxx", Quit)],
            disabled: false,
        }]);

        let store = cx.new(Store::new);
        let shell = cx.new(|cx| Shell::new(store, cx));
        cx.set_global(MainShell(shell));
        open(Page::Accounts, cx);
    });
}
