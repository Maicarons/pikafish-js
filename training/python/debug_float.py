"""Stage-by-stage comparison of the integer evaluator and the float model.

Used while hunting a mismatch; kept because a wrong stage shows up immediately
here rather than as a bad network three hours into a training run.

    python training/python/debug_float.py training/data/parity.bin assets/pikafish.nnue [index]
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export  # noqa: E402
import nnue_io  # noqa: E402
from reader import read_dump  # noqa: E402


def report(name: str, a: np.ndarray, b: np.ndarray) -> None:
    d = np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    print(f"{name:10s} max|d| {np.abs(d).max():10.4f}  mean|d| {np.abs(d).mean():8.4f}")
    if np.abs(d).max() > 1e-3:
        i = int(np.abs(d).argmax())
        print(f"           at {i}: int {np.asarray(a).ravel()[i]} float {np.asarray(b).ravel()[i]}")


def main(argv: list[str]) -> int:
    dump_path, net_path = argv[1], argv[2]
    index = int(argv[3]) if len(argv) > 3 else 0

    net = nnue_io.read_net(net_path)
    dump = read_dump(dump_path)
    ev = nnue_io.Evaluator(net)
    model = export.net_to_model(net)
    model.eval()

    bucket = int(dump.bucket[index])
    stm = dump.stm_indices[dump.stm_offsets[index] : dump.stm_offsets[index + 1]]
    oth = dump.oth_indices[dump.oth_offsets[index] : dump.oth_offsets[index + 1]]
    print(f"position #{index} bucket {bucket} engine eval {int(dump.eval_internal[index])}")
    print(f"  stm features {len(stm)}, other features {len(oth)}")

    rows = ev.rows
    half = net.l1 // 2

    def accum(indices):
        acc = ev.bias.copy()
        if len(indices):
            acc += rows[indices].sum(axis=0, dtype=np.int32)
        return acc

    def transform(acc):
        return (np.clip(acc[:half], 0, 255) * np.clip(acc[half:], 0, 255)) >> 9

    acc_stm, acc_oth = accum(stm), accum(oth)
    x_int = np.concatenate([transform(acc_stm), transform(acc_oth)])

    with torch.no_grad():
        stm_t = torch.from_numpy(stm.astype(np.int64))
        oth_t = torch.from_numpy(oth.astype(np.int64))
        z = torch.tensor([0], dtype=torch.int64)
        acc_s_t = model._accumulate(stm_t, z)
        acc_o_t = model._accumulate(oth_t, z)
        acc_s_f = acc_s_t[0].numpy()
        acc_o_f = acc_o_t[0].numpy()
        x_f = torch.cat([model._transform(acc_s_t), model._transform(acc_o_t)], 1)[0].numpy()

    report("acc_stm", acc_stm, acc_s_f)
    report("acc_oth", acc_oth, acc_o_f)
    report("x", x_int, x_f)

    stack = ev.stacks[bucket]
    o0_int = stack["fc0_b"] + stack["fc0_w"] @ x_int.astype(np.int32)
    t0 = np.clip(o0_int, -32768, 32767)
    sqr0_int = np.clip(((t0 * t0) >> 16) >> 5, -128, 127)
    clip0_int = np.clip(t0 >> 7, 0, 127)
    c1_int = np.concatenate([sqr0_int, clip0_int])

    with torch.no_grad():
        bx = torch.from_numpy(x_f[None].astype(np.float32))
        u = model._dense(model.fc0_w[bucket][None], bx)[0] + model.fc0_b[bucket][0]
        u_np = u.numpy()
        sqr0_f = (u * u / 128.0).clamp(0, 127).numpy()
        clip0_f = u.clamp(0, 127).numpy()

    report("u(=o0/128)", o0_int.astype(np.float64) / 128.0, u_np)
    report("sqr0", sqr0_int, sqr0_f)
    report("clip0", clip0_int, clip0_f)

    o1_int = stack["fc1_b"] + stack["fc1_w"] @ c1_int
    t1 = np.clip(o1_int, -32768, 32767)
    sqr1_int = np.clip(((t1 * t1) >> 16) >> 3, -128, 127)
    clip1_int = np.clip(t1 >> 6, 0, 127)

    with torch.no_grad():
        c1_t = torch.from_numpy(c1_int.astype(np.float32)[None])
        v = model._dense(model.fc1_w[bucket][None], c1_t)[0] + model.fc1_b[bucket][0]
        v_np = v.numpy()
        sqr1_f = (v * v / 128.0).clamp(0, 127).numpy()
        clip1_f = v.clamp(0, 127).numpy()

    report("v(=o1/64)", o1_int.astype(np.float64) / 64.0, v_np)
    report("sqr1", sqr1_int, sqr1_f)
    report("clip1", clip1_int, clip1_f)

    c2_int = np.concatenate([sqr0_int, clip0_int, sqr1_int, clip1_int])
    o2_int = int(stack["fc2_b"][0]) + int(stack["fc2_w"][0] @ c2_int)

    for name, a, b in (
        ("o0", o0_int / 128.0, u_np),
        ("o1", o1_int / 64.0, v_np),
    ):
        report(name, a, b)

    with torch.no_grad():
        c2_f = torch.from_numpy(c2_int.astype(np.float32)[None])
        o2_f = float(model._dense(model.fc2_w[bucket][None], c2_f)[0] + model.fc2_b[bucket][0])
    print(f"o2         int {o2_int}  float {o2_f:.4f}")

    fwd_int = o2_int + int(o0_int[30]) - int(o0_int[31])
    fwd_f = o2_f + 128.0 * (float(u_np[30]) - float(u_np[31]))
    print(f"fwd        int {fwd_int}  float {fwd_f:.4f}")
    print(f"eval       int {int(dump.eval_internal[index])}  float {fwd_f * 600 / 16384:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
