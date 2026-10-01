use std::cell::Cell;
use std::rc::Rc;

use chrono::{DateTime, Local, TimeZone as _, Utc};
use gpui_kit::component::StyledExt as _;
use gpui_kit::component::tab::TabBar;
use gpui_kit::component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::format;
use crate::model::{TIMEFRAMES, TokenBreakdown, TokenTimeframe};
use crate::store::{Connection, Store};
use crate::views::{muted, page_header, section_title};

const DEFAULT_TIMEFRAME: usize = 2;
const PLOT_HEIGHT: f32 = 220.;
const Y_GUTTER: f32 = 56.;
const HOUR_MS: f64 = 3_600_000.;

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Chart,
    Pricing,
}

pub struct AnalyticsPage {
    store: Entity<Store>,
    timeframe: usize,
    view: View,
    hovered: Option<usize>,
    plot: Rc<Cell<Bounds<Pixels>>>,
}

impl AnalyticsPage {
    pub fn new(store: Entity<Store>, cx: &mut Context<Self>) -> Self {
        cx.observe(&store, |_, _, cx| cx.notify()).detach();
        Self {
            store,
            timeframe: DEFAULT_TIMEFRAME,
            view: View::Chart,
            hovered: None,
            plot: Rc::new(Cell::new(Bounds::default())),
        }
    }
}

/// A round step that splits `max` into about four gridlines: 1, 2, 2.5 or 5 times a power of ten.
fn nice_step(max: f64) -> f64 {
    if max <= 0. {
        return 1.;
    }
    let raw = max / 4.;
    let magnitude = 10f64.powf(raw.log10().floor());
    let step = [1., 2., 2.5, 5., 10.]
        .into_iter()
        .find(|candidate| raw / magnitude <= *candidate)
        .unwrap_or(10.);
    step * magnitude
}

/// Clock ticks across `[start, end]`, aligned to local time, about five of them.
fn time_ticks(start_ms: f64, end_ms: f64) -> Vec<(f64, String)> {
    const STEPS_MINUTES: [f64; 13] = [
        5., 10., 15., 30., 60., 120., 180., 240., 360., 720., 1440., 2880., 10080.,
    ];
    let span_minutes = (end_ms - start_ms) / 60_000.;
    let step_minutes = STEPS_MINUTES
        .into_iter()
        .find(|step| span_minutes / step <= 6.)
        .unwrap_or(10080.);
    let step_ms = step_minutes * 60_000.;
    let offset_ms = Local::now().offset().local_minus_utc() as f64 * 1000.;
    let mut tick = ((start_ms + offset_ms) / step_ms).ceil() * step_ms - offset_ms;
    let mut ticks = Vec::new();
    while tick <= end_ms {
        if let Some(time) = Local.timestamp_millis_opt(tick as i64).single() {
            let label = if step_minutes < 60. {
                time.format("%-I:%M %p").to_string()
            } else if step_minutes < 1440. {
                time.format("%-I %p").to_string()
            } else {
                time.format("%b %-d").to_string()
            };
            ticks.push(((tick - start_ms) / (end_ms - start_ms), label));
        }
        tick += step_ms;
    }
    ticks
}

