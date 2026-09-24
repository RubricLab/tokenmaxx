pub mod accounts;
pub mod analytics;
pub mod dialogs;
pub mod root;
pub mod settings;

use gpui_kit::component::{ActiveTheme as _, StyledExt as _};
use gpui_kit::*;

use crate::format::Pressure;

pub fn pressure_color(pressure: Pressure, cx: &App) -> Hsla {
    let theme = cx.theme();
    match pressure {
        Pressure::Unknown => theme.muted_foreground,
        Pressure::Good => theme.success,
        Pressure::Warn => theme.warning,
        Pressure::Bad => theme.danger,
    }
}

/// A page's title band: the heading on the leading edge and its commands on the trailing edge.
pub fn page_header(title: &'static str, trailing: impl IntoElement) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap_3()
        .child(div().text_xl().font_semibold().child(title))
        .child(trailing)
}

pub fn section_title(title: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_sm()
        .font_semibold()
        .text_color(cx.theme().foreground)
        .child(title.into())
}

pub fn muted(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
}
