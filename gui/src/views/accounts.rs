use chrono::{DateTime, Utc};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::component::{Disableable as _, StyledExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::format::{self, Pressure};
use crate::model::{
    Account, AuthKind, DashboardSnapshot, OnThreshold, Provider, RoutingTarget, UsageWindow,
};
use crate::store::{Connection, Store};
use crate::views::{dialogs, muted, page_header, pressure_color, section_title};

const RECENT_SWITCH_SECONDS: i64 = 120;
const WINDOWS_PER_ROW: usize = 3;

pub struct AccountsPage {
    store: Entity<Store>,
}

impl AccountsPage {
    pub fn new(store: Entity<Store>, cx: &mut Context<Self>) -> Self {
        cx.observe(&store, |_, _, cx| cx.notify()).detach();
        Self { store }
    }
}

fn window_meter(window: &UsageWindow, now: DateTime<Utc>, cx: &App) -> Div {
    let color = pressure_color(format::pressure(Some(window.used_percent)), cx);
    let reset = format::short_reset(window.reset_at.as_deref(), now)
        .map(|reset| format!("resets in {reset}"))
        .unwrap_or_default();
    v_flex()
        .w_32()
        .flex_shrink_0()
        .gap_1()
        .child(
            h_flex()
                .justify_between()
                .text_xs()
                .child(
                    div()
                        .text_color(cx.theme().muted_foreground)
                        .child(format::short_window(&window.label)),
                )
                .child(
                    div()
                        .text_color(color)
                        .child(format::percent_label(Some(window.used_percent))),
                ),
        )
        .child(
            Progress::new(SharedString::from(format!("meter-{}", window.id)))
                .value(format::clamp_percent(window.used_percent) as f32)
                .color(color),
        )
        .child(muted(reset, cx))
}

fn extra_usage_cell(snapshot: &DashboardSnapshot, account: &Account, cx: &App) -> Option<Div> {
    let extra = snapshot.usage(&account.id)?.extra_usage.as_ref()?;
    if !extra.enabled || account.auth == AuthKind::ApiKey {
        return None;
    }
    let value = extra
        .used_percent
        .map(|percent| format::percent_label(Some(percent)))
        .or(extra.balance_usd.map(format::money_usd))
        .or(extra.spent_usd.map(format::money_usd))
        .unwrap_or_else(|| "On".into());
    let color = pressure_color(format::pressure(extra.used_percent), cx);
    let title = if account.on_threshold == OnThreshold::Spill {
        "Extra · spills"
    } else {
        "Extra usage"
    };
    Some(
        v_flex()
            .w_24()
            .flex_shrink_0()
            .gap_1()
            .child(muted(title, cx))
            .child(div().text_sm().text_color(color).child(value)),
    )
}

impl AccountsPage {
    fn account_row(
        &self,
        snapshot: &DashboardSnapshot,
        account: &Account,
        now: DateTime<Utc>,
        busy: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let state = snapshot.state(account.provider);
        let active =
            state.and_then(|state| state.active_account_id.as_deref()) == Some(account.id.as_str());
        let just_switched = active
            && state
                .and_then(|state| state.switched_at.as_deref())
                .and_then(format::parse_time)
                .is_some_and(|at| (now - at).num_seconds() < RECENT_SWITCH_SECONDS);
        let usage = snapshot.usage(&account.id);
        let credits = usage
            .and_then(|usage| usage.reset_credits.as_ref())
            .filter(|credits| credits.available > 0);
        let extra_enabled = usage
            .and_then(|usage| usage.extra_usage.as_ref())
            .is_some_and(|extra| extra.enabled)
            && account.auth != AuthKind::ApiKey;

        let mut details: Vec<AnyElement> = Vec::new();
        if let Some(plan) = format::plan_label(account.plan.as_deref()) {
            details.push(Tag::secondary().small().child(plan).into_any_element());
        }
        if account.auth == AuthKind::ApiKey {
            details.push(Tag::secondary().small().child("API key").into_any_element());
        }
        if let Some(credits) = credits {
            let tag = if credits.applicable > 0 {
                Tag::success()
            } else {
                Tag::secondary()
            };
            details.push(
                tag.small()
                    .child(format!(
                        "{} reset{}",
                        credits.available,
                        if credits.available == 1 { "" } else { "s" }
                    ))
                    .into_any_element(),
            );
        }
        if let Some(badge) = format::health_badge(account.health) {
            let tag = match badge.pressure {
                Pressure::Bad => Tag::danger(),
                Pressure::Warn => Tag::warning(),
                _ => Tag::secondary(),
            };
            details.push(tag.small().child(badge.text).into_any_element());
        }
        if just_switched {
            details.push(
                Tag::info()
                    .small()
                    .child("Just switched")
                    .into_any_element(),
            );
        }

        let windows = format::account_windows(snapshot, account);
        let meters: AnyElement = if account.auth == AuthKind::ApiKey {
            let spend = usage
                .and_then(|usage| usage.measured_spend_usd)
                .unwrap_or_default();
            v_flex()
                .w_32()
                .gap_1()
                .child(muted("Spend · 31 days", cx))
                .child(div().text_sm().child(format::money_usd(spend)))
                .into_any_element()
        } else if windows.is_empty() {
            muted("No limits reported yet", cx).into_any_element()
        } else {
            h_flex()
                .gap_4()
                .children(
                    windows
                        .iter()
                        .take(WINDOWS_PER_ROW)
                        .map(|usage_window| window_meter(usage_window, now, cx)),
                )
                .into_any_element()
        };

        let store = self.store.clone();
        let provider = account.provider;
        let id = account.id.clone();
        let primary: AnyElement = if account.health.needs_login() {
            Button::new(SharedString::from(format!("relogin-{id}")))
                .small()
                .label("Sign in again")
                .disabled(busy)
                .on_click(
                    window.listener_for(&store, move |store, _, _, cx| store.sign_in(provider, cx)),
                )
                .into_any_element()
        } else if active {
            div().w_16().into_any_element()
        } else {
            let target = id.clone();
            Button::new(SharedString::from(format!("use-{id}")))
                .small()
                .outline()
                .label("Use")
                .disabled(busy)
                .on_click(window.listener_for(&store, move |store, _, _, cx| {
                    store.switch(provider, target.clone(), cx)
                }))
                .into_any_element()
        };

        let account_for_menu = account.clone();
        let has_credits = credits.is_some();
        let menu_store = store.clone();
        let more = Button::new(SharedString::from(format!("more-{id}")))
            .small()
            .ghost()
            .icon(Icon::new(IconName::Ellipsis))
            .disabled(busy)
            .dropdown_menu(move |menu, window, _| {
                let account = account_for_menu.clone();
                let mut menu = menu.min_w(px(200.));
                if !active && !account.health.needs_login() {
                    let target = account.id.clone();
                    menu = menu.item(PopupMenuItem::new("Use this account").on_click(
                        window.listener_for(&menu_store, move |store, _, _, cx| {
                            store.switch(account.provider, target.clone(), cx)
                        }),
                    ));
                }
                if has_credits {
                    let store = menu_store.clone();
                    let account = account.clone();
                    menu = menu.item(PopupMenuItem::new("Reset a window…").on_click(
                        move |_, window, cx| {
                            dialogs::open_reset_credits(store.clone(), account.clone(), window, cx)
                        },
                    ));
                }
                if extra_enabled {
                    let spill = account.on_threshold == OnThreshold::Spill;
                    let toggled = Account {
                        on_threshold: if spill {
                            OnThreshold::Switch
                        } else {
                            OnThreshold::Spill
                        },
                        ..account.clone()
                    };
                    menu = menu.item(
                        PopupMenuItem::new("Spill into extra usage at the threshold")
                            .checked(spill)
                            .on_click(window.listener_for(&menu_store, move |store, _, _, cx| {
                                let toggled = toggled.clone();
                                store.perform(
                                    "Saving…",
                                    async move { crate::ipc::save_account(&toggled).await },
                                    |_, _, _| {},
                                    cx,
                                )
                            })),
                    );
                }
                if account.auth == AuthKind::Oauth {
                    menu = menu.item(PopupMenuItem::new("Sign in again").on_click(
                        window.listener_for(&menu_store, move |store, _, _, cx| {
                            store.sign_in(account.provider, cx)
                        }),
                    ));
                }
                let store = menu_store.clone();
                menu.separator()
                    .item(
                        PopupMenuItem::new("Sign out…").on_click(move |_, window, cx| {
                            dialogs::open_sign_out(store.clone(), account.clone(), window, cx)
                        }),
                    )
            });

        h_flex()
            .id(SharedString::from(format!("row-{}", account.id)))
            .gap_4()
            .px_4()
            .py_3()
            .items_center()
            .child(
                div()
                    .w_4()
                    .flex_shrink_0()
                    .flex()
                    .justify_center()
                    .when(active, |this| {
                        this.child(div().size_2().rounded_full().bg(cx.theme().success))
                    }),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_1()
                    .child(
                        div()
                            .text_sm()
                            .truncate()
                            .when(active, |this| this.font_semibold())
                            .child(account.label.clone()),
                    )
                    .child(h_flex().gap_1().flex_wrap().children(details)),
            )
            .child(meters)
            .children(extra_usage_cell(snapshot, account, cx))
            .child(
                h_flex()
                    .gap_1()
                    .w_24()
                    .justify_end()
                    .flex_shrink_0()
                    .child(primary)
                    .child(more),
            )
    }

    fn provider_section(
        &self,
        provider: Provider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let store = self.store.read(cx);
        let snapshot = store.analytics.snapshot.clone();
        let routed = store.routing.routed.get(provider);
        let cli_present = store.routing.clis.get(provider);
        let busy = store.is_busy();
        let now = Utc::now();
        let policy = snapshot.state(provider).map(|state| state.policy.clone());

        let status = if !routed {
            Tag::warning().small().child("Off")
        } else if let Some(policy) = policy.as_ref().filter(|policy| policy.enabled) {
            Tag::success()
                .small()
                .child(format!("Auto-switch at {}%", policy.threshold_percent))
        } else {
            Tag::secondary().small().child("Auto-switch off")
        };

        let session = snapshot.active_account(provider).and_then(|account| {
            snapshot
                .usage(&account.id)?
                .windows
                .iter()
                .find(|window| format::is_five_hour_window(window))
                .and_then(|window| format::short_reset(window.reset_at.as_deref(), now))
                .map(|reset| format!("{} · session resets in {reset}", account.label))
        });

        let accounts = format::ordered_accounts(&snapshot, provider);
        let rows: Vec<AnyElement> = accounts
            .iter()
            .enumerate()
            .map(|(index, account)| {
                div()
                    .when(index > 0, |this| {
                        this.border_t_1().border_color(cx.theme().border)
                    })
                    .child(self.account_row(&snapshot, account, now, busy, window, cx))
                    .into_any_element()
            })
            .collect();

        let entity = self.store.clone();
        let add = Button::new(SharedString::from(format!("add-{}", provider.cli())))
            .small()
            .icon(Icon::new(IconName::Plus))
            .label("Add account")
            .disabled(busy)
            .on_click(move |_, window, cx| {
                dialogs::open_add_account(entity.clone(), provider, cli_present, window, cx)
            });

        let turn_on_store = self.store.clone();
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(section_title(provider.title(), cx))
                    .child(status)
                    .child(div().flex_1())
                    .child(add),
            )
            .when(!routed, |this| {
                this.child(
                    h_flex()
                        .gap_3()
                        .px_4()
                        .py_2()
                        .items_center()
                        .rounded(cx.theme().radius)
                        .bg(cx.theme().warning.opacity(0.12))
                        .child(Icon::new(IconName::TriangleAlert).text_color(cx.theme().warning))
                        .child(div().flex_1().text_sm().child(format!(
                            "tokenmaxx is off for {}. It talks straight to the provider with its own login.",
                            provider.cli()
                        )))
                        .child(
                            Button::new(SharedString::from(format!("route-{}", provider.cli())))
                                .small()
                                .label("Turn on")
                                .disabled(busy)
                                .on_click(window.listener_for(&turn_on_store, move |store, _, _, cx| {
                                    store.set_routing(RoutingTarget::from(provider), true, cx)
                                })),
                        ),
                )
            })
            .child(
                v_flex()
                    .rounded(cx.theme().radius_lg)
                    .border_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().group_box)
                    .when(rows.is_empty(), |this| {
                        this.child(
                            div().px_4().py_3().child(muted(
                                if cli_present {
                                    format!("No {} accounts yet.", provider.title())
                                } else {
                                    format!("Install {} to sign in, or add an API key.", provider.cli())
                                },
                                cx,
                            )),
                        )
                    })
                    .children(rows),
            )
            .children(session.map(|session| muted(session, cx)))
    }
}

