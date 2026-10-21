"""Compares two nets over a dump: how far has the student drifted from the teacher?

The number that matters for a distilled net is the difference in the score the
engine would report.  It is measured in internal units (the network's own
output, which is what the trainer regresses on) and also approximated in
centipawns by dividing by 4, which is the ratio `UCIEngine::to_cp` uses for
typical positions (it is exact at `a == 400` and mildly position-dependent
otherwise).

    python training/python/compare_nets.py training/data/parity.bin \
        assets/pikafish.nnue training/out/warmstart.nnue [n]
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nnue_io  # noqa: E402
from reader import read_dump  # noqa: E402

CP_PER_INTERNAL = 0.25

# The bands the trainer can reweight (`train.EVAL_BINS`); kept here so this tool
# does not have to import torch just to print a table.
BANDS = (0.0, 100.0, 300.0, 700.0, 1500.0, 4000.0)


def print_bands(student: np.ndarray, teacher: np.ndarray, ref: np.ndarray) -> None:
    """Where the student's error lives, split by the teacher's own |eval|.

    A self-play corpus is dominated by decided positions, where a big error
    changes nothing about the move; the band near equality is what the search
    acts on, so it deserves its own number.
    """
    magnitude = np.abs(ref)
    edges = list(BANDS) + [float("inf")]
    print(f"{'|eval| band':>14} {'n':>7} {'mean|d|':>9} {'cp':>7} {'sign':>8} {'<=50cp':>8}")
    for lo, hi in zip(edges, edges[1:]):
        m = (magnitude >= lo) & (magnitude < hi)
        if not m.any():
            continue
        d = np.abs(student[m] - teacher[m])
        label = f"{lo:.0f}-{hi:.0f}" if np.isfinite(hi) else f"{lo:.0f}+"
        print(
            f"{label:>14} {int(m.sum()):7d} {d.mean():9.1f} "
            f"{d.mean() * CP_PER_INTERNAL:7.1f} "
            f"{(np.sign(student[m]) == np.sign(teacher[m])).mean() * 100:7.1f}% "
            f"{(d * CP_PER_INTERNAL <= 50).mean() * 100:7.1f}%"
        )


def evaluate_net(net: nnue_io.Net, dump, indices: list[int]) -> np.ndarray:
    ev = nnue_io.Evaluator(net)
    out = np.empty(len(indices), dtype=np.int64)
    for k, i in enumerate(indices):
        stm = dump.stm_indices[dump.stm_offsets[i] : dump.stm_offsets[i + 1]]
        oth = dump.oth_indices[dump.oth_offsets[i] : dump.oth_offsets[i + 1]]
        out[k] = ev.evaluate(stm, oth, int(dump.bucket[i]))
    return out


def main(argv: list[str]) -> int:
    positional = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    if len(positional) < 3:
        print(__doc__)
        return 2

    dump_path, a_path, b_path = positional[0], positional[1], positional[2]
    limit = int(positional[3]) if len(positional) > 3 else 0

    dump = read_dump(dump_path)
    a = nnue_io.read_net(a_path)
    b = nnue_io.read_net(b_path)

    total = dump.eval_internal.shape[0]
    step = max(1, total // limit) if limit else 1
    indices = list(range(0, total, step))
    if limit:
        indices = indices[:limit]

    print(f"dump    {dump_path} ({total} positions, using {len(indices)})")
    print(f"A       {a_path} (L1={a.l1}) {a.description.splitlines()[0]}")
    print(f"B       {b_path} (L1={b.l1}) {b.description.splitlines()[0]}")
    if a.l1 != b.l1:
        print(f"note    widths differ ({a.l1} vs {b.l1}); comparing behaviour, not weights")

    va = evaluate_net(a, dump, indices).astype(np.float64)
    vb = evaluate_net(b, dump, indices).astype(np.float64)
    ref = dump.eval_internal[indices].astype(np.float64)

    for name, v in (("A", va), ("B", vb)):
        print(
            f"{name} vs teacher: mean|d| {np.abs(v - ref).mean():8.1f} "
            f"rms {np.sqrt(((v - ref) ** 2).mean()):8.1f} "
            f"max {np.abs(v - ref).max():8.0f}   "
            f"sign {(np.sign(v) == np.sign(ref)).mean() * 100:5.1f}%"
        )

    d = vb - va
    print(f"B - A:  mean {d.mean():+9.1f}  mean|d| {np.abs(d).mean():9.1f}  rms {np.sqrt((d**2).mean()):9.1f}")
    print(f"        max|d| {np.abs(d).max():9.0f}   ~cp: mean|d| {np.abs(d).mean() * CP_PER_INTERNAL:7.1f}")
    for tol in (10, 25, 50, 100):
        frac = (np.abs(d) * CP_PER_INTERNAL <= tol).mean() * 100
        print(f"        within {tol:3d} cp: {frac:6.2f}%")
    print(f"        correlation {np.corrcoef(va, vb)[0, 1]:.6f}")
    print(f"        sign agreement {(np.sign(va) == np.sign(vb)).mean() * 100:.2f}%")

    if "--bands" in flags:
        print(f"\nB against the teacher, by the teacher's own |eval| (dump's labels)")
        print_bands(vb, ref, ref)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
