"""Checks `selfplay.bucket_of` against the engine, without needing the engine.

`training/tools/gen-bucket-fens.py` asked the engine for the bucket of one crafted
position per bucket and wrote them in order 0..31.  If `bucket_of` reproduces that
order, the Python transcription of `K6R2NC2::make_layer_stack_bucket` agrees with
the engine, which is what lets a corpus be checked for bucket coverage before it
is dumped.

    python training/python/test_bucket.py [training/data/bucket-fens.txt]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from selfplay import bucket_of  # noqa: E402

DEFAULT = Path(__file__).resolve().parent.parent / "data" / "bucket-fens.txt"


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT
    if not path.exists():
        print(f"skip: {path} does not exist")
        return 0

    fens = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    got = [bucket_of(f) for f in fens]
    want = list(range(len(fens)))

    if got != want:
        print(f"FAIL: computed {got}")
        print(f"      expected {want}")
        return 1

    print(f"PASS  {len(fens)} crafted positions map to buckets 0..{len(fens) - 1} in order")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
