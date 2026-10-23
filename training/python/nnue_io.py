"""Read and write Pikafish `.nnue` files, and evaluate the way the engine does.

Everything here was derived from the pinned upstream commit and then checked
against the engine: `predicted_size == 64701916` for the official net, and
`evaluate()` reproduces `Network::evaluate` exactly (see `parity.py`).

File layout
-----------
    u32 version (0x6A448AFA)
    u32 hash    (unused by the loader beyond a sanity check)
    u32 description length, then that many bytes
    u32 feature-transformer hash
        i16 biases[L1]
        i8  threatWeights[45547 * L1]     # row-major [feature][dimension]
        i8  psqWeights[16536 * L1]        # row-major [feature][dimension]
    then 32 layer stacks, each:
        u32 hash
        i32 fc_0 biases[32]   + i8 fc_0 weights[32 * L1]
        i32 fc_1 biases[32]   + i8 fc_1 weights[32 * 64]
        i32 fc_2 biases[1]    + i8 fc_2 weights[1 * 128]

Notes that cost time to establish:

* The full-connection biases are **i32**, not i16 (the layers define
  `BiasType = OutputType`); the feature transformer's bias *is* i16.
* Weight bytes are written in logical [output][input] order.  The engine
  permutes them in memory for SIMD (`permute_weights`, `get_weight_index`),
  and unpermutes when writing, so the file is layout-invariant.
* Inputs are multiples of 32, so `PaddedInputDimensions` never pads here and
  the layout does not depend on the SIMD width the engine was built with.
* Official nets ship as a single zstd frame around the parameter stream;
  `read_net` decompresses transparently.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


def decompress_if_needed(raw: bytes, name: str = "net") -> bytes:
    """Undo the zstd frame the released nets are wrapped in, if there is one."""
    if not raw.startswith(ZSTD_MAGIC):
        return raw

    try:
        import zstandard  # type: ignore[import-not-found]

        return zstandard.ZstdDecompressor().decompress(raw, max_output_size=256 << 20)
    except ImportError:
        pass

    try:
        from compression import zstd  # Python 3.14+, PEP 784

        return zstd.decompress(raw)
    except ImportError as exc:  # pragma: no cover - depends on the interpreter
        raise RuntimeError(
            f"{name} is zstd-compressed but neither 'zstandard' nor 'compression.zstd' "
            "is importable; run 'pip install zstandard'"
        ) from exc

VERSION = 0x6A448AFA
L1 = 1024

# Architecture hashes are compile-time constants of the engine that loads the
# net, and they move with `L1`.  Each entry was printed by `pikafish-dump
# inspect` from a build of that width (`training/engine/build-512`,
# `training/engine/build-width.sh`), and the 1024 values were then confirmed
# verbatim inside the official file.  The header hash is their XOR
# (`Network::hash`).
ARCH_HASHES: dict[int, tuple[int, int]] = {
    1024: (0x6E62D08C, 0x63337116),
    512: (0x6E62DC8C, 0x63337196),
    256: (0x6E62DA8C, 0x63337156),
    192: (0x6E62D90C, 0x63337006),
    128: (0x6E62D98C, 0x63337136),
    64: (0x6E62D80C, 0x633371E6),
}
FT_HASH, ARCH_HASH = ARCH_HASHES[L1]
NETWORK_HASH = FT_HASH ^ ARCH_HASH
THREAT_DIM = 45_547
PSQ_DIM = 16_536
FEATURES = THREAT_DIM + PSQ_DIM
LAYER_STACKS = 32
L2 = 32
L3 = 32
FC1_IN = L2 * 2
FC2_IN = L2 * 2 + L3 * 2
WEIGHT_SCALE_BITS = 6
OUTPUT_SCALE = 16
I16_MIN, I16_MAX = -32768, 32767
I8_MIN, I8_MAX = -128, 127
FT_MIN, FT_MAX = 0, 255


@dataclass
class Net:
    description: str
    ft_bias: np.ndarray  # i16 [L1]
    threat: np.ndarray  # i8  [THREAT_DIM, L1]
    psq: np.ndarray  # i8  [PSQ_DIM, L1]
    stacks: list[dict] = field(default_factory=list)  # per stack: fc0_b, fc0_w, ...
    ft_hash: int = FT_HASH
    arch_hash: int = ARCH_HASH
    header_hash: int = NETWORK_HASH

    @property
    def features(self) -> int:
        return self.threat.shape[0] + self.psq.shape[0]

    @property
    def l1(self) -> int:
        return self.ft_bias.shape[0]

    def weights(self) -> np.ndarray:
        """All FT rows as one [FEATURES, L1] int8 matrix (threat first)."""
        return np.concatenate([self.threat, self.psq], axis=0)


def _read_into(blob: memoryview, off: int, dtype: str, shape) -> tuple[np.ndarray, int]:
    dt = np.dtype(dtype)
    count = int(np.prod(shape)) if shape else 1
    nbytes = count * dt.itemsize
    arr = np.frombuffer(blob, dtype=dt, count=count, offset=off)
    return arr.reshape(shape), off + nbytes


def _solve_l1(raw: bytes, path: str | Path) -> int:
    """Recovers `L1` from the file size; every other dimension is constant.

    A wrong width would otherwise be read as a misaligned net and only surface
    as nonsense weights, so the width is checked against the byte count and a
    non-integer answer is an error rather than a guess.
    """
    desc_len = int.from_bytes(raw[8:12], "little")

    # Everything that does not scale with L1:
    #   i32 version, i32 hash, i32 description length, description,
    #   i32 FT hash,
    # and per layer stack:
    #   u32 hash, i32 fc_0 bias[L2], i32 fc_1 bias[L2], i32 fc_2 bias[1],
    #   i8 fc_2 weights[FC2_IN], i8 fc_1 weights[L2 * FC1_IN]
    per_stack = 4 + 4 * L2 + 4 * L2 + 4 + FC2_IN + L2 * FC1_IN
    fixed = 12 + desc_len + 4 + LAYER_STACKS * per_stack

    # Everything linear in L1:
    #   i16 ft bias[L1], i8 threat[THREAT_DIM * L1], i8 psq[PSQ_DIM * L1],
    #   i8 fc_0 weights[L2 * L1] per stack
    per_l1 = 2 + THREAT_DIM + PSQ_DIM + LAYER_STACKS * L2

    span = len(raw) - fixed
    if span % per_l1:
        raise ValueError(f"{path}: {len(raw)} bytes is not a Pikafish net")
    return span // per_l1


def hashes_for(l1: int) -> tuple[int, int]:
    """`(feature-transformer hash, layer-stack hash)` for a given width."""
    if l1 not in ARCH_HASHES:
        raise KeyError(
            f"no architecture hashes for L1={l1}; build the engine at that width "
            "and run 'pikafish-dump inspect' (see training/README.md)"
        )
    return ARCH_HASHES[l1]


def read_net(path: str | Path, l1: int | None = None) -> Net:
    raw = decompress_if_needed(Path(path).read_bytes(), str(path))
    blob = memoryview(raw)

    version = int.from_bytes(raw[0:4], "little")
    if version != VERSION:
        raise ValueError(f"{path}: unknown net version {version:#x}")

    l1 = l1 or _solve_l1(raw, path)
    ft_hash_expected, arch_hash_expected = hashes_for(l1) if l1 in ARCH_HASHES else (None, None)

    header_hash = int.from_bytes(raw[4:8], "little")
    desc_len = int.from_bytes(raw[8:12], "little")
    description = raw[12 : 12 + desc_len].decode("utf-8", errors="replace")
    off = 12 + desc_len

    ft_hash = int.from_bytes(raw[off : off + 4], "little")
    if ft_hash_expected is not None and ft_hash != ft_hash_expected:
        print(
            f"note: {path}: feature transformer hash {ft_hash:#x}, "
            f"expected {ft_hash_expected:#x} for L1={l1}"
        )
    off += 4

    ft_bias, off = _read_into(blob, off, "<i2", (l1,))
    threat, off = _read_into(blob, off, "i1", (THREAT_DIM, l1))
    psq, off = _read_into(blob, off, "i1", (PSQ_DIM, l1))

    stacks = []
    arch_hash = arch_hash_expected or 0
    for _ in range(LAYER_STACKS):
        arch_hash = int.from_bytes(raw[off : off + 4], "little")
        if arch_hash_expected is not None and arch_hash != arch_hash_expected:
            print(
                f"note: {path}: layer stack hash {arch_hash:#x}, "
                f"expected {arch_hash_expected:#x} for L1={l1}"
            )
        off += 4

        fc0_b, off = _read_into(blob, off, "<i4", (L2,))
        fc0_w, off = _read_into(blob, off, "i1", (L2, l1))
        fc1_b, off = _read_into(blob, off, "<i4", (L2,))
        fc1_w, off = _read_into(blob, off, "i1", (L2, FC1_IN))
        fc2_b, off = _read_into(blob, off, "<i4", (1,))
        fc2_w, off = _read_into(blob, off, "i1", (1, FC2_IN))

        stacks.append(
            {"fc0_b": fc0_b, "fc0_w": fc0_w, "fc1_b": fc1_b, "fc1_w": fc1_w, "fc2_b": fc2_b, "fc2_w": fc2_w}
        )

    if off != len(raw):
        raise ValueError(f"{path}: {len(raw) - off} trailing bytes")

    return Net(
        description=description,
        ft_bias=ft_bias,
        threat=threat,
        psq=psq,
        stacks=stacks,
        ft_hash=ft_hash,
        arch_hash=arch_hash,
        header_hash=header_hash,
    )


def write_net(
    net: Net,
    path: str | Path,
    *,
    description: str | None = None,
    header_hash: int | None = None,
    ft_hash: int | None = None,
    arch_hash: int | None = None,
    compress: bool = False,
) -> int:
    """Serialise `net`, returning the number of bytes written.

    The hashes default to the ones the net was read with.  A student with a
    different `L1` needs its own values (they are compile-time constants of the
    engine that will load it); `pikafish-dump inspect` prints them.

    `compress=True` wraps the parameters in a zstd frame, which is what the
    engine's loader reads: `read_compressed_nnue` streams the file through zstd
    and a plain file yields an empty stream.
    """
    desc = (description if description is not None else net.description).encode("utf-8")

    parts: list[bytes] = [
        VERSION.to_bytes(4, "little"),
        (header_hash if header_hash is not None else net.header_hash).to_bytes(4, "little"),
        len(desc).to_bytes(4, "little"),
        desc,
        (ft_hash if ft_hash is not None else net.ft_hash).to_bytes(4, "little"),
        np.ascontiguousarray(net.ft_bias, dtype="<i2").tobytes(),
        np.ascontiguousarray(net.threat, dtype="i1").tobytes(),
        np.ascontiguousarray(net.psq, dtype="i1").tobytes(),
    ]

    for stack in net.stacks:
        parts.append((arch_hash if arch_hash is not None else net.arch_hash).to_bytes(4, "little"))
        parts.append(np.ascontiguousarray(stack["fc0_b"], dtype="<i4").tobytes())
        parts.append(np.ascontiguousarray(stack["fc0_w"], dtype="i1").tobytes())
        parts.append(np.ascontiguousarray(stack["fc1_b"], dtype="<i4").tobytes())
        parts.append(np.ascontiguousarray(stack["fc1_w"], dtype="i1").tobytes())
        parts.append(np.ascontiguousarray(stack["fc2_b"], dtype="<i4").tobytes())
        parts.append(np.ascontiguousarray(stack["fc2_w"], dtype="i1").tobytes())

    blob = b"".join(parts)

    if compress:
        try:
            import zstandard  # type: ignore[import-not-found]

            blob = zstandard.ZstdCompressor().compress(blob)
        except ImportError:  # pragma: no cover - depends on the interpreter
            from compression import zstd  # Python 3.14+, PEP 784

            blob = zstd.compress(blob)

    Path(path).write_bytes(blob)
    return len(blob)


def nets_equal(a: Net, b: Net) -> bool:
    if not (
        a.description == b.description
        and a.ft_hash == b.ft_hash
        and a.arch_hash == b.arch_hash
        and a.header_hash == b.header_hash
    ):
        return False
    if a.l1 != b.l1 or not np.array_equal(a.ft_bias, b.ft_bias):
        return False
    if not (np.array_equal(a.threat, b.threat) and np.array_equal(a.psq, b.psq)):
        return False
    if len(a.stacks) != len(b.stacks):
        return False
    return all(
        all(np.array_equal(sa[k], sb[k]) for k in sa) for sa, sb in zip(a.stacks, b.stacks)
    )


def c_div(a, b: int):
    """C++ integer division: truncates toward zero, not toward -inf."""
    q = np.abs(a) // b
    return np.where(a < 0, -q, q)


class Evaluator:
    """Integer evaluator for one net, with the weight matrices prepared once.

    Building the int32 view of the weights is the expensive part (the feature
    transformer alone is 62083 x L1 entries), so it is done here rather than per
    position.
    """

    def __init__(self, net: Net):
        self.net = net
        self.rows = net.weights().astype(np.int32)  # [FEATURES, L1]
        self.bias = net.ft_bias.astype(np.int32)
        self.stacks = [
            {
                "fc0_b": s["fc0_b"].astype(np.int32),
                "fc0_w": s["fc0_w"].astype(np.int32),
                "fc1_b": s["fc1_b"].astype(np.int32),
                "fc1_w": s["fc1_w"].astype(np.int32),
                "fc2_b": s["fc2_b"].astype(np.int32),
                "fc2_w": s["fc2_w"].astype(np.int32),
            }
            for s in net.stacks
        ]

    def evaluate(
        self, stm_indices: np.ndarray, oth_indices: np.ndarray, bucket: int
    ) -> int:
        """Faithful reimplementation of `Network::evaluate` for one position.

        Integer arithmetic throughout, including the saturating packs and the
        truncating divisions, so it can be compared against the engine unit for
        unit rather than approximately.
        """
        rows = self.rows
        half = self.net.l1 // 2

        def accumulate(indices: np.ndarray) -> np.ndarray:
            acc = self.bias.copy()
            if len(indices):
                acc += rows[indices].sum(axis=0, dtype=np.int32)
            return acc

        def transform(acc: np.ndarray) -> np.ndarray:
            lo = np.clip(acc[:half], FT_MIN, FT_MAX)
            hi = np.clip(acc[half:], FT_MIN, FT_MAX)
            return (lo * hi) >> 9  # the engine's net right shift

        x = np.concatenate([transform(accumulate(stm_indices)), transform(accumulate(oth_indices))])

        stack = self.stacks[bucket]

        o0 = stack["fc0_b"] + stack["fc0_w"] @ x
        # SqrClippedReLU: mulhi after a 7-bit left shift of the clipped value.
        t0 = np.clip(o0, I16_MIN, I16_MAX)
        sqr0 = ((t0 * t0) >> 16) >> (2 * (WEIGHT_SCALE_BITS + 1) + 7 - 16)
        sqr0 = np.clip(sqr0, I8_MIN, I8_MAX)
        clip0 = np.clip(t0 >> (WEIGHT_SCALE_BITS + 1), 0, I8_MAX)
        # concat_buffer: [fc_0 squared, fc_0 clipped, fc_1 squared, fc_1 clipped].
        # fc_1 consumes the first 64, fc_2 all 128.
        c1 = np.concatenate([sqr0, clip0])

        o1 = stack["fc1_b"] + stack["fc1_w"] @ c1
        t1 = np.clip(o1, I16_MIN, I16_MAX)
        sqr1 = np.clip(((t1 * t1) >> 16) >> (2 * WEIGHT_SCALE_BITS + 7 - 16), I8_MIN, I8_MAX)
        clip1 = np.clip(t1 >> WEIGHT_SCALE_BITS, 0, I8_MAX)
        c2 = np.concatenate([sqr0, clip0, sqr1, clip1])

        o2 = int(stack["fc2_b"][0]) + int(stack["fc2_w"][0] @ c2)
        fwd = o2 + int(o0[L2 - 2]) - int(o0[L2 - 1])

        # 1.0 is encoded as HiddenOneVal << WeightScaleBits * 2; the engine wants
        # 1.0 == 600 * OutputScale.
        scaled = c_div(fwd * 600 * OUTPUT_SCALE, 128 * (1 << WEIGHT_SCALE_BITS) * 2)
        return int(c_div(scaled, OUTPUT_SCALE))


def evaluate(net: Net, stm_indices: np.ndarray, oth_indices: np.ndarray, bucket: int) -> int:
    """One-shot convenience wrapper; use `Evaluator` in loops."""
    return Evaluator(net).evaluate(stm_indices, oth_indices, bucket)


def _cli(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        print("usage: nnue_io.py info <net.nnue> | roundtrip <net.nnue> [out.nnue]")
        return 2

    cmd, src = argv[1], argv[2]
    net = read_net(src)

    if cmd == "info":
        print(f"description  {net.description.splitlines()[0]}")
        print(f"L1           {net.l1}")
        print(f"features     {net.features} (threat {net.threat.shape[0]}, psq {net.psq.shape[0]})")
        print(f"stacks       {len(net.stacks)}")
        print(f"hash         {net.header_hash:#010x}  (ft {net.ft_hash:#010x} ^ arch {net.arch_hash:#010x})")
        print(f"ft bias      {net.ft_bias.min()}..{net.ft_bias.max()}")
        print(f"threat w     {net.threat.min()}..{net.threat.max()}  nonzero {(net.threat != 0).mean():.3f}")
        print(f"psq w        {net.psq.min()}..{net.psq.max()}  nonzero {(net.psq != 0).mean():.3f}")
        return 0

    if cmd == "roundtrip":
        out = argv[3] if len(argv) > 3 else src + ".roundtrip"
        size = write_net(net, out)
        again = read_net(out)
        ok = nets_equal(net, again)
        print(f"wrote {out} ({size} bytes), reread equal: {ok}")
        return 0 if ok else 1

    print(f"unknown command {cmd!r}")
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(_cli(sys.argv))
