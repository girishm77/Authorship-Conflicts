#!/usr/bin/env python3
"""Refresh the dashboard conflict index only when the UTD source changes."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_source_path(repo_root: Path) -> Path:
    return (
        repo_root
        / "../Marketing Publishing/data/utd/utd_author_affiliations_1990_2025.csv"
    ).resolve()


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Update data/conflict-index.json if the UTD source CSV changed."
    )
    parser.add_argument("--source", type=Path, default=default_source_path(repo_root))
    parser.add_argument("--output", type=Path, default=repo_root / "data/conflict-index.json")
    parser.add_argument(
        "--state",
        type=Path,
        default=repo_root / "data/conflict-index-source-state.json",
    )
    parser.add_argument("--force", action="store_true", help="Rebuild even if the source hash is unchanged.")
    return parser.parse_args()


def load_state(path: Path) -> dict | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_state(path: Path, source: Path, output: Path, source_hash: str) -> None:
    source_stat = source.stat()
    payload = {
        "sourcePath": str(source),
        "outputPath": str(output),
        "sourceSha256": source_hash,
        "sourceSize": source_stat.st_size,
        "sourceMtimeNs": source_stat.st_mtime_ns,
        "recordedAt": utc_now(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def backup_output(output: Path) -> Path | None:
    if not output.exists():
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = output.with_name(f"{output.name}.pre-{stamp}")
    shutil.copy2(output, backup)
    return backup


def load_output_meta(output: Path) -> dict:
    with output.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload.get("meta", {})


def main() -> None:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    source = args.source.resolve()
    output = args.output.resolve()
    state_path = args.state.resolve()

    if not source.exists():
        raise SystemExit(f"Source CSV not found: {source}")

    source_hash = sha256_file(source)
    previous = load_state(state_path)
    should_rebuild = args.force
    reason = "Forced rebuild requested."

    if not should_rebuild and previous:
        previous_hash = previous.get("sourceSha256")
        should_rebuild = previous_hash != source_hash
        reason = "Source checksum changed." if should_rebuild else "Source checksum unchanged."
    elif not should_rebuild and not output.exists():
        should_rebuild = True
        reason = "Output file is missing."
    elif not should_rebuild:
        output_mtime_ns = output.stat().st_mtime_ns
        source_mtime_ns = source.stat().st_mtime_ns
        should_rebuild = source_mtime_ns > output_mtime_ns
        reason = (
            "State file missing and source is newer than output."
            if should_rebuild
            else "State file missing; output is current, so recording baseline."
        )

    backup = None
    if should_rebuild:
        backup = backup_output(output)
        command = [
            sys.executable,
            str(repo_root / "scripts/build_conflict_data.py"),
            "--source",
            str(source),
            "--output",
            str(output),
        ]
        subprocess.run(command, cwd=repo_root, check=True)
        write_state(state_path, source, output, source_hash)
    elif previous is None:
        write_state(state_path, source, output, source_hash)

    print(f"source={source}")
    print(f"output={output}")
    print(f"state={state_path}")
    print(f"updated={str(should_rebuild).lower()}")
    print(f"reason={reason}")
    if backup:
        print(f"backup={backup}")

    if output.exists():
        meta = load_output_meta(output)
        if meta:
            print(f"generatedAt={meta.get('generatedAt', '')}")
            print(f"authorCount={meta.get('authorCount', '')}")
            print(f"articleCount={meta.get('articleCount', '')}")
            print(f"pairCount={meta.get('pairCount', '')}")


if __name__ == "__main__":
    main()
