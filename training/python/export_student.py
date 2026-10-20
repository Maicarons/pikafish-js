"""Exports a trained checkpoint as a `.nnue` and verifies the round trip.

Splitting this off the trainer means a Kaggle run can keep producing checkpoints
while an export is made from the best of them, and it is how the smoke test in
`training/README.md` turns `student.pt` into something an engine can load.

    python training/python/export_student.py --checkpoint training/out/student.pt \\
        --out training/out/student.nnue --shards training/data/shards-all \\
        --verify-positions 500

The check is exact: the written file is read back through `nnue_io` and compared
with the model's quantised forward pass, which `parity_float.py` has already
shown to be the engine's arithmetic.  With `--engine` it goes one step further
and runs the net through a real engine of the same width.

`--engine` must be an engine built with the checkpoint's `L1` (`training/engine`
describes how); the command it runs is the dump tool on a FEN list, which is the
only way to compare against the engine's own evaluation of a net this narrow.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export as export_mod  # noqa: E402
import nnue_io  # noqa: E402
from model import StudentNet  # noqa: E402
from train import load_shard, shard_files, synthetic_cases  # noqa: E402


def build_model(checkpoint: dict) -> StudentNet:
    arch = checkpoint.get("architecture")
    if not arch:
        raise SystemExit("checkpoint has no `architecture`; it predates the current model")
    return StudentNet(
        features=arch["features"], half=arch["half"], l2=arch["l2"], l3=arch["l3"]
    )


def cases_from_shards(paths: list[Path], count: int, rng) -> list[tuple[np.ndarray, np.ndarray, int]]:
    cases = []
    for path in paths[:2]:
        shard = load_shard(path)
        n = len(shard["eval_internal"])
        picks = rng.choice(n, size=min(count, n), replace=False)
        stm_off, oth_off = shard["stm_offsets"], shard["oth_offsets"]
        for p in picks:
            p = int(p)
            cases.append(
                (
                    shard["stm_indices"][stm_off[p] : stm_off[p + 1]],
                    shard["oth_indices"][oth_off[p] : oth_off[p + 1]],
                    int(shard["bucket"][p]),
                )
            )
    return cases


def check_in_engine(net_path: Path, engine: Path, fens: Path, limit: int) -> bool:
    """Loads the net in a real engine and compares its evals with ours."""
    dump = Path(tempfile.mkdtemp(prefix="pikafish-export-")) / "dump.bin"
    result = subprocess.run(
        [str(engine), "dump", str(net_path), str(fens), str(dump)],
        capture_output=True,
        text=True,
    )
    if "net: " not in result.stderr or dump.exists() is False:
        print(f"engine refused the net:\n{result.stderr.strip()}")
        return False

    from reader import read_dump

    data = read_dump(dump)
    net = nnue_io.read_net(net_path)
    ev = nnue_io.Evaluator(net)
    total = min(limit, data.eval_internal.shape[0])
    step = max(1, data.eval_internal.shape[0] // total)
    bad = worst = 0
    for i in range(0, data.eval_internal.shape[0], step):
        stm = data.stm_indices[data.stm_offsets[i] : data.stm_offsets[i + 1]]
        oth = data.oth_indices[data.oth_offsets[i] : data.oth_offsets[i + 1]]
        delta = abs(int(ev.evaluate(stm, oth, int(data.bucket[i]))) - int(data.eval_internal[i]))
        worst = max(worst, delta)
        bad += delta != 0
    print(f"engine check: {total} positions, worst |delta| {worst}, mismatches {bad}")
    return bad == 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--shards", default="", help="shards to verify against")
    p.add_argument("--verify-positions", type=int, default=500)
    p.add_argument("--description", default="")
    p.add_argument("--engine", default="", help="engine built at this net's L1, to confirm loading")
    p.add_argument("--fens", default="", help="FEN list for the engine check")
    p.add_argument("--device", default="cpu")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args(argv[1:])

    rng = np.random.default_rng(args.seed)
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model = build_model(checkpoint)
    model.load_state_dict(checkpoint["model"])
    model.eval()
    model = model.double()  # the verification compares integers
    print(f"checkpoint {args.checkpoint} at step {checkpoint.get('step')}")
    print(model.describe())

    paths = shard_files(args.shards) if args.shards else []
    if args.shards and not paths:
        raise SystemExit(f"no shard-*.npz under {args.shards}")
    cases = (
        cases_from_shards(paths, args.verify_positions, rng)
        if paths
        else synthetic_cases(rng, model, args.verify_positions)
    )

    meta = export_mod.export_and_verify(
        model,
        args.out,
        args.description or f"pikafish-js L1={model.half} distilled (step {checkpoint.get('step')})",
        cases,
        extra={"step": checkpoint.get("step"), "shards": [str(x) for x in paths]},
    )

    if args.engine:
        if not args.fens:
            raise SystemExit("--engine needs --fens")
        ok = check_in_engine(Path(args.out), Path(args.engine), Path(args.fens), 4000)
        if not ok:
            return 1
        print("engine check passed")

    print(f"wrote {args.out} ({meta['bytes_zstd']} bytes, header {meta['header_hash']:#010x})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
