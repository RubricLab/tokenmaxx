use gpui_kit::assets::IconName;
use gpui_kit::component::StyledExt as _;
use gpui_kit::component::notification::Notification;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::sidebar::{Sidebar, SidebarGroup, SidebarMenu, SidebarMenuItem};
use gpui_kit::component::{
    ActiveTheme as _, Icon, Root, Theme, ThemeMode, TitleBar, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::*;

use crate::prefs::Appearance;
use crate::store::{Store, StoreEvent};
use crate::views::accounts::AccountsPage;
use crate::views::analytics::AnalyticsPage;
use crate::views::settings::SettingsPage;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Accounts,
    Analytics,
    Settings,
}

pub struct RootView {
    store: Entity<Store>,
    page: Page,
    accounts: Entity<AccountsPage>,
    analytics: Entity<AnalyticsPage>,
    settings: Entity<SettingsPage>,
    _subscriptions: Vec<Subscription>,
}

pub fn apply_appearance(appearance: Appearance, window: &mut Window, cx: &mut App) {
    match appearance {
        Appearance::Auto => Theme::sync_system_appearance(Some(window), cx),
        Appearance::Light => Theme::change(ThemeMode::Light, Some(window), cx),
        Appearance::Dark => Theme::change(ThemeMode::Dark, Some(window), cx),
    }
}

impl RootView {
    pub fn new(
        store: Entity<Store>,
        page: Page,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        apply_appearance(store.read(cx).preferences.appearance, window, cx);
        let subscriptions = vec![
            cx.subscribe_in(
                &store,
                window,
                |_, store, event: &StoreEvent, window, cx| match event {
                    StoreEvent::Notice(message) => {
                        window.push_notification(Notification::success(message.clone()), cx)
                    }
                    StoreEvent::Error(message) => {
                        window.push_notification(Notification::error(message.clone()), cx)
                    }
                    StoreEvent::PreferencesChanged => {
                        apply_appearance(store.read(cx).preferences.appearance, window, cx)
                    }
                },
            ),
            cx.observe_window_appearance(window, |this, window, cx| {
                if this.store.read(cx).preferences.appearance == Appearance::Auto {
                    Theme::sync_system_appearance(Some(window), cx);
                }
            }),
        ];
        Self {
            accounts: cx.new(|cx| AccountsPage::new(store.clone(), cx)),
            analytics: cx.new(|cx| AnalyticsPage::new(store.clone(), cx)),
            settings: cx.new(|cx| SettingsPage::new(store.clone(), window, cx)),
            store,
            page,
            _subscriptions: subscriptions,
        }
    }

    pub fn show(&mut self, page: Page, cx: &mut Context<Self>) {
        self.page = page;
        cx.notify();
    }

    fn menu_item(
        &self,
        page: Page,
        label: &'static str,
        icon: IconName,
        cx: &mut Context<Self>,
    ) -> SidebarMenuItem {
        SidebarMenuItem::new(label)
            .icon(Icon::new(icon))
            .active(self.page == page)
            .on_click(cx.listener(move |this, _, _, cx| this.show(page, cx)))
    }
}

impl Render for RootView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content: AnyView = match self.page {
            Page::Accounts => self.accounts.clone().into(),
            Page::Analytics => self.analytics.clone().into(),
            Page::Settings => self.settings.clone().into(),
        };
        let busy = self.store.read(cx).busy.clone();
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                TitleBar::new().child(
                    h_flex()
                        .flex_1()
                        .justify_between()
                        .pr_3()
                        .child(div().text_sm().font_semibold().child("tokenmaxx"))
                        .children(busy.map(|busy| {
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(busy)
                        })),
                ),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .child(Sidebar::new("navigation").w(px(200.)).child(
                        SidebarGroup::new("tokenmaxx").child(SidebarMenu::new().children([
                            self.menu_item(Page::Accounts, "Accounts", IconName::Users, cx),
                            self.menu_item(Page::Analytics, "Analytics", IconName::ChartArea, cx),
                            self.menu_item(Page::Settings, "Settings", IconName::Settings, cx),
                        ])),
                    ))
                    .child(
                        div().flex_1().min_w_0().h_full().child(
                            div()
                                .id("content")
                                .size_full()
                                .overflow_y_scrollbar()
                                .child(div().p_6().max_w(px(960.)).child(content)),
                        ),
                    ),
            )
            .children(Root::render_dialog_layer(window, cx))
            .children(Root::render_notification_layer(window, cx))
    }
}
