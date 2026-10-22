"""Readers and writers for the training data produced by `pikafish-dump`.

The dump format is defined in `training/engine/dump_tool.cpp`; keep the two in
sync.  A dump is one pass over a FEN list and contains, per position, the
active feature indices for both perspectives plus the teacher evaluation, so a
single pass over a game database yields everything training needs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAGIC = b"PKFD"
VERSION = 2
HEADER_SIZE = 20
RECORD_HEADER = 20  # 4 x u16 counts + u32 bucket + i32 eval + i32 centipawns

THREAT_DIM = 45_547


@dataclass
class Dump:
    stm_offsets: np.ndarray  # int64 [n + 1]
    stm_indices: np.ndarray  # int32 [m]
    oth_offsets: np.ndarray  # int64 [n + 1]
    oth_indices: np.ndarray  # int32 [m]
    bucket: np.ndarray  # uint8 [n], which of the 32 layer stacks applies
    eval_internal: np.ndarray  # int32 [n], side-to-move POV, engine units
    cp: np.ndarray  # int32 [n], side-to-move POV, display centipawns
    threat_dim: int
    psq_dim: int
    # Optional alternative regression target, in the same internal units as
    # `eval_internal` (the teacher's search score, for instance).  The trainer
    # uses it when a shard carries it.
    target_internal: np.ndarray | None = None

    def __len__(self) -> int:
        return int(self.cp.shape[0])


def read_dump(path: str | Path) -> Dump:
    raw = Path(path).read_bytes()
    if len(raw) < HEADER_SIZE or raw[:4] != MAGIC:
        raise ValueError(f"{path}: not a PKFD dump")

    version, count, threat_dim, psq_dim = np.frombuffer(
        raw, dtype="<u4", count=4, offset=4
    )
    if version != VERSION:
        raise ValueError(f"{path}: unsupported dump version {version}")

    stm_offsets = np.zeros(count + 1, dtype=np.int64)
    oth_offsets = np.zeros(count + 1, dtype=np.int64)
    bucket = np.zeros(count, dtype=np.uint8)
    eval_internal = np.zeros(count, dtype=np.int32)
    cp = np.zeros(count, dtype=np.int32)

    stm_lists: list[np.ndarray] = []
    oth_lists: list[np.ndarray] = []
    view = memoryview(raw)
    off = HEADER_SIZE

    for i in range(count):
        counts = np.frombuffer(view, dtype="<u2", count=4, offset=off)
        n_st, n_sp, n_ot, n_op = (int(x) for x in counts)
        b = int.from_bytes(raw[off + 8 : off + 12], "little")
        ev = int.from_bytes(raw[off + 12 : off + 16], "little", signed=True)
        c = int.from_bytes(raw[off + 16 : off + 20], "little", signed=True)
        total = n_st + n_sp + n_ot + n_op
        idx = np.frombuffer(view, dtype="<u2", count=total, offset=off + RECORD_HEADER)
        stm_lists.append(idx[: n_st + n_sp].astype(np.int32))
        oth_lists.append(idx[n_st + n_sp :].astype(np.int32))
        bucket[i] = b
        eval_internal[i] = ev
        cp[i] = c
        off += RECORD_HEADER + 2 * total

    if off != len(raw):
        raise ValueError(f"{path}: trailing bytes ({off} of {len(raw)} consumed)")

    stm_counts = np.fromiter((len(x) for x in stm_lists), dtype=np.int64, count=count)
    oth_counts = np.fromiter((len(x) for x in oth_lists), dtype=np.int64, count=count)
    stm_offsets[1:] = np.cumsum(stm_counts)
    oth_offsets[1:] = np.cumsum(oth_counts)

    stm_indices = np.concatenate(stm_lists).astype(np.int32, copy=False) if count else np.zeros(0, np.int32)
    oth_indices = np.concatenate(oth_lists).astype(np.int32, copy=False) if count else np.zeros(0, np.int32)

    return Dump(
        stm_offsets=stm_offsets,
        stm_indices=stm_indices,
        oth_offsets=oth_offsets,
        oth_indices=oth_indices,
        bucket=bucket,
        eval_internal=eval_internal,
        cp=cp,
        threat_dim=int(threat_dim),
        psq_dim=int(psq_dim),
    )


def shard_paths(directory: str | Path) -> list[Path]:
    return sorted(Path(directory).glob("shard-*.npz"))


def write_shards(dump: Dump, out_dir: str | Path, per_shard: int = 200_000) -> list[Path]:
    """Split a dump into `.npz` shards so an epoch can stream from disk."""

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    n = len(dump)

    for start in range(0, n, per_shard):
        stop = min(start + per_shard, n)
        a, b = dump.stm_offsets[start], dump.stm_offsets[stop]
        c, d = dump.oth_offsets[start], dump.oth_offsets[stop]

        path = out / f"shard-{start // per_shard:05d}.npz"
        arrays = {
            "stm_offsets": dump.stm_offsets[start : stop + 1] - a,
            "stm_indices": dump.stm_indices[a:b],
            "oth_offsets": dump.oth_offsets[start : stop + 1] - c,
            "oth_indices": dump.oth_indices[c:d],
            "bucket": dump.bucket[start:stop],
            "eval_internal": dump.eval_internal[start:stop],
            "cp": dump.cp[start:stop],
            "threat_dim": np.int64(dump.threat_dim),
            "psq_dim": np.int64(dump.psq_dim),
        }
        if dump.target_internal is not None:
            arrays["target_internal"] = dump.target_internal[start:stop]
        np.savez(path, **arrays)
        paths.append(path)

    (out / "meta.json").write_text(
        json.dumps(
            {
                "positions": int(n),
                "shards": len(paths),
                "threat_dim": dump.threat_dim,
                "psq_dim": dump.psq_dim,
                "features": dump.threat_dim + dump.psq_dim,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return paths
