use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::Button;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::tab::TabBar;
use gpui_kit::component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::json;

use crate::cli::CommandLineTool;
use crate::format;
use crate::model::{Provider, RoutingTarget};
use crate::prefs::{Appearance, Preferences, Presence};
use crate::store::Store;
use crate::terminal;
use crate::views::{muted, page_header, section_title};

const MINUTE: f32 = 60_000.0;

struct PolicySliders {
    threshold: Entity<SliderState>,
    cooldown: Entity<SliderState>,
}

pub struct SettingsPage {
    store: Entity<Store>,
    sliders: [PolicySliders; 2],
    _subscriptions: Vec<Subscription>,
}

fn slot(provider: Provider) -> usize {
    match provider {
        Provider::Openai => 0,
        Provider::Anthropic => 1,
    }
}

impl SettingsPage {
    pub fn new(store: Entity<Store>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let sliders = Provider::ALL.map(|_| PolicySliders {
            threshold: cx.new(|_| {
                SliderState::new()
                    .min(10.)
                    .max(100.)
                    .step(5.)
                    .default_value(90.)
            }),
            cooldown: cx.new(|_| {
                SliderState::new()
                    .min(0.)
                    .max(60.)
                    .step(1.)
                    .default_value(5.)
            }),
        });
        let mut subscriptions = vec![cx.observe_in(&store, window, |this, _, window, cx| {
            this.sync_sliders(window, cx);
            cx.notify();
        })];
        for provider in Provider::ALL {
            let PolicySliders {
                threshold,
                cooldown,
            } = &sliders[slot(provider)];
            subscriptions.push(
                cx.subscribe(threshold, move |this, _, event: &SliderEvent, cx| {
                    if let SliderEvent::Release(value) = event {
                        let percent = value.start().round();
                        this.store.update(cx, |store, cx| {
                            store.set_policy(provider, json!({ "thresholdPercent": percent }), cx)
                        });
                    }
                }),
            );
            subscriptions.push(
                cx.subscribe(cooldown, move |this, _, event: &SliderEvent, cx| {
                    if let SliderEvent::Release(value) = event {
                        let milliseconds = (value.start().round() * MINUTE) as u64;
                        this.store.update(cx, |store, cx| {
                            store.set_policy(
                                provider,
                                json!({ "minimumDwellMilliseconds": milliseconds }),
                                cx,
                            )
                        });
                    }
                }),
            );
        }
        let mut page = Self {
            store,
            sliders,
            _subscriptions: subscriptions,
        };
        page.sync_sliders(window, cx);
        page
    }

    fn sync_sliders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let snapshot = self.store.read(cx).analytics.snapshot.clone();
        for provider in Provider::ALL {
            let Some(policy) = snapshot.state(provider).map(|state| &state.policy) else {
                continue;
            };
            let sliders = &self.sliders[slot(provider)];
            let threshold = policy.threshold_percent as f32;
            let cooldown = policy.minimum_dwell_milliseconds as f32 / MINUTE;
            sliders.threshold.update(cx, |state, cx| {
                if state.value().start() != threshold {
                    state.set_value(threshold, window, cx);
                }
            });
            sliders.cooldown.update(cx, |state, cx| {
                if state.value().start() != cooldown {
                    state.set_value(cooldown, window, cx);
                }
            });
        }
    }
}

fn row(
    title: impl Into<SharedString>,
    description: Option<SharedString>,
    control: impl IntoElement,
    cx: &App,
) -> Div {
    h_flex()
        .gap_4()
        .px_4()
        .py_3()
        .items_center()
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap_1()
                .child(div().text_sm().child(title.into()))
                .children(description.map(|description| muted(description, cx))),
        )
        .child(control)
}

fn group(title: impl Into<SharedString>, rows: Vec<Div>, cx: &App) -> Div {
    v_flex().gap_2().child(section_title(title, cx)).child(
        v_flex()
            .rounded(cx.theme().radius_lg)
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().group_box)
            .children(rows.into_iter().enumerate().map(|(index, row)| {
                row.when(index > 0, |this| {
                    this.border_t_1().border_color(cx.theme().border)
                })
            })),
    )
}

fn slider_control(state: &Entity<SliderState>, label: String, disabled: bool) -> Div {
    h_flex()
        .gap_3()
        .w_64()
        .child(div().flex_1().child(Slider::new(state).disabled(disabled)))
        .child(div().w_12().text_sm().text_right().child(label))
}

