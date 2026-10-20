"""Builds a student net of a reduced width and writes it in the engine's layout.

This is the smoke test of the whole export path: take the teacher's weights,
project the feature transformer down to `half`, quantise, write a `.nnue` with
the architecture hashes of an engine built at that width, and hand it to that
engine.  `training/engine/build-512` exists exactly for this.

The projection keeps the teacher's pairwise structure (see `export.projection`), so
the student's first `half/2` transformed features per perspective are the teacher's
own and the accumulator's distribution is preserved.  The other half of the
features and everything downstream of them still have to be trained, so the result
is a *valid* net and a weak one.  Its purpose is to prove the plumbing; strength
comes from `train.py`.

    python training/python/make_student.py assets/pikafish.nnue training/out/student.nnue [half]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export  # noqa: E402
import nnue_io  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2

    teacher_path, out_path = argv[1], argv[2]
    half = int(argv[3]) if len(argv) > 3 else 512

    teacher = nnue_io.read_net(teacher_path)
    if half not in nnue_io.ARCH_HASHES:
        print(f"no architecture hashes for L1={half}; see nnue_io.ARCH_HASHES", file=sys.stderr)
        return 1

    model = export.net_to_model(teacher, half=half)
    print(f"teacher    L1={teacher.l1} -> student L1={half}")
    print(f"model      {model.describe()}")

    ft_hash, arch_hash = nnue_io.ARCH_HASHES[half]
    net = export.model_to_net(
        model,
        description=f"pikafish-js L1={half} smoke net projected from the teacher",
        ft_hash=ft_hash,
        arch_hash=arch_hash,
    )
    # The engine's loader streams the file through zstd (`read_compressed_nnue`)
    # and finds nothing in a plain file, so what it consumes must be a frame.
    raw_size = nnue_io.write_net(net, out_path, compress=False)
    size = nnue_io.write_net(net, out_path, compress=True)
    print(f"wrote      {out_path} ({size} bytes zstd, {raw_size} plain)")
    print(f"hashes     ft {ft_hash:#010x} arch {arch_hash:#010x} header {ft_hash ^ arch_hash:#010x}")

    # Re-read through the same parser the parity checker will use.
    again = nnue_io.read_net(out_path)
    ok = nnue_io.nets_equal(net, again)
    print(f"reread     L1={again.l1} equal {ok}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
