#!/usr/bin/env python3
"""Merge initial-variant author nodes in the conflict index.

The conflict index keys authors by a literal normalized name string, so a
person recorded inconsistently across UTD articles (e.g. "Krista J Li" on most
papers but "Krista Li" on one) shows up as two distinct author nodes. That
splits their publication record and produces incomplete conflict checks.

This module collapses such variants using a deliberately *conservative*
heuristic, remaps the coauthor pairs onto the surviving (canonical) node, and
records the absorbed name keys as aliases so the dashboard can resolve any
spelling of the name to the merged node.

Merge rule (within a group sharing the same first + last token):
  * Two nodes that both carry middle tokens merge only when every aligned
    middle token is identical or an initial-expansion of the other
    ("krista j li" + "krista jingyi li" -> yes; "john a smith" + "john b
    smith" -> no).
  * A node with no middle token ("krista li") is absorbed only when the group
    contains exactly one middle-bearing cluster, so an ambiguous bare name that
    could belong to several distinct people is left untouched.
  * Single-token names are never merged.

The transformation is idempotent: re-running on an already-merged payload makes
no further changes. It can be used as a standalone script or imported and
applied to an in-memory payload (see merge_payload) from the build pipeline.
"""

from __future__ import annotations

import argparse
import json
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path


def _tokens(key: str) -> list[str]:
    return [t for t in key.split(" ") if t]


def _split(key: str) -> tuple[str, str, list[str]] | None:
    """Return (first, last, middles) or None for unmergeable single-token keys."""
    parts = _tokens(key)
    if len(parts) < 2:
        return None
    return parts[0], parts[-1], parts[1:-1]


def _middles_compatible(a: list[str], b: list[str]) -> bool:
    """True if two middle-token sequences can be the same person.

    Aligned left-to-right: each pair must be equal or an initial-expansion
    (one side a single char that prefixes the other). Trailing extra middles
    on the longer side are allowed (a dropped middle name).
    """
    for x, y in zip(a, b):
        if x == y:
            continue
        if len(x) == 1 and y.startswith(x):
            continue
        if len(y) == 1 and x.startswith(y):
            continue
        return False
    return True


def _cluster_middle_nodes(nodes: list[dict]) -> list[list[dict]]:
    """Cluster middle-bearing nodes; a node joins a cluster only if it is
    compatible with *every* current member (guards against non-transitive
    chains like [a]-[]-[b])."""
    clusters: list[list[dict]] = []
    for node in nodes:
        placed = False
        for cluster in clusters:
            if all(_middles_compatible(node["_mid"], m["_mid"]) for m in cluster):
                cluster.append(node)
                placed = True
                break
        if not placed:
            clusters.append([node])
    return clusters


def _pick_canonical(cluster: list[dict]) -> dict:
    """Highest article count wins; ties broken by longest then lexical name."""
    return sorted(
        cluster,
        key=lambda n: (-n.get("c", 0), -len(n.get("n", "")), n.get("n", "")),
    )[0]


def _plan_merges(authors: list[dict]) -> list[list[dict]]:
    """Return clusters of >=2 author nodes that should be merged."""
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for author in authors:
        parsed = _split(author["k"])
        if parsed is None:
            continue
        first, last, middles = parsed
        author["_mid"] = middles
        groups[(first, last)].append(author)

    merges: list[list[dict]] = []
    for nodes in groups.values():
        if len(nodes) < 2:
            continue
        middle_nodes = [n for n in nodes if n["_mid"]]
        bare_nodes = [n for n in nodes if not n["_mid"]]
        clusters = _cluster_middle_nodes(middle_nodes)

        if len(clusters) == 1:
            # One unambiguous identity: absorb any bare-name variants too.
            cluster = clusters[0] + bare_nodes
            if len(cluster) >= 2:
                merges.append(cluster)
        else:
            # Multiple distinct middle identities: only merge within each
            # middle cluster that itself has duplicates; leave bare names alone.
            for cluster in clusters:
                if len(cluster) >= 2:
                    merges.append(cluster)
    return merges


def merge_payload(payload: dict, *, verbose: bool = False) -> dict:
    """Apply alias merging to a conflict-index payload, iterating to a fixed point.

    Absorbing one spelling variant can make a further merge valid (a blocking
    variant is removed), so a single pass is not always complete. We repeat
    until a pass makes no change, which is stable and order-independent.
    """
    passes = 0
    while True:
        before = len(payload["authors"])
        _merge_once(payload, verbose=verbose)
        passes += 1
        if len(payload["authors"]) == before:
            break
    if verbose and passes > 1:
        print(f"Converged after {passes} passes.")
    return payload