impl SettingsPage {
    fn provider_group(
        &self,
        provider: Provider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let store = self.store.read(cx);
        let busy = store.is_busy();
        let routed = store.routing.routed.get(provider);
        let snapshot = &store.analytics.snapshot;
        let Some(policy) = snapshot.state(provider).map(|state| state.policy.clone()) else {
            return div();
        };
        let windows = format::provider_windows(snapshot, provider);
        let sliders = &self.sliders[slot(provider)];
        let threshold = sliders.threshold.read(cx).value().start().round();
        let cooldown = (sliders.cooldown.read(cx).value().start().round() * MINUTE) as u64;
        let entity = self.store.clone();

        let mut rows = vec![
            row(
                "Route through tokenmaxx",
                Some(
                    format!(
                        "{} sends requests through the local proxy, which picks the account.",
                        provider.cli()
                    )
                    .into(),
                ),
                Switch::new(SharedString::from(format!("routing-{}", provider.cli())))
                    .checked(routed)
                    .disabled(busy)
                    .on_click(
                        window.listener_for(&entity, move |store, checked: &bool, _, cx| {
                            store.set_routing(RoutingTarget::from(provider), *checked, cx)
                        }),
                    ),
                cx,
            ),
            row(
                "Switch accounts automatically",
                Some(
                    "Moves to the account with the most room when the active one fills up.".into(),
                ),
                Switch::new(SharedString::from(format!("auto-{}", provider.cli())))
                    .checked(policy.enabled)
                    .disabled(busy)
                    .on_click(
                        window.listener_for(&entity, move |store, checked: &bool, _, cx| {
                            let changes = if *checked {
                                json!({ "enabled": true, "authorizationConfirmed": true })
                            } else {
                                json!({ "enabled": false })
                            };
                            store.set_policy(provider, changes, cx)
                        }),
                    ),
                cx,
            ),
            row(
                "Switch at",
                Some("Measured against the active account's fullest rate-limit window.".into()),
                slider_control(&sliders.threshold, format!("{threshold}%"), busy),
                cx,
            ),
            row(
                "Cooldown",
                Some(
                    "Minimum time on an account before a threshold switch. Hard limits ignore it."
                        .into(),
                ),
                slider_control(&sliders.cooldown, format::minutes_label(cooldown), busy),
                cx,
            ),
        ];
        for usage_window in windows {
            let hidden = policy.hidden_window_ids.contains(&usage_window.id);
            let all_hidden = policy.hidden_window_ids.clone();
            let id = usage_window.id.clone();
            rows.push(row(
                format!(
                    "Show the {} limit",
                    format::short_window(&usage_window.label)
                ),
                Some(usage_window.label.clone().into()),
                Switch::new(SharedString::from(format!(
                    "window-{}-{}",
                    provider.cli(),
                    usage_window.id
                )))
                .checked(!hidden)
                .disabled(busy)
                .on_click(window.listener_for(
                    &entity,
                    move |store, checked: &bool, _, cx| {
                        let next: Vec<String> = if *checked {
                            all_hidden
                                .iter()
                                .filter(|known| **known != id)
                                .cloned()
                                .collect()
                        } else {
                            all_hidden.iter().cloned().chain([id.clone()]).collect()
                        };
                        store.set_policy(provider, json!({ "hiddenWindowIds": next }), cx)
                    },
                )),
                cx,
            ));
        }
        group(provider.title(), rows, cx)
    }

    fn app_group(&self, cx: &mut Context<Self>) -> Div {
        let store = self.store.read(cx);
        let preferences = store.preferences.clone();
        let terminals = store.terminals.clone();
        let entity = self.store.clone();

        let appearance_index = match preferences.appearance {
            Appearance::Auto => 0,
            Appearance::Light => 1,
            Appearance::Dark => 2,
        };
        let presence_index = match preferences.presence {
            Presence::MenuBarAndDock => 0,
            Presence::MenuBar => 1,
            Presence::Dock => 2,
        };
        let update = |change: fn(&mut Preferences, usize)| {
            let entity = entity.clone();
            move |index: &usize, _: &mut Window, cx: &mut App| {
                entity.update(cx, |store, cx| {
                    let mut preferences = store.preferences.clone();
                    change(&mut preferences, *index);
                    store.set_preferences(preferences, cx)
                })
            }
        };
        let current_terminal = terminal::resolve(preferences.terminal.as_deref());
        let terminal_label = if preferences.terminal.is_none() {
            format!("Automatic ({})", current_terminal.name)
        } else {
            current_terminal.name.to_string()
        };
        let menu_store = entity.clone();
        let chosen = preferences.terminal.clone();

        group(
            "App",
            vec![
                row(
                    "Appearance",
                    None,
                    TabBar::new("appearance")
                        .segmented()
                        .small()
                        .selected_index(appearance_index)
                        .on_click(update(|preferences, index| {
                            preferences.appearance =
                                [Appearance::Auto, Appearance::Light, Appearance::Dark][index]
                        }))
                        .children(["Auto", "Light", "Dark"]),
                    cx,
                ),
                row(
                    "Show tokenmaxx in",
                    Some(
                        "Closing the window keeps tokenmaxx running in the menu bar or Dock."
                            .into(),
                    ),
                    TabBar::new("presence")
                        .segmented()
                        .small()
                        .selected_index(presence_index)
                        .on_click(update(|preferences, index| {
                            preferences.presence =
                                [Presence::MenuBarAndDock, Presence::MenuBar, Presence::Dock][index]
                        }))
                        .children(["Menu bar and Dock", "Menu bar", "Dock"]),
                    cx,
                ),
                row(
                    "Terminal for sign-in",
                    Some("Subscription logins run codex or claude interactively there.".into()),
                    Button::new("terminal")
                        .small()
                        .outline()
                        .label(terminal_label)
                        .dropdown_menu(move |menu, window, _| {
                            let options = std::iter::once((None, "Automatic")).chain(
                                terminals.iter().map(|terminal| {
                                    (Some(terminal.bundle_id.to_string()), terminal.name)
                                }),
                            );
                            options.fold(menu, |menu, (bundle_id, name)| {
                                let checked = bundle_id == chosen;
                                menu.item(PopupMenuItem::new(name).checked(checked).on_click(
                                    window.listener_for(&menu_store, move |store, _, _, cx| {
                                        let preferences = Preferences {
                                            terminal: bundle_id.clone(),
                                            ..store.preferences.clone()
                                        };
                                        store.set_preferences(preferences, cx)
                                    }),
                                ))
                            })
                        }),
                    cx,
                ),
            ],
            cx,
        )
    }

