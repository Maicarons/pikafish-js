"""Generates a FEN corpus by playing the engine against itself over UCI.

There is no public xiangqi training corpus, so the training positions are made
here.  Everything goes through the engine binary that `training/README.md`
describes how to build, which means this works on Kaggle without Node, without a
dataset and without a Python port of the rules:

    position fen <start> moves m1 m2 ...   set the position from a move list
    go perft 1                             list every legal move (random play)
    go nodes N / go depth D                search, then read `bestmove`
    d                                      print the position as a FEN

Two policies are offered because they produce very different data:

* `random` plays uniformly.  It is cheap and reaches sparse material quickly,
  because random play gives material away, but the positions are not ones a
  player would reach.
* `search` (the default) lets the engine play with a small budget.  The games
  look like real play at low strength, and the teacher's evaluation of them is
  what a student should imitate.

A fraction of games starts from a thinned position, because play between full
armies rarely reaches the sparse material that exercises the upper layer-stack
buckets.

**The engine exits on an illegal FEN** (`CRITICAL ERROR ... King can be
captured`), and thinning can produce one.  Two defences: pieces on the generals'
file are never removed, so the kings cannot be exposed to each other, and a
position the engine rejects restarts it and costs only that game.  Any partial
game is kept.

    python training/python/selfplay.py --engine training/engine/pikafish.exe \\
        --out training/data/fens.txt --games 500 --max-minutes 10
"""

from __future__ import annotations

import argparse
import collections
import random
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

MOVE_RE = re.compile(r"^([a-i][0-9][a-i][0-9]): \d+$")
FEN_RE = re.compile(r"^Fen: (.+?)\s*$")
BOARD_RE = re.compile(r"^([rnbakcpRNBAKCP1-9/]+) ([wb]) ")

START_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"

# The generals start on file 4 and may not face each other, so that file keeps
# every piece it has; removing one is the usual way to make an illegal FEN.
GENERALS_FILE = 4

ROOK, KNIGHT, CANNON, PAWN = "rR", "nN", "cC", "pP"


class EngineDied(RuntimeError):
    """The engine exited, which it does when a FEN it is given is illegal."""


def _targets(text: str) -> tuple[int, int]:
    """`"2"` or `"1,0"` -> the counts for the side to move and its opponent."""
    if "," in text:
        us, opp = text.split(",", 1)
        return int(us), int(opp)
    n = int(text)
    return n, n


