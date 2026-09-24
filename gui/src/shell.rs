use gpui_kit::component::{Root, TitleBar};
use gpui_kit::*;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

use crate::prefs::Presence;
use crate::store::{Store, StoreEvent};
use crate::tray::{self, Tray, TrayCommand};
use crate::views::root::{Page, RootView};

/// Owns the one main window, the menu bar item, and the Dock presence the preferences ask for.
pub struct Shell {
    store: Entity<Store>,
    window: Option<(WindowHandle<Root>, Entity<RootView>)>,
    tray: Option<Tray>,
    presence: Option<Presence>,
}

fn set_dock_visible(visible: bool) {
    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let policy = if visible {
        NSApplicationActivationPolicy::Regular
    } else {
        NSApplicationActivationPolicy::Accessory
    };
    NSApplication::sharedApplication(main_thread).setActivationPolicy(policy);
}

impl Shell {
    pub fn new(store: Entity<Store>, cx: &mut Context<Self>) -> Self {
        cx.observe(&store, |this, store, cx| {
            if let Some(tray) = this.tray.as_mut() {
                tray.update(&store.read(cx).analytics);
            }
        })
        .detach();
        cx.subscribe(&store, |this, _, event: &StoreEvent, cx| match event {
            StoreEvent::PreferencesChanged => this.apply_presence(cx),
            _ => {}
        })
        .detach();
        let commands = tray::listen();
        cx.spawn(async move |this, cx| {
            while let Ok(command) = commands.recv().await {
                if this.update(cx, |this, cx| this.run(command, cx)).is_err() {
                    return;
                }
            }
        })
        .detach();
        let mut shell = Self {
            store,
            window: None,
            tray: None,
            presence: None,
        };
        shell.apply_presence(cx);
        shell
    }

    fn apply_presence(&mut self, cx: &mut Context<Self>) {
        let presence = self.store.read(cx).preferences.presence;
        if self.presence == Some(presence) {
            return;
        }
        self.presence = Some(presence);
        set_dock_visible(presence.shows_dock());
        if presence.shows_menu_bar() && self.tray.is_none() {
            match Tray::new(&self.store.read(cx).analytics) {
                Ok(tray) => self.tray = Some(tray),
                Err(error) => self.store.update(cx, |_, cx| {
                    cx.emit(StoreEvent::Error(
                        format!("Menu bar item unavailable: {error}").into(),
                    ))
                }),
            }
        } else if !presence.shows_menu_bar() {
            self.tray = None;
        }
        cx.activate(true);
    }

    pub fn open(&mut self, page: Page, cx: &mut Context<Self>) {
        cx.activate(true);
        if let Some((handle, root)) = self.window.clone() {
            let shown = handle
                .update(cx, |_, window, _| window.activate_window())
                .is_ok();
            if shown {
                root.update(cx, |root, cx| root.show(page, cx));
                return;
            }
        }
        let store = self.store.clone();
        let options = WindowOptions {
            titlebar: Some(TitleBar::title_bar_options()),
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(1000.), px(720.)),
                cx,
            ))),
            window_min_size: Some(size(px(780.), px(520.))),
            ..Default::default()
        };
        let mut created = None;
        let handle = cx.open_window(options, |window, cx| {
            let root = cx.new(|cx| RootView::new(store, page, window, cx));
            created = Some(root.clone());
            cx.new(|cx| Root::new(root, window, cx))
        });
        match (handle, created) {
            (Ok(handle), Some(root)) => self.window = Some((handle, root)),
            (Err(error), _) => eprintln!("tokenmaxx: could not open the window: {error}"),
            _ => {}
        }
    }

    fn run(&mut self, command: TrayCommand, cx: &mut Context<Self>) {
        match command {
            TrayCommand::Switch(provider, account) => self
                .store
                .update(cx, |store, cx| store.switch(provider, account, cx)),
            TrayCommand::OpenAccounts => self.open(Page::Accounts, cx),
            TrayCommand::OpenSettings => self.open(Page::Settings, cx),
            TrayCommand::Refresh => self.store.update(cx, |store, cx| store.refresh(cx)),
            TrayCommand::Quit => cx.quit(),
        }
    }
}
