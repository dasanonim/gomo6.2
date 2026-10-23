#!/usr/bin/env python3
"""Generate the before/after SVG charts for the feed-v3 optimization.

Pure stdlib, same visual language as gen-optimization-charts.py (imported for
the shared helpers so both docs keep one style).

    python3 docs/scripts/gen-feed-charts.py

Data sources (see docs/wiki/OPTIMIZATION_FEED.md for the full tables):
- "прод": production pg_stat_statements + EXPLAIN, ~130 content rows.
- "бенч": feedbench2 scratch DB, VACUUM ANALYZE, 5-run medians of
  EXPLAIN (ANALYZE, BUFFERS), corpus 200 / 2 000 / 10 000 posts.
- "после" dev-stand numbers: local :8091 with migrations 139+140.
"""
from __future__ import annotations

import pathlib

import importlib.util

_base_path = pathlib.Path(__file__).resolve().parent / "gen-optimization-charts.py"
_spec = importlib.util.spec_from_file_location("gen_optimization_charts", _base_path)
assert _spec is not None and _spec.loader is not None
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)

OUT = _base.OUT
grouped_categories = _base.grouped_categories


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    grouped_categories(
        "opt-feed-buffers.svg",
        "Буферы БД на один запрос ленты",
        "shared buffers, тёплый кэш · меньше — лучше",
        [
            ("прод ~130", 1388, 20),
            ("бенч 2k", 12980, 4370),
            ("бенч 10k", 55691, 4494),
        ],
        56000,
        before_total="55 691",
        after_total="4 494",
    )

    grouped_categories(
        "opt-feed-latency.svg",
        "Латентность ленты, мс",
        "медианы EXPLAIN · pg_stat — среднее по вызовам приложения",
        [
            ("холодный", 67, 28),
            ("тёплый", 10, 3),
            ("pg_stat mean", 357, 31),
        ],
        400,
        before_total="357",
        after_total="31",
    )

    grouped_categories(
        "opt-chatter-counts.svg",
        "Дубли запросов на странице профиля",
        "число запросов за загрузку /profile/11 · dev-стенд",
        [
            ("unread-count", 3, 1),
            ("emoji-subs", 3, 1),
            ("emoji-packs", 3, 1),
            ("conversations", 2, 1),
            ("auth/me", 2, 1),
            ("notifications", 2, 1),
            ("membership", 3, 1),
        ],
        4,
        before_total="44",
        after_total="30",
    )

    grouped_categories(
        "opt-wall-buffers.svg",
        "Стена профиля: буферы на 10 постов",
        "пользователь с 84 постами · тёплый кэш · меньше — лучше",
        [
            ("10 постов", 554, 73),
        ],
        600,
        before_total="554",
        after_total="73",
    )

    grouped_categories(
        "opt-feed-scaling.svg",
        "Авторизованная лента при росте корпуса, мс",
        "бенч: 60 юзеров, ~5 лайков/пост · старая — O(корпус), новая — O(страница)",
        [
            ("200", 14, 12),
            ("2 000", 186, 15),
            ("10 000", 1830, 24),
        ],
        2000,
        before_total="1 830",
        after_total="24",
    )

    print(f"feed charts in {OUT}")


if __name__ == "__main__":
    main()
