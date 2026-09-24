use gpui_kit::component::StyledExt as _;
use gpui_kit::component::chart::AreaChart;
use gpui_kit::component::tab::TabBar;
use gpui_kit::component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::format;
use crate::model::{TIMEFRAMES, TokenBreakdown, TokenTimeframe};
use crate::store::Store;
use crate::views::{muted, page_header, section_title};

const DEFAULT_TIMEFRAME: usize = 2;
const CHART_POINTS: usize = 48;

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Chart,
    Pricing,
}

pub struct AnalyticsPage {
    store: Entity<Store>,
    timeframe: usize,
    view: View,
}

impl AnalyticsPage {
    pub fn new(store: Entity<Store>, cx: &mut Context<Self>) -> Self {
        cx.observe(&store, |_, _, cx| cx.notify()).detach();
        Self {
            store,
            timeframe: DEFAULT_TIMEFRAME,
            view: View::Chart,
        }
    }
}

/// Downsamples by keeping each column's peak, so short bursts survive the resampling.
fn columns(buckets: &[f64], count: usize) -> Vec<f64> {
    if buckets.len() <= count {
        return buckets.to_vec();
    }
    (0..count)
        .map(|column| {
            let low = column * buckets.len() / count;
            let high = ((column + 1) * buckets.len() / count).max(low + 1);
            buckets[low..high].iter().copied().fold(0.0, f64::max)
        })
        .collect()
}

fn ago_label(milliseconds: f64) -> String {
    let minutes = (milliseconds / 60_000.0).round();
    if minutes < 1.0 {
        "now".into()
    } else if minutes < 60.0 {
        format!("{minutes}m")
    } else if minutes < 48.0 * 60.0 {
        format!("{}h", (minutes / 60.0).round())
    } else {
        format!("{}d", (minutes / 1440.0).round())
    }
}

fn stat(title: &'static str, value: String, cx: &App) -> Div {
    v_flex()
        .flex_1()
        .gap_1()
        .p_4()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().group_box)
        .child(muted(title, cx))
        .child(div().text_xl().font_semibold().child(value))
}

fn table_row(cells: [String; 5], emphasis: bool, cx: &App) -> Div {
    let [name, rest @ ..] = cells;
    h_flex()
        .px_4()
        .py_2()
        .gap_4()
        .text_sm()
        .when(emphasis, |this| this.font_semibold())
        .child(div().flex_1().min_w_0().truncate().child(name))
        .children(
            rest.into_iter()
                .map(|cell| div().w_24().flex_shrink_0().text_right().child(cell)),
        )
        .border_t_1()
        .border_color(cx.theme().border)
}

fn table_head(titles: [&'static str; 5], cx: &App) -> Div {
    let [name, rest @ ..] = titles;
    h_flex()
        .px_4()
        .py_2()
        .gap_4()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(div().flex_1().child(name))
        .children(
            rest.into_iter()
                .map(|title| div().w_24().flex_shrink_0().text_right().child(title)),
        )
}

fn breakdown_row(name: String, breakdown: &TokenBreakdown, cx: &App) -> Div {
    table_row(
        [
            name,
            format::compact_number(breakdown.input),
            format::compact_number(breakdown.output),
            format::compact_number(breakdown.cached + breakdown.cache_creation),
            format::money_usd(breakdown.cost_usd),
        ],
        false,
        cx,
    )
}

fn card(cx: &App) -> Div {
    v_flex()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().group_box)
        .overflow_hidden()
}