def _merge_once(payload: dict, *, verbose: bool = False) -> dict:
    """Apply one pass of alias merging to a payload in place and return it."""
    authors: list[dict] = payload["authors"]
    pairs: dict[str, list[int]] = payload["pairs"]

    # Article-id sets per author from pairs, to estimate overlap when merging.
    arts_by_author: dict[int, set[int]] = defaultdict(set)
    for key, aids in pairs.items():
        left, right = (int(x) for x in key.split("|"))
        arts_by_author[left].update(aids)
        arts_by_author[right].update(aids)

    merges = _plan_merges(authors)
    remap: dict[int, int] = {}
    canonical_ids: set[int] = set()
    merge_log: list[tuple[str, list[str]]] = []

    for cluster in merges:
        canonical = _pick_canonical(cluster)
        cid = canonical["id"]
        canonical_ids.add(cid)
        absorbed = [n for n in cluster if n["id"] != cid]

        # Aliases: every name key in the cluster plus any already accumulated
        # on the members (so multi-pass merges keep all prior spellings).
        existing = set(canonical.get("al", []))
        for n in cluster:
            existing.add(n["k"])
            existing.update(n.get("al", []))
        existing.discard(canonical["k"])  # canonical key is author.k itself
        canonical["al"] = sorted(existing)

        # Years.
        canonical["f"] = min(n["f"] for n in cluster)
        canonical["l"] = max(n["l"] for n in cluster)

        # Latest affiliation: from the node with the most recent uy.
        latest = max(
            (n for n in cluster if n.get("uy") is not None),
            key=lambda n: n["uy"],
            default=canonical,
        )
        canonical["u"] = latest.get("u", canonical.get("u", ""))
        canonical["uy"] = latest.get("uy", canonical.get("uy"))

        # Institutions: union preserving canonical-first order, capped at 3.
        insts: list[str] = []
        for n in [canonical] + absorbed:
            for inst in n.get("i", []):
                if inst and inst not in insts:
                    insts.append(inst)
        canonical["i"] = insts[:3]

        # Article count: union estimate (sum minus detectable shared articles).
        shared = 0
        sets = [arts_by_author.get(n["id"], set()) for n in cluster]
        for s1, s2 in combinations(sets, 2):
            shared += len(s1 & s2)
        canonical["c"] = max(
            sum(n.get("c", 0) for n in cluster) - shared,
            max(n.get("c", 0) for n in cluster),
        )

        for n in absorbed:
            remap[n["id"]] = cid

        merge_log.append((canonical["n"], [n["n"] for n in absorbed]))

    # Drop the temporary middle-token helper.
    for author in authors:
        author.pop("_mid", None)

    if not remap:
        if verbose:
            print("No alias merges needed (already merged or none found).")
        return payload

    # Remove absorbed author nodes.
    payload["authors"] = [a for a in authors if a["id"] not in remap]

    # Remap pairs onto canonical ids, dedup article lists, drop self-pairs.
    remapped: dict[str, set[int]] = defaultdict(set)
    for key, aids in pairs.items():
        left, right = (int(x) for x in key.split("|"))
        left = remap.get(left, left)
        right = remap.get(right, right)
        if left == right:
            continue  # both names were the same merged person
        a, b = (left, right) if left < right else (right, left)
        remapped[f"{a}|{b}"].update(aids)

    payload["pairs"] = {
        k: sorted(v) for k, v in sorted(remapped.items(), key=lambda kv: kv[0])
    }

    # Meta bookkeeping.
    meta = payload.setdefault("meta", {})
    meta["authorCount"] = len(payload["authors"])
    meta["pairCount"] = len(payload["pairs"])
    meta["aliasMergedAt"] = (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    meta["aliasMergeCount"] = len(merge_log)
    note = (
        "Author name variants differing only by middle initials were merged "
        "into a single person (conservative first+last+initial matching)."
    )
    caveats = meta.setdefault("caveats", [])
    if note not in caveats:
        caveats.append(note)

    if verbose:
        print(f"Merged {len(remap)} node(s) into {len(merge_log)} canonical author(s):")
        for canonical_name, absorbed_names in sorted(merge_log):
            print(f"  {canonical_name}  <-  {', '.join(absorbed_names)}")

    return payload


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--path", type=Path, default=repo_root / "data/conflict-index.json"
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Do not write a .bak copy before overwriting.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the merges without writing the file.",
    )
    args = parser.parse_args()

    with args.path.open(encoding="utf-8") as handle:
        payload = json.load(handle)

    before = len(payload["authors"])
    merge_payload(payload, verbose=True)
    after = len(payload["authors"])

    if args.dry_run:
        print(f"[dry-run] authors {before} -> {after}; no file written.")
        return

    if not args.no_backup:
        backup = args.path.with_suffix(args.path.suffix + ".bak")
        shutil.copy2(args.path, backup)
        print(f"Backup written to {backup}")

    with args.path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))
        handle.write("\n")
    print(f"Wrote {args.path} ({before} -> {after} authors).")


if __name__ == "__main__":
    main()
