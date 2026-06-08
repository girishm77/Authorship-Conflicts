#!/usr/bin/env python3
"""Build a compact UTD coauthorship conflict index for the static dashboard."""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


def normalize_name(value: str) -> str:
    asciiish = (
        unicodedata.normalize("NFKD", value or "")
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    cleaned = re.sub(r"[^a-z0-9]+", " ", asciiish.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def default_source_path() -> Path:
    repo_root = Path(__file__).resolve().parents[1]
    return (
        repo_root
        / "../Marketing Publishing/data/utd/utd_author_affiliations_1990_2025.csv"
    ).resolve()


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Build data/conflict-index.json from UTD author affiliations."
    )
    parser.add_argument("--source", type=Path, default=default_source_path())
    parser.add_argument(
        "--output", type=Path, default=repo_root / "data/conflict-index.json"
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.source.exists():
        raise SystemExit(f"Source CSV not found: {args.source}")

    article_rows: dict[str, dict] = {}
    article_authors: dict[str, list[str]] = defaultdict(list)
    article_author_seen: dict[str, set[str]] = defaultdict(set)
    author_display_counts: dict[str, Counter[str]] = defaultdict(Counter)
    author_institutions: dict[str, Counter[str]] = defaultdict(Counter)
    author_year_institutions: dict[str, dict[int, Counter[str]]] = defaultdict(
        lambda: defaultdict(Counter)
    )
    author_years: dict[str, list[int]] = defaultdict(list)
    author_article_counts: dict[str, set[str]] = defaultdict(set)
    row_count = 0

    with args.source.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            row_count += 1
            uid = row["article_uid"]
            author = (row.get("author") or "").strip()
            norm = normalize_name(author)
            if not norm:
                continue

            year = int(row["year"])
            if uid not in article_rows:
                article_rows[uid] = {
                    "uid": uid,
                    "y": year,
                    "j": row.get("journal", "").strip(),
                    "t": row.get("article", "").strip(),
                }

            if norm not in article_author_seen[uid]:
                article_author_seen[uid].add(norm)
                article_authors[uid].append(norm)

            author_display_counts[norm][author] += 1
            institution = (row.get("institution") or "").strip()
            if institution:
                author_institutions[norm][institution] += 1
                author_year_institutions[norm][year][institution] += 1
            author_years[norm].append(year)
            author_article_counts[norm].add(uid)

    def display_name(norm: str) -> str:
        names = author_display_counts[norm]
        return sorted(names, key=lambda name: (-names[name], len(name), name.lower()))[0]

    def latest_institution(norm: str) -> tuple[str, int | None]:
        by_year = author_year_institutions.get(norm)
        if not by_year:
            return "", None
        latest_year = max(by_year)
        institutions = by_year[latest_year]
        latest_name = sorted(
            institutions,
            key=lambda name: (-institutions[name], name.lower()),
        )[0]
        return latest_name, latest_year

    author_norms = sorted(author_display_counts, key=lambda norm: display_name(norm).lower())
    author_id = {norm: index for index, norm in enumerate(author_norms)}

    authors = []
    for norm in author_norms:
        years = author_years[norm]
        institutions = [
            name
            for name, _count in author_institutions[norm].most_common(3)
            if name
        ]
        latest_affiliation, latest_affiliation_year = latest_institution(norm)
        authors.append(
            {
                "id": author_id[norm],
                "n": display_name(norm),
                "k": norm,
                "c": len(author_article_counts[norm]),
                "f": min(years),
                "l": max(years),
                "u": latest_affiliation,
                "uy": latest_affiliation_year,
                "i": institutions,
            }
        )

    sorted_uids = sorted(
        article_rows,
        key=lambda uid: (article_rows[uid]["y"], article_rows[uid]["j"], article_rows[uid]["t"], uid),
    )
    article_id = {uid: index for index, uid in enumerate(sorted_uids)}
    articles = []
    pair_articles: dict[str, list[int]] = defaultdict(list)

    for uid in sorted_uids:
        record = article_rows[uid]
        articles.append(
            {
                "id": article_id[uid],
                "y": record["y"],
                "j": record["j"],
                "t": record["t"],
            }
        )
        ids = sorted({author_id[norm] for norm in article_authors[uid]})
        for left, right in itertools.combinations(ids, 2):
            pair_articles[f"{left}|{right}"].append(article_id[uid])

    years = [article["y"] for article in articles]
    payload = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
            "sourceFile": args.source.name,
            "source": "UTD Top 100 Business School Research Rankings author-affiliation extraction",
            "rowCount": row_count,
            "articleCount": len(articles),
            "authorCount": len(authors),
            "pairCount": len(pair_articles),
            "minYear": min(years),
            "maxYear": max(years),
            "caveats": [
                "Author names are normalized text labels, not disambiguated person identifiers.",
                "A conflict means two normalized names appear on the same UTD-indexed publication.",
                "Institution names are historical UTD article affiliations, not live appointment records.",
            ],
        },
        "authors": authors,
        "articles": articles,
        "pairs": dict(sorted(pair_articles.items(), key=lambda item: item[0])),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))
        handle.write("\n")

    print(f"Wrote {args.output}")
    print(
        f"{len(authors):,} authors, {len(articles):,} articles, "
        f"{len(pair_articles):,} coauthor pairs"
    )


if __name__ == "__main__":
    main()