    fn system_group(&self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let store = self.store.read(cx);
        let busy = store.is_busy();
        let pi = store.routing.pi;
        let entity = self.store.clone();
        let runtime = store.runtime.clone();
        let version = runtime
            .as_ref()
            .map(|runtime| runtime.version.clone())
            .unwrap_or_else(|| "…".into());
        let latest = store.latest.clone();

        let pi_control: AnyElement = if pi.present {
            Switch::new("pi")
                .checked(pi.routed)
                .disabled(busy)
                .on_click(
                    window.listener_for(&entity, |store, checked: &bool, _, cx| {
                        store.set_routing(RoutingTarget::Pi, *checked, cx)
                    }),
                )
                .into_any_element()
        } else {
            muted("Not installed", cx).into_any_element()
        };

        let button = |id: &'static str,
                      label: &'static str,
                      action: fn(&mut Store, &mut Context<Store>)| {
            Button::new(id)
                .small()
                .label(label)
                .disabled(busy)
                .on_click(window.listener_for(&entity, move |store, _, _, cx| action(store, cx)))
                .into_any_element()
        };
        let (tool_description, tool_control): (String, AnyElement) = match runtime
            .as_ref()
            .map(|runtime| (&runtime.tool, runtime))
        {
            None => ("Checking your PATH…".into(), div().into_any_element()),
            Some((CommandLineTool::Bundled, _)) => (
                "tokenmaxx in your terminal is this app's own copy.".into(),
                muted("Installed", cx).into_any_element(),
            ),
            Some((CommandLineTool::Shared { path }, runtime)) => (
                format!(
                    "The app runs your installed tokenmaxx v{} at {path}, so both share one daemon.",
                    runtime.version
                ),
                muted("Shared", cx).into_any_element(),
            ),
            Some((CommandLineTool::Outdated { path, version }, runtime)) => (
                format!(
                    "{path} is {}, older than this app's v{}. Until it is updated, the app runs its own copy and each restarts the daemon on its version.",
                    version
                        .as_deref()
                        .map(|version| format!("v{version}"))
                        .unwrap_or_else(|| "an older version".into()),
                    runtime.bundled_version
                ),
                button("update-cli", "Update", Store::update_command_line_tool),
            ),
            Some((CommandLineTool::Missing, _)) => (
                "Use tokenmaxx from any terminal, sharing this app's accounts.".into(),
                button("install-cli", "Install", Store::install_command_line_tool),
            ),
        };

        group(
            "System",
            vec![
                row(
                    "Route pi through tokenmaxx",
                    Some("Adds tokenmaxx providers to pi's models.json.".into()),
                    pi_control,
                    cx,
                ),
                row(
                    "Command-line tool",
                    Some(tool_description.into()),
                    tool_control,
                    cx,
                ),
                row(
                    "Version",
                    latest.map(|latest| format!("v{latest} is available at tokenmaxx.sh").into()),
                    div().text_sm().child(format!("v{version}")),
                    cx,
                ),
            ],
            cx,
        )
    }
}

impl Render for SettingsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_6()
            .child(page_header("Settings", div()))
            .child(self.provider_group(Provider::Openai, window, cx))
            .child(self.provider_group(Provider::Anthropic, window, cx))
            .child(self.app_group(cx))
            .child(self.system_group(window, cx))
    }
}