impl Render for AccountsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let store = self.store.read(cx);
        let age = store
            .analytics
            .snapshot
            .usage
            .iter()
            .filter_map(|usage| format::parse_time(&usage.observed_at))
            .max()
            .map(|observed| format!("Updated {} ago", format::relative_age(observed, Utc::now())));
        let refreshing = store.busy.as_deref() == Some("Refreshing…");
        let busy = store.is_busy();
        let connection = store.connection.clone();
        let refresh_store = self.store.clone();

        v_flex()
            .gap_6()
            .child(page_header(
                "Accounts",
                h_flex()
                    .gap_3()
                    .items_center()
                    .children(age.map(|age| muted(age, cx)))
                    .child(
                        Button::new("refresh")
                            .small()
                            .icon(Icon::new(IconName::RefreshCw))
                            .label("Refresh")
                            .loading(refreshing)
                            .disabled(busy)
                            .on_click(
                                window.listener_for(&refresh_store, |store, _, _, cx| {
                                    store.refresh(cx)
                                }),
                            ),
                    ),
            ))
            .when_some(
                match connection {
                    Connection::Failed(message) => Some(message),
                    _ => None,
                },
                |this, message| this.child(muted(format!("Not connected: {message}"), cx)),
            )
            .child(self.provider_section(Provider::Openai, window, cx))
            .child(self.provider_section(Provider::Anthropic, window, cx))
    }
}
