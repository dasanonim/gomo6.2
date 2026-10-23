#!/usr/bin/env python3
"""Generate the before/after SVG charts for the profile-batching optimization.

Pure stdlib on purpose: CI and the docs build never need matplotlib.

    python3 docs/scripts/gen-optimization-charts.py
"""
from __future__ import annotations

import math
import pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "wiki" / "assets" / "optimization"

BG = "#ffffff"
INK = "#111827"
MUTED = "#6b7280"
GRID = "#e5e7eb"
BEFORE = "#f97316"
AFTER = "#10b981"
OTHER = "#cbd5e1"

W, H = 760, 360


def esc(text: object) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def svg_doc(title: str, subtitle: str, body: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="{esc(title)}">
  <rect width="{W}" height="{H}" rx="18" fill="{BG}"/>
  <text x="32" y="44" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="700" fill="{INK}">{esc(title)}</text>
  <text x="32" y="70" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" fill="{MUTED}">{esc(subtitle)}</text>
{body}
</svg>
'''


def legend(x: int, y: int) -> str:
    return f'''  <g font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12" fill="{MUTED}">
    <rect x="{x}" y="{y - 9}" width="10" height="10" rx="3" fill="{BEFORE}"/>
    <text x="{x + 16}" y="{y}">до</text>
    <rect x="{x + 54}" y="{y - 9}" width="10" height="10" rx="3" fill="{AFTER}"/>
    <text x="{x + 70}" y="{y}">после</text>
  </g>'''


def nice_ticks(ymax: float, target: int = 4) -> tuple[float, list[float]]:
    raw = ymax / target
    mag = 10 ** math.floor(math.log10(raw))
    norm = raw / mag
    step = (1 if norm <= 1 else 2 if norm <= 2 else 5 if norm <= 5 else 10) * mag
    top = math.ceil(ymax / step) * step
    return top, [i * step for i in range(int(round(top / step)) + 1)]


def gridlines(max_value: float, values: list[float], plot_top: int = 104, plot_bottom: int = 292) -> str:
    parts = []
    for value in values:
        y = plot_bottom - (plot_bottom - plot_top) * value / max_value
        parts.append(
            f'  <line x1="72" y1="{y:.1f}" x2="728" y2="{y:.1f}" stroke="{GRID}" stroke-width="1"/>'
        )
        label = f"{value:g}"
        parts.append(
            f'  <text x="62" y="{y + 4:.1f}" text-anchor="end" font-family="Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif" font-size="11" fill="{MUTED}">{label}</text>'
        )
    return "\n".join(parts)


def bar(x: float, width: float, value: float, ymax: float, color: str, label: str, plot_top: int = 104, plot_bottom: int = 292) -> str:
    h = 0 if value <= 0 else (plot_bottom - plot_top) * value / ymax
    y = plot_bottom - h
    out = []
    if value > 0:
        out.append(
            f'  <rect x="{x:.1f}" y="{y:.1f}" width="{width:.1f}" height="{h:.1f}" rx="6" fill="{color}"/>'
        )
    label_y = y - 9 if value > 0 else plot_bottom - 9
    out.append(
        f'  <text x="{x + width / 2:.1f}" y="{label_y:.1f}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif" font-size="13" font-weight="700" fill="{INK}">{label}</text>'
    )
    return "\n".join(out)


def category_labels(labels: list[str], centers: list[float]) -> str:
    return "\n".join(
        f'  <text x="{cx:.1f}" y="318" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif" font-size="12" fill="{MUTED}">{esc(label)}</text>'
        for label, cx in zip(labels, centers)
    )


def grouped_categories(
    filename: str,
    title: str,
    subtitle: str,
    data: list[tuple[str, float, float]],
    ymax: float,
    before_total: str | None = None,
    after_total: str | None = None,
) -> None:
    plot_top, plot_bottom = 104, 292
    nice_top, ticks = nice_ticks(ymax)
    group_w = 580 / len(data)
    bar_w = min(62, group_w * 0.28)
    body = [legend(566, 70), gridlines(nice_top, ticks, plot_top, plot_bottom)]
    centers = []
    for i, (label, before, after) in enumerate(data):
        center = 72 + group_w * (i + 0.5)
        centers.append(center)
        gap = 8
        left = center - bar_w - gap / 2
        right = center + gap / 2
        body.append(bar(left, bar_w, before, nice_top, BEFORE, f"{before:g}"))
        body.append(bar(right, bar_w, after, nice_top, AFTER, f"{after:g}"))
    body.append(category_labels([d[0] for d in data], centers))
    if before_total:
        body.append(
            f'  <text x="728" y="46" text-anchor="end" font-family="Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif" font-size="15" font-weight="700" fill="{INK}">{esc(before_total)} → {esc(after_total)}</text>'
        )
    (OUT / filename).write_text(svg_doc(title, subtitle, "\n".join(body)), encoding="utf-8")


def stacked_total(filename: str, title: str, subtitle: str, before_prof: float, before_other: float, after_prof: float, after_other: float) -> None:
    plot_top, plot_bottom = 104, 292
    nice_top, ticks = nice_ticks(60)
    ymax = nice_top
    body = [gridlines(nice_top, ticks, plot_top, plot_bottom)]
    body.append(f'''  <g font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12" fill="{MUTED}">
    <rect x="520" y="39" width="10" height="10" rx="3" fill="{BEFORE}"/>
    <text x="536" y="48">профили</text>
    <rect x="602" y="39" width="10" height="10" rx="3" fill="{OTHER}"/>
    <text x="618" y="48">остальное</text>
  </g>''')
    bar_w = 110
    for idx, (prof, other, x) in enumerate(
        [(before_prof, before_other, 72 + 130), (after_prof, after_other, 72 + 370)]
    ):
        total = prof + other
        other_h = (plot_bottom - plot_top) * other / ymax
        prof_h = (plot_bottom - plot_top) * prof / ymax
        y_other = plot_bottom - other_h
        y_prof = y_other - prof_h
        body.append(
            f'  <rect x="{x}" y="{y_prof:.1f}" width="{bar_w}" height="{prof_h:.1f}" rx="6" fill="{BEFORE}"/>'
        )
        body.append(
            f'  <rect x="{x}" y="{y_other:.1f}" width="{bar_w}" height="{other_h:.1f}" rx="6" fill="{OTHER}"/>'
        )
        body.append(
            f'  <text x="{x + bar_w / 2}" y="{y_prof - 10:.1f}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif" font-size="14" font-weight="700" fill="{INK}">{total:g}</text>'
        )
        body.append(
            f'  <text x="{x + bar_w / 2}" y="318" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif" font-size="12" fill="{MUTED}">{"до" if idx == 0 else "после"}</text>'
        )
    (OUT / filename).write_text(svg_doc(title, subtitle, "\n".join(body)), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    grouped_categories(
        "opt-profile-calls.svg",
        "Запросы за один экран ленты",
        "4 автора, свежая загрузка · dev-стенд, одинаковые данные",
        [
            ("profiles", 6, 1),
            ("user_roles", 5, 0),
            ("customization", 4, 0),
            ("profiles/summary", 0, 2),
        ],
        7,
        before_total="15",
        after_total="3",
    )

    grouped_categories(
        "opt-profile-scaling.svg",
        "Запросы профилей растут с числом авторов",
        "до: 3 запроса на каждого автора · после: 1–2 батча на страницу",
        [
            ("1 автор", 3, 1),
            ("4 автора", 12, 2),
            ("9 авторов", 27, 2),
            ("20 авторов", 60, 2),
        ],
        62,
        before_total="3N",
        after_total="O(1)",
    )

    stacked_total(
        "opt-total-api.svg",
        "Всего запросов к API за загрузку ленты",
        "оранжевое — профильные, серое — остальное",
        15,
        36,
        3,
        37,
    )

    grouped_categories(
        "opt-profile-time.svg",
        "Время на профильные запросы, мс",
        "сумма ответов в браузере · 4 автора · сервер: 90 мс → 4,7 мс",
        [("4 автора", 730, 214)],
        800,
        before_total="730 мс",
        after_total="214 мс",
    )

    print(f"wrote {len(list(OUT.glob('*.svg')))} svg files to {OUT}")


if __name__ == "__main__":
    main()
