"""Labels positions with the teacher's *search* score instead of its static eval.

The distilled net currently regresses on `eval_internal`, the value the network
returns for a position.  But the engine does not play on that value: it plays on
its search result.  A net that reproduces a search score therefore aims at what
the engine actually does, and the difference between the two targets is exactly
what a static net of the same width cannot copy.

    python training/python/label_search.py --fens training/out/fens-normal/normal.txt \
        --engine upstream/src/pikafish.exe --nodes 4000 --out training/data/search-labels.tsv

The output is one `fen<TAB>centipawns` per line, in the order of the input.
Positions where the search finds a mate are clamped to +/- 30000, and the
score is the side to move's point of view, like every other label here.
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from selfplay import Engine  # noqa: E402

SCORE_CP = re.compile(r"\bscore cp (-?\d+)")
SCORE_MATE = re.compile(r"\bscore mate (-?\d+)")
MATE_CP = 30_000

_ENGINE: Engine | None = None
_ENGINE_PATH = ""
_NODES = 0


def _worker_init(engine_path: str, nodes: int) -> None:
    global _ENGINE, _ENGINE_PATH, _NODES
    _ENGINE_PATH = engine_path
    _NODES = nodes
    _ENGINE = Engine(engine_path, timeout=120.0, cwd=Path(engine_path).parent)
    _ENGINE.send("setoption name Threads value 1")
    _ENGINE.send("setoption name Hash value 32")
    _ENGINE.send("isready")
    _ENGINE.read_until("readyok")


def _score(engine: Engine, fen: str, nodes: int) -> int | None:
    engine.send(f"position fen {fen}")
    engine.send(f"go nodes {nodes}")
    lines = engine.read_until("bestmove")
    if lines is None:
        return None
    score: int | None = None
    for line in lines:
        found = SCORE_CP.search(line)
        if found:
            score = int(found.group(1))
        found = SCORE_MATE.search(line)
        if found:
            mate = int(found.group(1))
            score = MATE_CP if mate > 0 else -MATE_CP
    return score


def _label_chunk(fens: list[str]) -> list[str]:
    assert _ENGINE is not None
    out: list[str] = []
    for fen in fens:
        score = _score(_ENGINE, fen, _NODES)
        if score is None:
            return out
        out.append(f"{fen}\t{score}")
    return out


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fens", required=True)
    p.add_argument("--engine", required=True, help="path to the teacher engine")
    p.add_argument("--nodes", type=int, default=4000)
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--out", required=True)
    args = p.parse_args(argv[1:])

    fens = [
        line.strip()
        for line in Path(args.fens).read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    if args.limit:
        fens = fens[: args.limit]

    chunk = max(64, len(fens) // (args.workers * 8))
    chunks = [fens[i : i + chunk] for i in range(0, len(fens), chunk)]
    started = time.time()
    labelled: list[str] = []
    with futures.ProcessPoolExecutor(
        max_workers=args.workers,
        initializer=_worker_init,
        initargs=(args.engine, args.nodes),
    ) as pool:
        for part in pool.map(_label_chunk, chunks):
            labelled.extend(part)
            print(
                f"  {len(labelled):7d}/{len(fens)}  "
                f"{(time.time() - started) / 60:5.1f} min",
                flush=True,
            )

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text("\n".join(labelled) + "\n", encoding="utf-8")
    print(f"wrote {len(labelled)} labels to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
