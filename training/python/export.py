"""Move weights between `nnue_io.Net` (int8, engine layout) and `StudentNet`.

The model keeps its parameters in the engine's own units, so both directions are
plain rounding and no scale factors are juggled:

* `net_to_model` — exact for a net of the model's width.  With
  `quantized=True` the model's forward pass then reproduces `Network::evaluate`
  *exactly* (see `parity_float.py`), which is what makes the training objective
  the engine's objective.
* `model_to_net` — rounds to int8/i32 and clips.  Nothing is rescaled.

`net_to_model` also projects a wider net down to a student's `L1`.  The column
map keeps the teacher's pairwise structure (see `projection`), so the student's
first `half/2` transformed features per perspective are the teacher's own and the
accumulator's distribution is unchanged; the discarded features and everything
that depended on them still have to be trained.  It is a warm start, not a
derivation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nnue_io  # noqa: E402
from model import FT_BIAS_MAX, StudentNet  # noqa: E402

I8 = (-128, 127)
I16 = (-32768, 32767)


def _i8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(x), *I8).astype(np.int8)


def _i32(x: np.ndarray) -> np.ndarray:
    return np.rint(x).astype(np.int32)


def projection(half: int, teacher_half: int) -> np.ndarray:
    """Column map from a student's feature-transformer columns to the teacher's.

    The engine's pairwise product folds the accumulator in half, so a student
    output `j` multiplies columns `(j, j + half/2)`, while the teacher's output
    `j` multiplies `(j, j + teacher_half/2)`.  Choosing

        student[j]         = teacher[j]                  for j < half/2
        student[j+half/2]  = teacher[j + teacher_half/2]  for j < half/2

    makes the student's first `half/2` transformed features per perspective
    *identical* to the teacher's, which is the strongest warm start available
    without retraining the feature transformer from scratch.

    The same map applies to `fc_0`'s input columns, because those are indexed by
    transformed-feature position in the same order.
    """
    if half > teacher_half:
        raise ValueError(f"cannot widen {teacher_half} to {half}")
    head = list(range(half // 2))
    tail = list(range(teacher_half // 2, teacher_half // 2 + half - half // 2))
    return np.array(head + tail, dtype=np.int64)


def net_to_model(
    net: nnue_io.Net, half: int | None = None, dtype: torch.dtype = torch.float32
) -> StudentNet:
    """Loads a net into a model, narrowing the feature transformer to `half`.

    With `half` equal to the teacher's width this is exact.  With a smaller
    `half` the feature-transformer columns and `fc_0`'s matching input columns
    are selected by `projection`, so the accumulator keeps the teacher's
    distribution and the retained transformed features are the teacher's own;
    the discarded ones still have to be learned.  See the module docstring.
    """
    half = half or net.l1
    columns = projection(half, net.l1)

    model = StudentNet(features=net.features, half=half)
    with torch.no_grad():
        model.ft.weight.copy_(
            torch.from_numpy(net.weights()[:, columns].astype(np.float32))
        )
        model.ft_bias.copy_(torch.from_numpy(net.ft_bias[columns].astype(np.float32)))

        for s, stack in enumerate(net.stacks):
            model.fc0_w[s].copy_(
                torch.from_numpy(stack["fc0_w"][:, columns].astype(np.float32))
            )
            model.fc0_b[s].copy_(torch.from_numpy(stack["fc0_b"].astype(np.float32)))
            model.fc1_w[s].copy_(torch.from_numpy(stack["fc1_w"].astype(np.float32)))
            model.fc1_b[s].copy_(torch.from_numpy(stack["fc1_b"].astype(np.float32)))
            model.fc2_w[s].copy_(torch.from_numpy(stack["fc2_w"].astype(np.float32)))
            model.fc2_b[s].copy_(torch.from_numpy(stack["fc2_b"].astype(np.float32)))

    return model.to(dtype)


def model_to_net(
    model: StudentNet,
    *,
    description: str = "pikafish-js distilled student",
    header_hash: int | None = None,
    ft_hash: int | None = None,
    arch_hash: int | None = None,
) -> nnue_io.Net:
    """Quantises a model into the engine's int8 layout.

    The architecture hashes come from `nnue_io.ARCH_HASHES` for the model's
    width: an engine of that width only loads a net whose header hash matches
    its own compile-time constant.
    """
    with torch.no_grad():
        ft_w = model.ft.weight.detach().cpu().numpy()
        ft_b = model.ft_bias.detach().cpu().numpy()

        stacks = []
        for s in range(model.stacks):
            stacks.append(
                {
                    "fc0_b": _i32(model.fc0_b[s].detach().cpu().numpy()),
                    "fc0_w": _i8(model.fc0_w[s].detach().cpu().numpy()),
                    "fc1_b": _i32(model.fc1_b[s].detach().cpu().numpy()),
                    "fc1_w": _i8(model.fc1_w[s].detach().cpu().numpy()),
                    "fc2_b": _i32(model.fc2_b[s].detach().cpu().numpy()),
                    "fc2_w": _i8(model.fc2_w[s].detach().cpu().numpy()),
                }
            )

    if model.half in nnue_io.ARCH_HASHES:
        default_ft, default_arch = nnue_io.ARCH_HASHES[model.half]
        ft_hash = default_ft if ft_hash is None else ft_hash
        arch_hash = default_arch if arch_hash is None else arch_hash
        header_hash = (ft_hash ^ arch_hash) if header_hash is None else header_hash

    net = nnue_io.Net(
        description=description,
        ft_bias=np.clip(np.rint(ft_b), *I16).astype(np.int16),
        threat=_i8(ft_w[: nnue_io.THREAT_DIM]),
        psq=_i8(ft_w[nnue_io.THREAT_DIM :]),
        stacks=stacks,
    )
    if header_hash is not None:
        net.header_hash = header_hash
    if ft_hash is not None:
        net.ft_hash = ft_hash
    if arch_hash is not None:
        net.arch_hash = arch_hash
    return net


def verify_export(
    model: StudentNet,
    net: nnue_io.Net,
    cases: list[tuple[np.ndarray, np.ndarray, int]],
) -> tuple[int, int]:
    """Compares the written net (through the integer evaluator) with the model.

    `model_to_net` rounds, and the quantised forward rounds identically, so the
    two must agree exactly.  This is the gate a student has to pass before its
    net is worth running in an engine: no teacher engine can load a 512-wide net,
    so this stands in for the engine-side parity check.

    Run the model in double precision first (`model.to(torch.float64)`); the
    largest intermediate sums approach float32's exact-integer range.

    Returns `(checked, mismatches)`.
    """
    ev = nnue_io.Evaluator(net)
    bad = 0
    for stm, oth, bucket in cases:
        want = export_integer(model, stm, oth, bucket)
        got = ev.evaluate(stm, oth, bucket)
        if got != want:
            bad += 1
    return len(cases), bad


def export_integer(model: StudentNet, stm: np.ndarray, oth: np.ndarray, bucket: int) -> int:
    """The model's quantised forward, as an integer (it is one)."""
    return int(round(float_evaluate(model, stm, oth, bucket, quantized=True)))


