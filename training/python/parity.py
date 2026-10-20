"""Parity gate: does our reading of the network match the engine?

`nnue_io.evaluate` is an independent reimplementation of `Network::evaluate`
in numpy.  It is run over a dump produced by `pikafish-dump`, and every value
must equal the engine's own `eval` to the last unit.  A single mismatch means
some part of the layout, the activation or the scaling is wrong, and no
training run should start before this passes.

    python training/python/parity.py training/data/parity.bin assets/pikafish.nnue
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nnue_io  # noqa: E402
from reader import read_dump  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2

    dump_path, net_path = argv[1], argv[2]
    limit = int(argv[3]) if len(argv) > 3 else 0

    net = nnue_io.read_net(net_path)
    dump = read_dump(dump_path)
    evaluator = nnue_io.Evaluator(net)

    n = dump.eval_internal.shape[0]
    if limit:
        n = min(n, limit)

    print(f"net        {net_path}")
    print(f"  {net.description.splitlines()[0]}")
    print(f"  L1={net.l1} features={net.features} stacks={len(net.stacks)}")
    print(f"dump       {dump_path} ({dump.eval_internal.shape[0]} positions)")

    buckets = Counter()
    mismatches: list[tuple[int, int, int]] = []
    worst = 0

    for i in range(n):
        bucket = int(dump.bucket[i])
        buckets[bucket] += 1

        stm = dump.stm_indices[dump.stm_offsets[i] : dump.stm_offsets[i + 1]]
        oth = dump.oth_indices[dump.oth_offsets[i] : dump.oth_offsets[i + 1]]

        got = evaluator.evaluate(stm, oth, bucket)
        want = int(dump.eval_internal[i])
        delta = abs(got - want)
        worst = max(worst, delta)
        if delta and len(mismatches) < 10:
            mismatches.append((i, want, got))
        elif delta:
            mismatches.append((i, want, got))

    checked = n
    bad = sum(1 for _ in mismatches)
    print(f"checked    {checked} positions, worst |delta| = {worst}")

    if bad:
        print(f"FAIL  {bad} mismatches, e.g.")
        for i, want, got in mismatches[:10]:
            print(f"  #{i}: engine {want}, ours {got}")
        return 1

    print("PASS  every position reproduced exactly")
    print(f"layer-stack buckets covered: {sorted(buckets)}")
    missing = [b for b in range(nnue_io.LAYER_STACKS) if b not in buckets]
    if missing:
        print(f"WARNING buckets never exercised: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