fn bucket_span(start: DateTime<Local>, end: DateTime<Local>, multi_day: bool) -> String {
    let time = |moment: DateTime<Local>| moment.format("%-I:%M %p").to_string();
    if multi_day {
        format!(
            "{}, {} – {}",
            start.format("%b %-d"),
            time(start),
            time(end)
        )
    } else {
        format!("{} – {}", time(start), time(end))
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
    fn chart(&self, timeframe: &TokenTimeframe, cx: &mut Context<Self>) -> impl IntoElement {
        let count = timeframe.buckets.len().max(1);
        let per_hour = HOUR_MS / timeframe.bucket_ms;
        let rates: Vec<f64> = timeframe
            .buckets
            .iter()
            .map(|tokens| tokens * per_hour)
            .collect();
        let peak = rates.iter().copied().fold(0., f64::max);
        let step = nice_step(peak);
        let top = step * (peak / step).ceil().max(1.);
        let gridlines: Vec<f64> = (0..=(top / step).round() as usize)
            .map(|index| index as f64 * step)
            .collect();
        let end_ms = Utc::now().timestamp_millis() as f64;
        let start_ms = end_ms - timeframe.bucket_ms * count as f64;
        let hovered = self.hovered.filter(|index| *index < count);

        let theme = cx.theme();
        let (line, grid, muted_text) = (theme.blue, theme.border, theme.muted_foreground);
        let band = theme.foreground.opacity(0.06);
        let plot = self.plot.clone();
        let painted = (rates.clone(), gridlines.clone());
        let surface = canvas(
            move |bounds, _, _| {
                plot.set(bounds);
                bounds
            },
            move |bounds, _, window, _| {
                let (rates, gridlines) = painted;
                let width = bounds.size.width.as_f32();
                let height = bounds.size.height.as_f32();
                let x = |index: usize| bounds.origin.x + px(width * index as f32 / count as f32);
                let y = |value: f64| bounds.origin.y + px(height - (value / top) as f32 * height);
                for value in gridlines {
                    window.paint_quad(fill(
                        Bounds::new(
                            point(bounds.origin.x, y(value) - px(0.5)),
                            size(bounds.size.width, px(1.)),
                        ),
                        grid,
                    ));
                }
                if let Some(index) = hovered {
                    window.paint_quad(fill(
                        Bounds::from_corners(
                            point(x(index), bounds.origin.y),
                            point(x(index + 1), bounds.bottom()),
                        ),
                        band,
                    ));
                }
                let mut area = PathBuilder::fill();
                let mut edge = PathBuilder::stroke(px(2.));
                area.move_to(point(x(0), y(0.)));
                for (index, rate) in rates.iter().enumerate() {
                    area.line_to(point(x(index), y(*rate)));
                    area.line_to(point(x(index + 1), y(*rate)));
                    if index == 0 {
                        edge.move_to(point(x(0), y(*rate)));
                    } else {
                        edge.line_to(point(x(index), y(*rate)));
                    }
                    edge.line_to(point(x(index + 1), y(*rate)));
                }
                area.line_to(point(x(count), y(0.)));
                area.close();
                if let Ok(path) = area.build() {
                    window.paint_path(path, line.opacity(0.12));
                }
                if let Ok(path) = edge.build() {
                    window.paint_path(path, line);
                }
            },
        )
        .size_full();

        let readout = hovered.map(|index| {
            let bucket_start = start_ms + index as f64 * timeframe.bucket_ms;
            let span = match (
                Local.timestamp_millis_opt(bucket_start as i64).single(),
                Local
                    .timestamp_millis_opt((bucket_start + timeframe.bucket_ms) as i64)
                    .single(),
            ) {
                (Some(from), Some(to)) => {
                    bucket_span(from, to, timeframe.bucket_ms * count as f64 > 30. * HOUR_MS)
                }
                _ => String::new(),
            };
            let center = (index as f32 + 0.5) / count as f32;
            v_flex()
                .absolute()
                .top(px(8.))
                .map(|this| {
                    if center < 0.6 {
                        this.left(relative(center)).ml(px(12.))
                    } else {
                        this.right(relative(1. - center)).mr(px(12.))
                    }
                })
                .px_3()
                .py_2()
                .gap_0p5()
                .rounded(cx.theme().radius)
                .border_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().popover)
                .shadow_md()
                .child(
                    div()
                        .text_sm()
                        .font_semibold()
                        .child(format!("{}/h", format::compact_number(rates[index]))),
                )
                .child(div().text_xs().text_color(muted_text).child(format!(
                    "{} tokens · {span}",
                    format::compact_number(timeframe.buckets[index])
                )))
        });

        let y_labels = div()
            .relative()
            .flex_shrink_0()
            .w(px(Y_GUTTER))
            .h(px(PLOT_HEIGHT))
            .children(gridlines.iter().map(|value| {
                div()
                    .absolute()
                    .right(px(10.))
                    .top(px(PLOT_HEIGHT - (value / top) as f32 * PLOT_HEIGHT - 8.))
                    .text_xs()
                    .text_color(muted_text)
                    .child(format::compact_number(*value))
            }));
        let x_labels = div().relative().h(px(16.)).ml(px(Y_GUTTER)).children(
            time_ticks(start_ms, end_ms)
                .into_iter()
                .filter(|(fraction, _)| *fraction > 0.04 && *fraction < 0.96)
                .map(|(fraction, label)| {
                    div()
                        .absolute()
                        .left(relative(fraction as f32))
                        .ml(px(-40.))
                        .w(px(80.))
                        .text_center()
                        .text_xs()
                        .text_color(muted_text)
                        .child(label)
                }),
        );
        let plot_area = div()
            .id("throughput")
            .relative()
            .flex_1()
            .h(px(PLOT_HEIGHT))
            .child(surface)
            .children(readout)
            .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, _, cx| {
                let bounds = this.plot.get();
                let width = bounds.size.width.as_f32();
                if width <= 0. || !bounds.contains(&event.position) {
                    return;
                }
                let fraction = (event.position.x - bounds.origin.x).as_f32() / width;
                let index = Some(((fraction * count as f32) as usize).min(count - 1));
                if this.hovered != index {
                    this.hovered = index;
                    cx.notify();
                }
            }))
            .on_hover(cx.listener(|this, hovering: &bool, _, cx| {
                if !*hovering && this.hovered.take().is_some() {
                    cx.notify();
                }
            }));

        card(cx)
            .p_4()
            .gap_3()
            .child(
                h_flex()
                    .justify_between()
                    .child(section_title("Token throughput · all accounts", cx))
                    .child(muted("tokens per hour", cx)),
            )
            .child(h_flex().items_start().child(y_labels).child(plot_area))
            .child(x_labels)
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
        let connecting = self.store.read(cx).connection == Connection::Connecting;
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
                None if connecting => this.child(muted("Connecting to tokenmaxx…", cx)),
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
