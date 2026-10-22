"""Turns per-position labels into a training corpus with an alternative target.

The dump holds the teacher's static evaluation; `label_search.py` can hold the
teacher's search score for the same positions.  This tool puts the second one
next to the first, so the trainer can regress on either.

    python training/python/apply_labels.py --dump training/out/all.bin \
        --labels training/out/search-labels.tsv --out-shards training/out/shards-search

The dump's sidecar (`<dump>.fens.txt`) says which FENs it actually kept, and in
which order, which is what lines the labels up with the feature rows: the engine
drops the positions where the side to move is in check, and those are 7% of a
self-play corpus.

The engine prints centipawns while the network speaks internal units, and the
conversion between them depends a little on the position, so the factor is
measured from the dump itself rather than assumed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from reader import read_dump, write_shards  # noqa: E402


def read_labels(path: str | Path) -> dict[str, int]:
    labels: dict[str, int] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        fen, score = line.rsplit("\t", 1)
        labels[fen.strip()] = int(score)
    return labels


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dump", required=True)
    p.add_argument("--labels", required=True)
    p.add_argument("--out-shards", required=True)
    p.add_argument(
        "--clip",
        type=float,
        default=4000.0,
        help="internal units, the same ceiling the trainer uses",
    )
    p.add_argument("--per-shard", type=int, default=200_000)
    args = p.parse_args(argv[1:])

    dump = read_dump(args.dump)
    sidecar = Path(str(args.dump) + ".fens.txt")
    if not sidecar.exists():
        print(f"{sidecar} is missing; the labels cannot be lined up")
        return 2
    fens = [line.strip() for line in sidecar.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(fens) != len(dump):
        print(f"the sidecar has {len(fens)} positions, the dump {len(dump)}")
        return 2

    labels = read_labels(args.labels)
    missing = [fen for fen in fens if fen not in labels]
    if missing:
        print(f"{len(missing)} positions have no label (first: {missing[0]})")
        return 2

    # internal = cp * factor, and the factor is only mildly position dependent.
    ratio = np.abs(dump.eval_internal.astype(np.float64)) / np.maximum(
        np.abs(dump.cp.astype(np.float64)), 1
    )
    strong = np.abs(dump.cp) >= 50
    factor = float(np.median(ratio[strong]))
    print(
        f"internal per cp: median {factor:.3f} "
        f"(p10 {np.percentile(ratio[strong], 10):.3f}, p90 {np.percentile(ratio[strong], 90):.3f})"
    )

    search = np.array([labels[fen] for fen in fens], dtype=np.float64)
    target = np.clip(search * factor, -args.clip, args.clip).astype(np.int32)
    print(
        f"target mean |t| {np.abs(target).mean():.0f} "
        f"(the static evaluation is {np.abs(dump.eval_internal).mean():.0f})"
    )
    print(
        f"sign agreement with the static evaluation: "
        f"{(np.sign(search) == np.sign(dump.cp)).mean() * 100:.1f}%"
    )

    dump.target_internal = target
    paths = write_shards(dump, args.out_shards, per_shard=args.per_shard)
    print(f"wrote {len(paths)} shard(s) to {args.out_shards}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
