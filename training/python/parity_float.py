"""Float and export parity.

Three checks, in increasing independence:

1. `quantized model == engine`.  The model loaded with the teacher's weights must
   reproduce `Network::evaluate` exactly.  Only possible when the model's L1
   matches the teacher's, which is why the teacher is also the reference for the
   student's architecture.
2. `exported net == quantized model`.  `model_to_net` rounds and clips, and the
   quantized forward already rounds every parameter identically, so writing the
   net and evaluating it again must change nothing.  This is the invariant that
   matters for a student, whose net no teacher engine can load.
3. `smooth vs quantized`.  A diagnostic: the gap a model trained on the smooth
   relaxation would carry into the engine.

    python training/python/parity_float.py training/data/parity.bin assets/pikafish.nnue [n]
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export  # noqa: E402
import nnue_io  # noqa: E402
from reader import read_dump  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2

    dump_path, net_path = argv[1], argv[2]
    limit = int(argv[3]) if len(argv) > 3 else 2000

    net = nnue_io.read_net(net_path)
    dump = read_dump(dump_path)
    # Double precision: the fc_0 sums reach ~10^7, past float32's exact range.
    model = export.net_to_model(net, dtype=torch.float64)
    model.eval()

    total = dump.eval_internal.shape[0]
    n = min(total, limit)
    step = max(1, total // n)
    picks = list(range(0, total, step))[:n]

    print(f"model      {model.describe()}")
    print(f"sample     {len(picks)} of {total} positions, stride {step}")

    # Positions as index arrays; the evaluator runs off the same dump.
    cases = []
    for i in picks:
        bucket = int(dump.bucket[i])
        stm = dump.stm_indices[dump.stm_offsets[i] : dump.stm_offsets[i + 1]]
        oth = dump.oth_indices[dump.oth_offsets[i] : dump.oth_offsets[i + 1]]
        cases.append((i, bucket, stm, oth))

    stacks = {c[1] for c in cases}
    print(f"stacks     {len(stacks)} distinct")

    # (1) quantized model against the engine
    if model.half == net.l1:
        d = np.array(
            [
                export.float_evaluate(model, stm, oth, bucket) - float(dump.eval_internal[i])
                for i, bucket, stm, oth in cases
            ]
        )
        print(
            f"[1] engine  quantized model: rms {np.sqrt((d**2).mean()):7.4f} "
            f"max|d| {np.abs(d).max():7.2f} exact {(d == 0).mean() * 100:6.2f}%"
        )
        check1 = bool((d == 0).all())
    else:
        print(f"[1] skipped: model L1={model.half} but the teacher is L1={net.l1}")
        check1 = True

    # (2) the exported net against the quantized model
    exported = export.model_to_net(model, description=net.description)
    ev = nnue_io.Evaluator(exported)
    d2 = np.array(
        [
            float(ev.evaluate(stm, oth, bucket)) - export.float_evaluate(model, stm, oth, bucket)
            for _, bucket, stm, oth in cases
        ]
    )
    print(
        f"[2] export  quantized model: rms {np.sqrt((d2**2).mean()):7.4f} "
        f"max|d| {np.abs(d2).max():7.2f} exact {(d2 == 0).mean() * 100:6.2f}%"
    )
    check2 = bool((d2 == 0).all())

    if model.half == net.l1:
        d3 = np.array(
            [
                float(ev.evaluate(stm, oth, bucket)) - float(dump.eval_internal[i])
                for i, bucket, stm, oth in cases
            ]
        )
        print(
            f"[2b] export  engine: rms {np.sqrt((d3**2).mean()):7.4f} "
            f"max|d| {np.abs(d3).max():7.2f} exact {(d3 == 0).mean() * 100:6.2f}%"
        )
        check2 = check2 and bool((d3 == 0).all())

    # (3) diagnostic: the smooth relaxation the engine does not compute
    d4 = np.array(
        [
            export.float_evaluate(model, stm, oth, bucket, quantized=False) - float(ev.evaluate(stm, oth, bucket))
            for _, bucket, stm, oth in cases
        ]
    )
    print(
        f"[3] smooth  quantized:      rms {np.sqrt((d4**2).mean()):7.4f} "
        f"max|d| {np.abs(d4).max():7.2f}"
    )

    ok = check1 and check2
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