class Engine:
    """A UCI subprocess, read line by line on a background thread."""

    def __init__(self, path: str | Path, timeout: float = 120.0, cwd: str | Path | None = None):
        self.path = str(path)
        self.timeout = timeout
        self.lines: collections.deque[str] = collections.deque()
        self.cond = threading.Condition()
        self.proc = subprocess.Popen(
            [self.path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            # The engine reads its net from the working directory, so a second
            # engine with a different net needs its own directory.
            cwd=str(cwd) if cwd is not None else None,
        )
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()
        self.send("uci")
        if self.read_until("uciok") is None:
            raise RuntimeError(f"{self.path} did not answer `uci`")
        self.send("isready")
        self.read_until("readyok")

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            with self.cond:
                self.lines.append(line.rstrip("\r\n"))
                self.cond.notify_all()

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None

    def send(self, command: str) -> None:
        if not self.alive:
            raise EngineDied(f"{self.path} exited")
        try:
            assert self.proc.stdin is not None
            self.proc.stdin.write(command + "\n")
            self.proc.stdin.flush()
        except OSError as exc:  # the pipe closed under us
            raise EngineDied(str(exc)) from exc

    def read_until(self, token: str) -> list[str] | None:
        """Reads until a line starts with `token`; None if the engine died."""
        deadline = time.time() + self.timeout
        out: list[str] = []
        while True:
            with self.cond:
                while not self.lines:
                    if not self.alive:
                        return None
                    left = deadline - time.time()
                    if left <= 0:
                        return None
                    self.cond.wait(min(left, 0.5))
                line = self.lines.popleft()
            out.append(line)
            if line.startswith(token):
                return out

    def close(self) -> None:
        try:
            if self.alive:
                self.send("quit")
                self.proc.wait(timeout=5)
        except Exception:
            pass
        if self.alive:
            self.proc.kill()
            self.proc.wait(timeout=5)


def thin(
    fen: str,
    rng: random.Random,
    ratio: float,
    rooks: tuple[int | None, int | None] | None = None,
    nc: tuple[int | None, int | None] | None = None,
) -> str:
    """Removes pieces from a FEN: at random, then down to a material target.

    The kings stay (the position must be playable) and so does every piece on
    the generals' file, which is what keeps the kings from facing each other.
    Whether the result is *legal* is not decided here: the engine is the
    authority on that, and a rejected position costs one game.

    `rooks` and `nc` (knights plus cannons) are `(side to move, opponent)` counts to
    cut down to, which is how a corpus is aimed at the layer-stack buckets that
    random play never reaches: a bucket is a function of the two sides' rook and
    knight-plus-cannon counts, and the rare ones need, say, no rooks at all, or a
    full set of rooks with one knight on one side only.
    """
    m = BOARD_RE.match(fen)
    if not m:
        return fen
    board, side = m.group(1), m.group(2)

    grid = [[""] * 9 for _ in range(10)]
    for rank, row in enumerate(board.split("/")):
        file = 0
        for ch in row:
            if ch.isdigit():
                file += int(ch)
            else:
                grid[rank][file] = ch
                file += 1

    victims: list[tuple[int, int]] = []

    def eligible(r: int, f: int) -> bool:
        return grid[r][f] not in ("", "K", "k") and f != GENERALS_FILE

    if ratio > 0:
        for r in range(10):
            for f in range(9):
                if eligible(r, f) and rng.random() < ratio:
                    victims.append((r, f))

    pinned = set(victims)

    def pair(value: int | tuple | None) -> tuple[int | None, int | None]:
        if value is None:
            return (None, None)
        if isinstance(value, int):
            return (value, value)
        return (value[0], value[1])

    us_rooks, opp_rooks = pair(rooks)
    us_nc, opp_nc = pair(nc)
    red = side == "w"  # uppercase pieces are red's
    for chars, target in (
        ("R" if red else "r", us_rooks),
        ("r" if red else "R", opp_rooks),
        ("NC" if red else "nc", us_nc),
        ("nc" if red else "NC", opp_nc),
    ):
        if target is None:
            continue
        pool = [
            (r, f)
            for r in range(10)
            for f in range(9)
            if grid[r][f] != "" and grid[r][f] in chars and (r, f) not in pinned
        ]
        while len(pool) > target:
            victims.append(pool.pop(rng.randrange(len(pool))))

    for r, f in victims:
        grid[r][f] = ""

    ranks = []
    for row in grid:
        out, empty = "", 0
        for cell in row:
            if cell == "":
                empty += 1
            else:
                if empty:
                    out += str(empty)
                    empty = 0
                out += cell
        if empty:
            out += str(empty)
        ranks.append(out)
    return "/".join(ranks) + f" {side} - - 0 1"


def bucket_of(fen: str) -> int:
    """The layer-stack bucket the engine will use for this position.

    Transcribed from `K6R2NC2::make_layer_stack_bucket`.  The engine indexes a
    `[3][3][5][5]` table with the side to move's and the opponent's rook counts
    and knight-plus-cannon counts; xiangqi material can never exceed those
    bounds (two rooks, and two knights plus two cannons per side), so no
    clamping is needed.  `training/tools/gen-bucket-fens.py` verified the
    mapping against the engine, and `--require-buckets` checks it again on every
    corpus this script writes.
    """
    board, side = fen.split()[0], fen.split()[1]

    def count(chars: str) -> int:
        return sum(board.count(c) for c in chars)

    if side == "w":  # red to move; red pieces are the uppercase ones
        us_rook, opp_rook = count("R"), count("r")
        us_nc, opp_nc = count("NC"), count("nc")
    else:
        us_rook, opp_rook = count("r"), count("R")
        us_nc, opp_nc = count("nc"), count("NC")

    if us_rook == opp_rook:
        return us_rook * 8 + int(us_nc == opp_nc) * 4 + min((us_nc + opp_nc) // 2, 3)
    if us_rook == 2 and opp_rook == 1:
        return 24 + int(us_nc + opp_nc >= 4)
    if us_rook == 1 and opp_rook == 2:
        return 26 + int(us_nc + opp_nc >= 4)
    if us_rook > 0 and opp_rook == 0:
        return 28 + int(us_nc + opp_nc >= 4)
    return 30 + int(us_nc + opp_nc >= 4)


def material_of(fen: str) -> tuple[int, int, int]:
    """`(rooks, knights+cannons, pawns)` for the side to move's opponent view.

    Only used for reporting, so it counts both sides together.
    """
    board = fen.split()[0]
    return (
        sum(board.count(c) for c in ROOK),
        sum(board.count(c) for c in KNIGHT + CANNON),
        sum(board.count(c) for c in PAWN),
    )


def play_game(
    engine: Engine, rng: random.Random, args: argparse.Namespace, start: str
) -> tuple[list[str], bool]:
    """Plays one game; returns the sampled FENs and whether the engine died."""
    moves: list[str] = []
    fens: list[str] = []

    try:
        for ply in range(args.max_plies):
            if moves:
                engine.send(f"position fen {start} moves {' '.join(moves)}")
            else:
                engine.send(f"position fen {start}")

            if ply % args.sample_every == 0:
                engine.send("d")
                out = engine.read_until("Fen:")
                if out is None:
                    return fens, True
                for line in out:
                    m = FEN_RE.match(line)
                    if m:
                        fens.append(m.group(1))
                        break

            if args.policy == "random":
                engine.send("go perft 1")
                out = engine.read_until("Nodes searched")
                if out is None:
                    return fens, True
                legal = [m.group(1) for line in out if (m := MOVE_RE.match(line))]
                if not legal:
                    return fens, False
                moves.append(rng.choice(legal))
            else:
                engine.send(f"go nodes {args.nodes}" if args.nodes else f"go depth {args.depth}")
                out = engine.read_until("bestmove")
                if out is None:
                    return fens, True
                best = next((ln.split()[1] for ln in out if ln.startswith("bestmove")), None)
                if not best or best == "(none)":
                    return fens, False
                moves.append(best)
    except EngineDied:
        return fens, True

    return fens, False


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--engine", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--games", type=int, default=0, help="0 = run until the time budget")
    p.add_argument("--max-minutes", type=float, default=10.0, help="0 disables")
    p.add_argument("--max-plies", type=int, default=140)
    p.add_argument("--sample-every", type=int, default=1, help="record every Nth ply")
    p.add_argument("--policy", choices=("search", "random"), default="search")
    p.add_argument("--nodes", type=int, default=2000, help="per move; 0 uses --depth")
    p.add_argument("--depth", type=int, default=2)
    p.add_argument("--thin-prob", type=float, default=0.35, help="share of games from sparse material")
    p.add_argument("--thin-ratio", type=float, default=0.5, help="share of eligible pieces removed")
    p.add_argument(
        "--target-rooks",
        type=_targets,
        default=None,
        help="rooks to cut down to: N for both sides, or 'us,opp' (needs --thin-prob > 0)",
    )
    p.add_argument(
        "--target-nc",
        type=_targets,
        default=None,
        help="knights plus cannons to cut down to: N for both sides, or 'us,opp'",
    )
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--quiet-every", type=int, default=25)
    p.add_argument(
        "--require-buckets",
        action="store_true",
        help="fail unless the corpus contains all 32 layer-stack buckets",
    )
    args = p.parse_args(argv[1:])

    rng = random.Random(args.seed)
    engine = Engine(args.engine)
    started = time.time()
    seen: set[str] = set()
    games = attempts = rejects = 0

    try:
        while True:
            if args.games and games >= args.games:
                break
            if args.max_minutes and (time.time() - started) / 60 >= args.max_minutes:
                break

            start = START_FEN
            if rng.random() < args.thin_prob:
                start = thin(START_FEN, rng, args.thin_ratio, args.target_rooks, args.target_nc)

            attempts += 1
            fens, died = play_game(engine, rng, args, start)
            seen.update(fens)
            if died:
                rejects += 1
                engine.close()
                engine = Engine(args.engine)
                if rejects > 200 and not seen:
                    print("every game died; is the engine usable?", file=sys.stderr)
                    break
            else:
                games += 1

            if args.quiet_every and attempts % args.quiet_every == 0:
                per = (time.time() - started) / attempts
                print(
                    f"attempts {attempts:6d}  games {games:6d}  positions {len(seen):8d}  "
                    f"{per:5.2f} s/game",
                    flush=True,
                )
    finally:
        engine.close()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fens = sorted(seen)
    out.write_text("".join(f + "\n" for f in fens), encoding="utf-8")

    elapsed = time.time() - started
    print(
        f"wrote {out}: {len(fens)} positions from {games} games "
        f"({rejects} engine restarts) in {elapsed:.0f}s"
    )

    # Every layer stack has its own full connection, so a corpus that never
    # reaches a bucket leaves that stack untrained.  `bucket_of` is a verified
    # transcription of the engine's own choice (see `test_bucket.py`).
    counts = collections.Counter(bucket_of(f) for f in fens)
    covered = sorted(counts)
    print(f"layer-stack buckets: {len(covered)}/32 covered")
    print("  " + "  ".join(f"{i}:{counts.get(i, 0)}" for i in range(32)))
    if args.require_buckets and len(covered) < 32:
        print(
            f"missing buckets {[i for i in range(32) if i not in counts]}; "
            "aim a run at them with --target-rooks/--target-nc",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
