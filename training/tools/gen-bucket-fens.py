"""Builds one legal FEN per layer-stack bucket (0..31).

The 32 full-connection stacks are picked from the mover's piece counts:

    us_rook == opp_rook        -> us_rook*8 + (nc_us == nc_opp)*4 + min((nc_us + nc_opp)//2, 3)
    us_rook == 2, opp_rook == 1 -> 24 + (nc_us + nc_opp >= 4)
    us_rook == 1, opp_rook == 2 -> 26 + (nc_us + nc_opp >= 4)
    us_rook > 0,  opp_rook == 0 -> 28 + (nc_us + nc_opp >= 4)
    us_rook == 0, opp_rook > 0  -> 30 + (nc_us + nc_opp >= 4)

Random games reach only the material-heavy buckets, so training data and the
parity check both need positions built to order.  Rooks, knights and cannons
all go on ranks 4 and 5 and never on files d/e, which keeps them off the kings'
files and ranks; the kings sit on e0 (red) and d9 (black) and so never face and
are never in check.

    python training/tools/gen-bucket-fens.py training/data/bucket-fens.txt
"""

from __future__ import annotations

import sys
from pathlib import Path


def bucket(us_rook: int, opp_rook: int, us_nc: int, opp_nc: int) -> int:
    if us_rook == opp_rook:
        return us_rook * 8 + (1 if us_nc == opp_nc else 0) * 4 + min((us_nc + opp_nc) // 2, 3)
    if us_rook == 2 and opp_rook == 1:
        return 24 + int(us_nc + opp_nc >= 4)
    if us_rook == 1 and opp_rook == 2:
        return 26 + int(us_nc + opp_nc >= 4)
    if us_rook > 0 and opp_rook == 0:
        return 28 + int(us_nc + opp_nc >= 4)
    return 30 + int(us_nc + opp_nc >= 4)


def combinations() -> dict[int, tuple[int, int, int, int]]:
    """One (us_rook, opp_rook, us_nc, opp_nc) per bucket, the lightest one."""
    found: dict[int, tuple[int, int, int, int]] = {}
    for us_rook in range(3):
        for opp_rook in range(3):
            for us_nc in range(5):
                for opp_nc in range(5):
                    b = bucket(us_rook, opp_rook, us_nc, opp_nc)
                    key = (us_rook, opp_rook, us_nc, opp_nc)
                    if b not in found or sum(key[2:]) < sum(found[b][2:]):
                        found[b] = key
    return found


# ranks 4 and 5, skipping files d (3) and e (4)
SLOTS = [(x, y) for y in (5, 4) for x in (0, 1, 2, 6, 7, 8)]


def fen(us_rook: int, opp_rook: int, us_nc: int, opp_nc: int) -> str:
    grid = [["" for _ in range(9)] for _ in range(10)]
    grid[0][4] = "K"  # red king, e0
    grid[9][3] = "k"  # black king, d9

    slots = list(SLOTS)
    red = [("R", us_rook), ("N", min(us_nc, 2)), ("C", max(us_nc - 2, 0))]
    black = [("r", opp_rook), ("n", min(opp_nc, 2)), ("c", max(opp_nc - 2, 0))]

    for letter, count in red + black:
        for _ in range(count):
            x, y = slots.pop(0)
            grid[y][x] = letter

    ranks = []
    for y in range(9, -1, -1):
        row, empty = "", 0
        for x in range(9):
            if grid[y][x]:
                if empty:
                    row += str(empty)
                    empty = 0
                row += grid[y][x]
            else:
                empty += 1
        if empty:
            row += str(empty)
        ranks.append(row)
    return "/".join(ranks) + " w - - 0 1"


def main(argv: list[str]) -> int:
    out = Path(argv[1] if len(argv) > 1 else "training/data/bucket-fens.txt")
    combos = combinations()

    missing = sorted(set(range(32)) - set(combos))
    if missing:
        print(f"no combination found for buckets {missing}", file=sys.stderr)
        return 1

    fens = [fen(*combos[b]) for b in range(32)]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(fens) + "\n")

    for b, c in sorted(combos.items()):
        print(f"  bucket {b:2d}  us_rook={c[0]} opp_rook={c[1]} us_nc={c[2]} opp_nc={c[3]}")
    print(f"wrote {len(fens)} positions -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