def export_and_verify(
    model: StudentNet,
    out_path: str | Path,
    description: str,
    cases: list[tuple[np.ndarray, np.ndarray, int]],
    extra: dict | None = None,
) -> dict:
    """Writes the engine's layout next to a `.json` report, and checks the round trip.

    Both copies are written: the zstd frame is what an engine loads, and the
    plain one is what `nnue_io` and any byte comparison want.  The model is left
    in place; a caller that needs the check to be exact should have converted it
    to double first.
    """
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    net = model_to_net(model, description=description)
    plain = nnue_io.write_net(net, out.with_suffix(".plain.nnue"), compress=False)
    size = nnue_io.write_net(net, out, compress=True)
    print(f"exported {out} ({size} bytes zstd, {plain} plain)")

    reread = nnue_io.read_net(out)
    checked, bad = verify_export(model, reread, cases)
    print(f"verified {checked} positions against the written net: {checked - bad} exact, {bad} bad")

    meta = {
        "description": description,
        "half": model.half,
        "stacks": model.stacks,
        "features": model.features,
        "bytes_zstd": size,
        "bytes_plain": plain,
        "ft_hash": reread.ft_hash,
        "arch_hash": reread.arch_hash,
        "header_hash": reread.header_hash,
        "verified_positions": checked,
        "verify_mismatches": bad,
    }
    meta.update(extra or {})
    out.with_suffix(".json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(meta, indent=2))
    if bad:
        raise SystemExit("export verification failed: the net is not what the model computes")
    return meta


def export_report(model: StudentNet) -> str:
    """What quantisation costs, per weight matrix."""
    rows = [
        ("ft", model.ft.weight, 127.0),
        ("ft_bias", model.ft_bias, float(FT_BIAS_MAX)),
        ("fc0", model.fc0_w, 127.0),
        ("fc0_b", None, None),
        ("fc1", model.fc1_w, 127.0),
        ("fc2", model.fc2_w, 127.0),
    ]
    out = []
    for name, w, limit in rows:
        if w is None:
            continue
        a = w.detach().abs()
        frac = (a > limit).float().mean().item() * 100 if limit else 0.0
        out.append(f"{name:8s} mean {a.mean():8.2f} max {a.max():9.1f} clipped {frac:5.2f}%")
    return "\n".join(out)


def float_evaluate(
    model: StudentNet,
    stm: np.ndarray,
    oth: np.ndarray,
    bucket: int,
    *,
    quantized: bool = True,
) -> float:
    """Runs the model on one position the way `nnue_io.Evaluator` does.

    The model is left alone; inputs are cast to its own parameter dtype, so the
    caller chooses the precision (`model.to(torch.float64)` for exactness).
    """
    dtype = next(model.parameters()).dtype
    device = next(model.parameters()).device
    with torch.no_grad():
        out = model(
            torch.from_numpy(stm.astype(np.int64)).to(device),
            torch.tensor([0], dtype=torch.int64, device=device),
            torch.from_numpy(oth.astype(np.int64)).to(device),
            torch.tensor([0], dtype=torch.int64, device=device),
            torch.tensor([bucket], dtype=torch.int64, device=device),
            quantized=quantized,
        )
        return float(out[0].to(dtype))
