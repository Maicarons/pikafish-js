"""Distillation trainer for a smaller Pikafish NNUE.

The objective is the engine's own: the model's quantised forward pass is
`Network::evaluate` (`parity_float.py` proves it exactly), so training on the
dump's `eval_internal` field minimises the difference the engine would see.

    python training/python/train.py --shards training/data/shards --steps 200000
    python training/python/train.py --synthetic --steps 50        # smoke test

Data layout, the dump format and the corrected scales are described in
`training/README.md`.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from export import verify_export
from model import StudentNet

# `UCIEngine::to_cp` divides the internal value by a position-dependent `a`
# (about 400), so the internal value is what the network actually predicts and
# cp is a re-scaled view of it.  Training therefore regresses on the internal
# value, in units of `EVAL_SCALE` (~= centipawns).
EVAL_SCALE = 400.0
# Win probability as a function of the internal value: sigmoid(cp * ln10 / 400)
# with cp = internal / 4.
WDL_SCALE = EVAL_SCALE * 4.0
LN10 = math.log(10.0)

# Bands of |eval| used by the optional reweighting, in internal units (400 = 1
# pawn-ish, so these are 0, 25, 75, 175, 375 cp and beyond).  A self-play corpus
# is a corpus of decided games: on the measured one 41% of the positions sit in
# 1500-4000 while only 12% are within 100 of equality, yet equality is where the
# search's move choice is actually decided.
EVAL_BINS = (0.0, 100.0, 300.0, 700.0, 1500.0, 4000.0)


def eval_weights(eval_internal: np.ndarray, power: float, clip: float) -> np.ndarray:
    """Per-position weights that give every |eval| band the same total weight.

    `power` tempers the correction: 1.0 equalises the bands exactly, 0.5 takes
    the square root of the correction (a gentler compromise), 0 disables it.
    The result is normalised to a mean of one, so the learning rate keeps its
    meaning, and clamped at `clip` so a nearly empty band cannot dominate.
    """
    magnitude = np.abs(np.asarray(eval_internal, dtype=np.float64))
    band = np.digitize(magnitude, EVAL_BINS)
    counts = np.bincount(band, minlength=len(EVAL_BINS) + 1).astype(np.float64)
    present = counts > 0
    per_band = np.ones_like(counts)
    equalised = present.copy()
    # The last band is the one the target clip flattens: every position in it is
    # labelled with the same saturating value, so it is not a band of its own.
    # It shares the weight of its neighbour instead of being equalised, which
    # would otherwise make it the heaviest band in the corpus.
    equalised[-1] = False
    per_band[equalised] = (magnitude.size / (equalised.sum() * counts[equalised])) ** power
    per_band[-1] = per_band[-2] if len(per_band) > 1 else 1.0
    weights = per_band[band]
    if clip > 0:
        weights = np.clip(weights, 0.0, clip)
    mean = weights.mean()
    return (weights / mean if mean else weights).astype(np.float32)


def collate(rows: list[tuple[np.ndarray, np.ndarray, np.ndarray, float]], device: torch.device):
    stm_idx, oth_idx, buckets, targets = [], [], [], []
    stm_off, oth_off = [0], [0]
    for s, o, b, t in rows:
        stm_idx.append(s)
        oth_idx.append(o)
        buckets.append(b)
        targets.append(t)
        stm_off.append(stm_off[-1] + len(s))
        oth_off.append(oth_off[-1] + len(o))
    si, so = _pack(stm_idx, stm_off, device)
    oi, oo = _pack(oth_idx, oth_off, device)
    return (
        si,
        so,
        oi,
        oo,
        torch.tensor(buckets, dtype=torch.long, device=device),
        torch.tensor(targets, dtype=torch.float32, device=device),
    )


def _pack(parts: list[np.ndarray], offsets: list[int], device: torch.device):
    indices = np.concatenate(parts) if parts else np.zeros(0, dtype=np.int32)
    return (
        torch.from_numpy(indices).to(device, non_blocking=True),
        torch.tensor(offsets[:-1], dtype=torch.long, device=device),
    )


def batch_indices(
    shard: dict,
    positions: np.ndarray,
    device: torch.device,
    clip: float,
    weights: np.ndarray | None = None,
):
    """Slice a shard for the given positions (kept sorted by the caller)."""
    stm_off = shard["stm_offsets"]
    oth_off = shard["oth_offsets"]
    # A shard may carry an alternative target (the teacher's search score, for
    # instance); when it does, that is what the trainer regresses on.
    target = shard.get("target_internal")
    if target is None:
        target = shard["eval_internal"]
    rows = []
    for p in positions:
        s = shard["stm_indices"][stm_off[p] : stm_off[p + 1]]
        o = shard["oth_indices"][oth_off[p] : oth_off[p + 1]]
        t = float(np.clip(target[p], -clip, clip)) / EVAL_SCALE
        rows.append((s, o, int(shard["bucket"][p]), t))
    w = None if weights is None else torch.from_numpy(weights[positions]).to(device)
    return (*collate(rows, device), w)


def synthetic_batch(rng: np.random.Generator, batch: int, device: torch.device, features: int):
    def draw():
        return np.sort(rng.choice(features, size=rng.integers(40, 96), replace=False)).astype(
            np.int32
        )

    rows = [
        (draw(), draw(), int(rng.integers(0, 32)), float(rng.normal(0.0, 1.0))) for _ in range(batch)
    ]
    return collate(rows, device)


def shard_files(directory: str | Path) -> list[Path]:
    return sorted(Path(directory).glob("shard-*.npz"))


def load_shard(path: Path) -> dict:
    with np.load(path) as data:
        return {k: data[k] for k in data.files}


def wdl_loss(
    pred_internal: torch.Tensor, target_internal: torch.Tensor, weights: torch.Tensor | None = None
) -> torch.Tensor:
    """Smooth L1 between the two implied win probabilities (bounded, scale free)."""
    k = LN10 / WDL_SCALE
    p = torch.sigmoid(pred_internal * k)
    t = torch.sigmoid(target_internal * k)
    return nn.functional.mse_loss(p, t, reduction="none" if weights is not None else "mean")


def loss_for(
    pred_internal: torch.Tensor,
    target_scaled: torch.Tensor,
    args: argparse.Namespace,
    weights: torch.Tensor | None = None,
) -> torch.Tensor:
    """`target_scaled` is the teacher's internal value already divided by EVAL_SCALE."""
    reduction = "none" if weights is not None else "mean"
    if args.huber:
        value = nn.functional.huber_loss(
            pred_internal / EVAL_SCALE, target_scaled, delta=args.huber, reduction=reduction
        )
    else:
        value = nn.functional.mse_loss(pred_internal / EVAL_SCALE, target_scaled, reduction=reduction)
    if args.wdl_weight:
        value = value + args.wdl_weight * wdl_loss(
            pred_internal, target_scaled * EVAL_SCALE, weights
        )
    if weights is not None:
        value = (value * weights).sum() / weights.sum()
    return value


