"""Prepare a FEN list for `pikafish-dump`.

Sources are plain text (one FEN per line; `#` comments) or JSONL with a "fen"
field, which is what the demo's game logs and most xiangqi datasets look like.

Deduplication is on the first two FEN fields (placement and side to move):
transposition-heavy game databases repeat those constantly, and duplicate
positions carry no extra gradient signal.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


def iter_fens(paths: list[Path]):
    for path in paths:
        if path.suffix == ".jsonl":
            with path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        fen = json.loads(line).get("fen")
                    except json.JSONDecodeError:
                        continue
                    if fen:
                        yield fen
            continue

        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    yield line


def normalise(fen: str) -> str | None:
    parts = fen.split()
    if len(parts) < 2:
        return None
    if parts[1] not in ("w", "b"):
        return None
    # Keep four fields; the halfmove clocks are irrelevant for evaluation.
    return " ".join(parts[:4])


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("inputs", nargs="+", type=Path)
    p.add_argument("-o", "--out", type=Path, required=True)
    p.add_argument("--sample", type=int, default=0, help="keep at most N positions")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    seen: set[str] = set()
    kept: list[str] = []
    total = 0

    for fen in iter_fens(args.inputs):
        total += 1
        norm = normalise(fen)
        if not norm:
            continue
        key = " ".join(norm.split()[:2])
        if key in seen:
            continue
        seen.add(key)
        kept.append(norm)

    if args.sample and len(kept) > args.sample:
        random.Random(args.seed).shuffle(kept)
        kept = kept[: args.sample]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(kept) + "\n", encoding="utf-8")
    print(f"{total} lines -> {len(kept)} unique positions -> {args.out}")


if __name__ == "__main__":
    main()
