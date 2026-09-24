use gpui_kit::assets::IconName;
use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{ActiveTheme as _, Icon, WindowExt as _, h_flex, v_flex};
use gpui_kit::*;

use crate::format;
use crate::ipc;
use crate::model::{Account, Provider, ResetCode};
use crate::store::{Store, StoreEvent};
use crate::terminal;
use crate::views::muted;

fn footer(buttons: impl IntoIterator<Item = Button>) -> Div {
    h_flex().gap_2().justify_end().children(buttons)
}

fn cancel() -> Button {
    Button::new("cancel")
        .label("Cancel")
        .on_click(|_, window, cx| window.close_dialog(cx))
}

pub fn open_add_account(
    store: Entity<Store>,
    provider: Provider,
    cli_present: bool,
    window: &mut Window,
    cx: &mut App,
) {
    let key = cx.new(|cx| {
        InputState::new(window, cx)
            .masked(true)
            .placeholder("API key")
    });
    let label = cx.new(|cx| InputState::new(window, cx).placeholder("Name shown in tokenmaxx"));
    let terminal = terminal::resolve(store.read(cx).preferences.terminal.as_deref());
    window.open_dialog(cx, move |dialog, _, cx| {
        let sign_in_store = store.clone();
        let add_store = store.clone();
        let (key_input, label_input) = (key.clone(), label.clone());
        let submit = move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            let secret = key_input.read(cx).value().trim().to_string();
            let name = label_input.read(cx).value().trim().to_string();
            if secret.is_empty() || name.is_empty() {
                return;
            }
            add_store.update(cx, |store, cx| {
                store.perform(
                    format!("Adding {name}…"),
                    {
                        let name = name.clone();
                        async move { ipc::add_api_key(provider, &secret, &name).await }
                    },
                    move |_, _, cx| cx.emit(StoreEvent::Notice(format!("Added {name}").into())),
                    cx,
                )
            });
            window.close_dialog(cx);
        };
        dialog
            .title(format!("Add a {} account", provider.title()))
            .w(px(440.))
            .child(
                v_flex()
                    .gap_4()
                    .child(
                        v_flex()
                            .gap_2()
                            .child(
                                Button::new("sign-in")
                                    .icon(Icon::new(IconName::Terminal))
                                    .label(format!("Sign in with {} in {}", provider.cli(), terminal.name))
                                    .disabled(!cli_present)
                                    .on_click(move |_, window, cx| {
                                        sign_in_store.update(cx, |store, cx| store.sign_in(provider, cx));
                                        window.close_dialog(cx);
                                    }),
                            )
                            .child(muted(
                                if cli_present {
                                    "Your subscription login. Finish it in the terminal window; the account appears here when done.".to_string()
                                } else {
                                    format!("Install {} first to sign in with a subscription.", provider.cli())
                                },
                                cx,
                            )),
                    )
                    .child(div().h_px().bg(cx.theme().border))
                    .child(
                        v_flex()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Or add an API key"))
                            .child(Input::new(&key))
                            .child(Input::new(&label)),
                    ),
            )
            .footer(footer([
                cancel(),
                Button::new("add-key").primary().label("Add key").on_click(submit),
            ]))
    });
}

pub fn open_sign_out(store: Entity<Store>, account: Account, window: &mut Window, cx: &mut App) {
    window.open_dialog(cx, move |dialog, _, _| {
        let store = store.clone();
        let account = account.clone();
        let name = account.label.clone();
        dialog
            .title(format!("Sign out {name}?"))
            .w(px(420.))
            .child(format!(
                "tokenmaxx deletes this {} credential from your Keychain. You can sign in again at any time.",
                account.provider.title()
            ))
            .footer(footer([
                cancel(),
                Button::new("sign-out").danger().label("Sign out").on_click(move |_, window, cx| {
                    let id = account.id.clone();
                    let name = account.label.clone();
                    store.update(cx, |store, cx| {
                        store.perform(
                            format!("Signing out {name}…"),
                            async move { ipc::remove_account(&id).await },
                            move |_, _, cx| cx.emit(StoreEvent::Notice(format!("Signed out {name}").into())),
                            cx,
                        )
                    });
                    window.close_dialog(cx);
                }),
            ]))
    });
}

fn outcome_message(code: ResetCode, windows: u32) -> String {
    match code {
        ResetCode::Reset => format!(
            "Reset {windows} window{}",
            if windows == 1 { "" } else { "s" }
        ),
        ResetCode::NothingToReset => "Nothing to reset; the credit stays banked".into(),
        ResetCode::NoCredit => "No reset credit is available".into(),
        ResetCode::AlreadyRedeemed => "That credit was already redeemed".into(),
    }
}

pub fn open_reset_credits(
    store: Entity<Store>,
    account: Account,
    window: &mut Window,
    cx: &mut App,
) {
    let id = account.id.clone();
    window
        .spawn(cx, async move |cx| {
            let view = match ipc::reset_credits(&id).await {
                Ok(view) => view,
                Err(error) => {
                    store.update(cx, |_, cx| cx.emit(StoreEvent::Error(error.to_string().into())));
                    return;
                }
            };
            let soonest = view
                .credits
                .iter()
                .filter_map(|credit| credit.expires_at.as_deref())
                .filter_map(format::parse_time)
                .min();
            cx.update(|window, cx| {
                window.open_dialog(cx, move |dialog, _, cx| {
                    let store = store.clone();
                    let account = account.clone();
                    let expiry = soonest
                        .map(|at| {
                            format!(
                                "The soonest expires in {}.",
                                format::short_reset(Some(&at.to_rfc3339()), chrono::Utc::now()).unwrap_or_default()
                            )
                        })
                        .unwrap_or_default();
                    dialog
                        .title("Reset a rate-limit window?")
                        .w(px(420.))
                        .child(
                            v_flex()
                                .gap_2()
                                .child(format!(
                                    "Spend one of {}'s {} banked reset credits to clear its current Codex windows.",
                                    account.label, view.available
                                ))
                                .child(muted(expiry, cx)),
                        )
                        .footer(footer([
                            Button::new("keep").label("Keep it banked").on_click(|_, window, cx| window.close_dialog(cx)),
                            Button::new("reset").primary().label("Reset now").on_click(move |_, window, cx| {
                                let id = account.id.clone();
                                store.update(cx, |store, cx| {
                                    store.perform(
                                        "Resetting…",
                                        async move { ipc::consume_reset(&id).await },
                                        |_, outcome, cx| {
                                            cx.emit(StoreEvent::Notice(
                                                outcome_message(outcome.code, outcome.windows_reset).into(),
                                            ))
                                        },
                                        cx,
                                    )
                                });
                                window.close_dialog(cx);
                            }),
                        ]))
                });
            })
            .ok();
        })
        .detach();
}