impl AnalyticsPage {
    fn chart(&self, timeframe: &TokenTimeframe, cx: &App) -> impl IntoElement {
        let values = columns(&timeframe.buckets, CHART_POINTS);
        let span = timeframe.bucket_ms * timeframe.buckets.len() as f64;
        let step = span / values.len().max(1) as f64;
        let points: Vec<(SharedString, f64)> = values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let remaining = span - step * (index + 1) as f64;
                (SharedString::from(ago_label(remaining)), *value)
            })
            .collect();
        let accent = cx.theme().primary;
        card(cx)
            .p_4()
            .gap_2()
            .child(section_title("Token throughput · all accounts", cx))
            .child(
                div().h_64().child(
                    AreaChart::new(points)
                        .x(|point: &(SharedString, f64)| point.0.clone())
                        .y(|point: &(SharedString, f64)| point.1)
                        .stroke(accent)
                        .fill(accent.opacity(0.2))
                        .tick_margin(CHART_POINTS / 6)
                        .id("throughput"),
                ),
            )
    }

    fn pricing(&self, timeframe: &TokenTimeframe, cx: &App) -> impl IntoElement {
        let total = table_row(
            [
                "Total".into(),
                format::compact_number(timeframe.total_input),
                format::compact_number(timeframe.total_output),
                format::compact_number(timeframe.total_cached + timeframe.total_cache_creation),
                format::money_usd(timeframe.cost_usd),
            ],
            true,
            cx,
        );
        let by_class = table_row(
            [
                "Value by class".into(),
                format::money_usd(timeframe.cost_input),
                format::money_usd(timeframe.cost_output),
                format::money_usd(timeframe.cost_cached + timeframe.cost_cache_creation),
                format::money_usd(timeframe.cost_usd),
            ],
            false,
            cx,
        );
        v_flex()
            .gap_4()
            .child(
                card(cx)
                    .child(table_head(
                        ["Provider", "Input", "Output", "Cache", "Value"],
                        cx,
                    ))
                    .children(timeframe.by_provider.iter().map(|breakdown| {
                        let title = crate::model::Provider::title(breakdown.provider);
                        breakdown_row(title.into(), breakdown, cx)
                    }))
                    .child(total)
                    .child(by_class),
            )
            .child(
                card(cx)
                    .child(table_head(
                        ["Model", "Input", "Output", "Cache", "Value"],
                        cx,
                    ))
                    .children(timeframe.models.iter().map(|breakdown| {
                        breakdown_row(
                            breakdown.model.clone().unwrap_or_else(|| "unknown".into()),
                            breakdown,
                            cx,
                        )
                    })),
            )
            .child(muted(
                "Priced at API list rates, for comparison with what a subscription covers.",
                cx,
            ))
    }
}

impl Render for AnalyticsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let key = TIMEFRAMES[self.timeframe];
        let analytics = self.store.read(cx).analytics.clone();
        let timeframe = analytics
            .timeframe(key)
            .filter(|timeframe| timeframe.total_tokens > 0.0)
            .cloned();
        let now_per_hour = analytics
            .tokens
            .as_ref()
            .map(|tokens| tokens.now_per_hour)
            .unwrap_or_default();

        let ranges = TabBar::new("timeframe")
            .segmented()
            .small()
            .selected_index(self.timeframe)
            .on_click(cx.listener(|this, index: &usize, _, cx| {
                this.timeframe = *index;
                cx.notify();
            }))
            .children(TIMEFRAMES);
        let views = TabBar::new("view")
            .segmented()
            .small()
            .selected_index(if self.view == View::Chart { 0 } else { 1 })
            .on_click(cx.listener(|this, index: &usize, _, cx| {
                this.view = if *index == 0 {
                    View::Chart
                } else {
                    View::Pricing
                };
                cx.notify();
            }))
            .children(["Chart", "Pricing"]);

        v_flex()
            .gap_6()
            .child(page_header(
                "Analytics",
                h_flex().gap_3().child(views).child(ranges),
            ))
            .map(|this| match &timeframe {
                None => this.child(
                    card(cx)
                        .p_6()
                        .items_center()
                        .gap_1()
                        .child(
                            div()
                                .font_semibold()
                                .child(format!("No token usage in the last {key}")),
                        )
                        .child(muted(
                            "Run codex or claude and the throughput shows up here as it streams.",
                            cx,
                        )),
                ),
                Some(timeframe) => this
                    .child(
                        h_flex()
                            .gap_4()
                            .child(stat(
                                "Tokens",
                                format::compact_number(timeframe.total_tokens),
                                cx,
                            ))
                            .child(stat(
                                "Value at list price",
                                format::money_usd(timeframe.cost_usd),
                                cx,
                            ))
                            .child(stat(
                                "Peak per hour",
                                format::compact_number(timeframe.peak_per_hour),
                                cx,
                            ))
                            .child(stat(
                                "Now per hour",
                                format::compact_number(now_per_hour),
                                cx,
                            )),
                    )
                    .map(|this| match self.view {
                        View::Chart => this.child(self.chart(timeframe, cx)),
                        View::Pricing => this.child(self.pricing(timeframe, cx)),
                    }),
            })
    }
}