def train(args: argparse.Namespace) -> None:
    device = torch.device(
        args.device if args.device else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    torch.manual_seed(args.seed)

    if args.init_from:
        # Warm start from the teacher, feature transformer narrowed to `half`.
        # See export.net_to_model: this keeps the activation range plausible but
        # changes which columns pair up, so the full connections are retrained.
        import export as export_mod
        import nnue_io

        teacher = nnue_io.read_net(args.init_from)
        model = export_mod.net_to_model(teacher, half=args.half).to(device)
        print(f"warm start from {args.init_from} (L1={teacher.l1} -> {args.half})")
    else:
        model = StudentNet(half=args.half, l2=args.l2, l3=args.l3, dropout=args.dropout).to(device)
    print(model.describe())

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(args.steps, 1))

    step = 0
    if args.resume:
        state = torch.load(args.resume, map_location=device, weights_only=False)
        model.load_state_dict(state["model"])
        if "opt" in state and not args.fresh_optimizer:
            opt.load_state_dict(state["opt"])
        step = state["step"]
        print(f"resumed from {args.resume} at step {step}")

    paths = [] if args.synthetic else shard_files(args.shards)
    if not args.synthetic and not paths:
        raise SystemExit(f"no shard-*.npz under {args.shards}; run dump + reader first")

    rng = np.random.default_rng(args.seed + step)
    started = time.time()
    positions_seen = 0
    running = 0.0

    model.train()
    if args.eval_weight_power > 0:
        print(
            f"eval weighting power {args.eval_weight_power} "
            f"(bands {' '.join(str(int(b)) for b in EVAL_BINS)} internal, clip {args.eval_weight_clip})"
        )
    while step < args.steps:
        if args.synthetic:
            shard, order, cursor, shard_w = None, None, 0, None
        else:
            shard = load_shard(paths[rng.integers(len(paths))])
            order = rng.permutation(len(shard["eval_internal"]))
            cursor = 0
            shard_w = (
                eval_weights(
                    shard["eval_internal"], args.eval_weight_power, args.eval_weight_clip
                )
                if args.eval_weight_power > 0
                else None
            )

        while step < args.steps:
            if shard is not None:
                if cursor >= len(order):
                    break
                take = np.sort(order[cursor : cursor + args.batch_size])
                cursor += len(take)
                batch = batch_indices(shard, take, device, args.target_clip, shard_w)
            else:
                batch = (*synthetic_batch(rng, args.batch_size, device, model.features), None)

            si, so, oi, oo, bucket, y, w = batch
            pred = model(si, so, oi, oo, bucket)
            loss = loss_for(pred, y, args, w)

            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip)
            opt.step()
            scheduler.step()

            step += 1
            positions_seen += y.numel()
            running = 0.95 * running + 0.05 * loss.item() if running else loss.item()

            if step % args.log_every == 0:
                elapsed = time.time() - started
                print(
                    f"step {step:7d}  loss {running:.5f}  "
                    f"{positions_seen / elapsed:7.0f} pos/s  lr {scheduler.get_last_lr()[0]:.2e}"
                )

            # Kaggle stops a session at twelve hours without warning, so the
            # checkpoint cannot wait for the end of the run.
            if args.save_every and step % args.save_every == 0:
                save_checkpoint(args.out, model, opt, step, args)
                print(f"saved {args.out} at step {step}")

            if args.max_minutes and (time.time() - started) / 60 >= args.max_minutes:
                print("time budget reached")
                step = args.steps

        if shard is not None and args.weight_clamp:
            # The quantised forward clips every weight anyway, so this only stops
            # a drifting float from being permanently pinned at the clip.
            with torch.no_grad():
                for p in (model.ft.weight, model.fc0_w, model.fc1_w, model.fc2_w):
                    p.clamp_(-args.weight_clamp, args.weight_clamp)

    save_checkpoint(args.out, model, opt, step, args)
    print(f"saved {args.out}")
    print(model.quantized_clone_report())

    if args.export:
        export_model(model, args, paths, rng, device)


def save_checkpoint(path: str | Path, model: StudentNet, opt, step: int, args) -> None:
    """Writes model, optimiser and enough of `args` to rebuild the run."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model": model.state_dict(),
            "opt": opt.state_dict(),
            "step": step,
            "args": vars(args),
            "architecture": {
                "features": model.features,
                "half": model.half,
                "l2": model.l2,
                "l3": model.l3,
                "stacks": model.stacks,
            },
        },
        out,
    )


def export_model(model: StudentNet, args: argparse.Namespace, paths: list[Path], rng, device) -> None:
    """Writes the engine's layout and checks the round trip."""
    import export as export_mod

    model.eval()
    model = model.double()  # verify_export needs exact integer arithmetic
    description = args.description or f"pikafish-js L1={model.half} distilled ({args.steps} steps)"

    cases = []
    if paths:
        # Verify on real positions: the exported net, read back, must produce the
        # model's quantised output exactly.
        for path in paths[:2]:
            shard = load_shard(path)
            n = len(shard["eval_internal"])
            picks = rng.choice(n, size=min(args.verify_positions, n), replace=False)
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
    else:
        cases = synthetic_cases(rng, model, args.verify_positions)

    export_mod.export_and_verify(
        model,
        args.export,
        description,
        cases,
        extra={"step": args.steps, "shards": [str(p) for p in paths], "init_from": args.init_from},
    )


def synthetic_cases(rng, model: StudentNet, count: int) -> list[tuple[np.ndarray, np.ndarray, int]]:
    """Feature-index triples that look like real positions, for a data-free check."""
    cases = []
    for _ in range(count):
        def draw():
            return np.sort(
                rng.choice(model.features, size=int(rng.integers(40, 96)), replace=False)
            ).astype(np.int32)

        cases.append((draw(), draw(), int(rng.integers(0, model.stacks))))
    return cases


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--shards", type=str, default="training/data/shards")
    p.add_argument("--synthetic", action="store_true", help="random data, for a smoke test")
    p.add_argument("--out", type=str, default="training/out/student.pt")
    p.add_argument("--resume", type=str, default="")
    p.add_argument("--fresh-optimizer", action="store_true")
    p.add_argument("--init-from", type=str, default="", help="teacher net to warm start from")
    p.add_argument("--steps", type=int, default=2000)
    p.add_argument("--batch-size", type=int, default=512)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-5)
    p.add_argument("--dropout", type=float, default=0.0)
    p.add_argument("--clip", type=float, default=1.0)
    p.add_argument("--weight-clamp", type=float, default=255.0, help="0 disables")
    p.add_argument("--target-clip", type=float, default=3000.0, help="internal units")
    p.add_argument("--wdl-weight", type=float, default=0.3)
    p.add_argument("--huber", type=float, default=0.0, help="delta; 0 uses MSE")
    p.add_argument(
        "--eval-weight-power",
        type=float,
        default=0.0,
        help="equalise the |eval| bands: 0 off, 0.5 gentle, 1.0 exact",
    )
    p.add_argument(
        "--eval-weight-clip", type=float, default=6.0, help="cap on the weight; 0 disables"
    )
    p.add_argument("--half", type=int, default=512, help="L1 width of the student")
    p.add_argument("--l2", type=int, default=32)
    p.add_argument("--l3", type=int, default=32)
    p.add_argument("--device", type=str, default="")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--log-every", type=int, default=100)
    p.add_argument(
        "--save-every",
        type=int,
        default=5000,
        help="checkpoint interval; 0 saves only at the end",
    )
    p.add_argument("--max-minutes", type=float, default=0.0)
    p.add_argument("--export", type=str, default="", help="write .nnue when done")
    p.add_argument("--description", type=str, default="")
    p.add_argument("--verify-positions", type=int, default=200)
    train(p.parse_args())


if __name__ == "__main__":
    main()
