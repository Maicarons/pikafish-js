"""A fixed-node match between two engines that carry different nets.

This is the number that decides whether the distilled net may replace the
teacher: eval error does not translate into strength by itself, but the moves
the search actually plays do.

    python training/python/match_engines.py \
        --teacher upstream/src --student training/engine/build-512/src \
        --fens training/out/fens-normal/normal.txt --games 200 --nodes 4000

Each game starts from a different position of the given FEN list, so the games
are not the same opening played twice, and the colours are alternated.  The
board is tracked in Python to adjudicate the draws: threefold repetition and
the sixty-move rule.  A position with no legal move is a loss, not a draw --
that is the xiangqi rule (困毙) and it is why the engine's `bestmove 0000` ends
the game against the side to move.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from selfplay import Engine  # noqa: E402

FILES = "abcdefghi"

# The engine numbers the ranks from red's side: red's back rank is 0, black's
# is 9, and red moves towards the higher numbers.  A FEN is written the other
# way round (black's back rank first), so a FEN row i is engine rank 9 - i.
# Columns are the files a..i, left to right, in both.
FILES = "abcdefghi"

RED = "RNBAKCP"
BLACK = "rn bakcp".replace(" ", "")


class ConventionError(RuntimeError):
    """The move did not fit the board, which means the coordinates are read wrong."""


def parse_fen(fen: str) -> tuple[list[list[str]], str, int]:
    parts = fen.split()
    layout, side, _half = parts[0], parts[1], parts[4] if len(parts) > 4 else "0"
    board: list[list[str]] = [["."] * 9 for _ in range(10)]
    for index, row in enumerate(layout.split("/")):
        cells: list[str] = []
        for char in row:
            if char.isdigit():
                cells.extend(["."] * int(char))
            else:
                cells.append(char)
        if len(cells) != 9:
            raise ConventionError(f"row {row!r} is not 9 files")
        board[9 - index] = cells
    return board, side, int(_half)


def board_key(board: list[list[str]], side: str) -> str:
    return side + "|" + "|".join("".join(row) for row in board)


def _delta(move: str) -> tuple[int, int]:
    return FILES.index(move[1]) - FILES.index(move[3]), int(move[2]) - int(move[0])


def apply_move(board: list[list[str]], move: str, side: str) -> bool:
    """Applies `move` to `board`; returns True when it captured a piece.

    The check is deliberately strict: a move that does not fit the piece on the
    source square raises, because that means the coordinates are being read
    wrongly and every draw count afterwards would be wrong.
    """
    if len(move) != 4 or move[0] not in FILES or move[2] not in FILES:
        raise ConventionError(f"malformed move {move!r}")
    col, row = FILES.index(move[0]), int(move[1])
    to_col, to_row = FILES.index(move[2]), int(move[3])
    piece = board[row][col]
    if piece == ".":
        raise ConventionError(f"no piece on {move[0]}{move[1]}")
    if piece.isupper() != (side == "w"):
        raise ConventionError(f"piece {piece} does not belong to {side}")
    dcol, drow = to_col - col, to_row - row
    kind = piece.upper()
    if kind == "N":
        if sorted((abs(dcol), abs(drow))) != [1, 2]:
            raise ConventionError(f"horse cannot move {dcol},{drow}")
    elif kind == "B":
        if abs(dcol) != 2 or abs(drow) != 2:
            raise ConventionError(f"elephant cannot move {dcol},{drow}")
    elif kind == "A":
        if abs(dcol) != 1 or abs(drow) != 1:
            raise ConventionError(f"advisor cannot move {dcol},{drow}")
    elif kind == "K":
        if abs(dcol) + abs(drow) != 1:
            raise ConventionError(f"king cannot move {dcol},{drow}")
    elif kind == "P":
        # Red (upper case) walks towards the higher ranks, black towards the
        # lower ones, and both may step sideways once the river is crossed.
        step = 1 if side == "w" else -1
        across = row >= 5 if side == "w" else row <= 4
        sideways = (abs(dcol) == 1 and drow == 0) if across else False
        if (dcol, drow) != (0, step) and not sideways:
            raise ConventionError(f"pawn cannot move {dcol},{drow}")
    elif kind in ("R", "C"):
        if dcol and drow:
            raise ConventionError(f"chariot or cannon cannot move {dcol},{drow}")
    captured = board[to_row][to_col] != "."
    board[row][col] = "."
    board[to_row][to_col] = piece
    return captured


class Player:
    """One engine, with its own net in its own directory."""

    def __init__(self, directory: Path, name: str, nodes: int, timeout: float):
        self.name = name
        self.nodes = nodes
        self.engine = Engine(directory / "pikafish.exe", timeout=timeout, cwd=directory)
        self.engine.send("setoption name Threads value 1")
        self.engine.send("setoption name Hash value 32")
        self.engine.send("isready")
        self.engine.read_until("readyok")

    def new_game(self) -> None:
        self.engine.send("ucinewgame")
        self.engine.send("isready")
        self.engine.read_until("readyok")

    def best_move(self, fen: str, moves: list[str]) -> str:
        command = f"position fen {fen}"
        if moves:
            command += " moves " + " ".join(moves)
        self.engine.send(command)
        self.engine.send(f"go nodes {self.nodes}")
        lines = self.engine.read_until("bestmove")
        if lines is None:
            raise RuntimeError(f"{self.name}: engine died")
        for line in lines:
            if line.startswith("bestmove"):
                parts = line.split()
                return parts[1] if len(parts) > 1 else "0000"
        return "0000"

    def close(self) -> None:
        self.engine.close()


def play_game(
    teacher: Player, student: Player, fen: str, student_is_red: bool, max_plies: int
) -> dict:
    board, side, halfmove = parse_fen(fen)
    moves: list[str] = []
    seen: dict[str, int] = {board_key(board, side): 1}
    teacher.new_game()
    student.new_game()

    while len(moves) < max_plies:
        student_to_move = (side == "w") == student_is_red
        player = student if student_to_move else teacher
        move = player.best_move(fen, moves)
        if move in ("0000", "(none)"):
            # No legal move: in xiangqi that is a loss for the side to move.
            loser = "student" if student_to_move else "teacher"
            return {
                "result": "teacher" if loser == "student" else "student",
                "reason": "no legal move",
                "plies": len(moves),
            }
        moves.append(move)
        captured = apply_move(board, move, side)
        halfmove = 0 if captured else halfmove + 1
        side = "b" if side == "w" else "w"
        key = board_key(board, side)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] >= 3:
            return {"result": "draw", "reason": "threefold repetition", "plies": len(moves)}
        if halfmove >= 120:
            return {"result": "draw", "reason": "sixty moves", "plies": len(moves)}
    return {"result": "draw", "reason": "ply cap", "plies": len(moves)}


def elo(score: float) -> float:
    if score <= 0:
        return -800.0
    if score >= 1:
        return 800.0
    return -400.0 * math.log10(1.0 / score - 1.0)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--teacher", required=True)
    p.add_argument("--student", required=True)
    p.add_argument("--fens", required=True)
    p.add_argument("--games", type=int, default=200)
    p.add_argument("--nodes", type=int, default=4000)
    p.add_argument("--max-plies", type=int, default=200)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--timeout", type=float, default=120.0)
    p.add_argument("--out", default="")
    args = p.parse_args(argv[1:])

    fens = [
        line.strip()
        for line in Path(args.fens).read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    rng = random.Random(args.seed)
    rng.shuffle(fens)
    if len(fens) < args.games:
        print(f"only {len(fens)} positions for {args.games} games")
        args.games = len(fens)

    teacher = Player(Path(args.teacher), "teacher", args.nodes, args.timeout)
    student = Player(Path(args.student), "student", args.nodes, args.timeout)
    games: list[dict] = []
    started = time.time()
    try:
        for index in range(args.games):
            fen = fens[index]
            student_is_red = index % 2 == 0
            result = play_game(teacher, student, fen, student_is_red, args.max_plies)
            result["student_red"] = student_is_red
            games.append(result)
            if (index + 1) % 10 == 0:
                wins = sum(1 for g in games if g["result"] == "student")
                losses = sum(1 for g in games if g["result"] == "teacher")
                draws = len(games) - wins - losses
                print(
                    f"  {index + 1:4d}/{args.games}  student {wins} - {losses} - {draws}"
                    f"  ({(time.time() - started) / 60:.1f} min)",
                    flush=True,
                )
    finally:
        teacher.close()
        student.close()

    wins = sum(1 for g in games if g["result"] == "student")
    losses = sum(1 for g in games if g["result"] == "teacher")
    draws = len(games) - wins - losses
    score = (wins + 0.5 * draws) / len(games) if games else 0.0
    reasons: dict[str, int] = {}
    for g in games:
        reasons[g["reason"]] = reasons.get(g["reason"], 0) + 1
    summary = {
        "games": len(games),
        "student_wins": wins,
        "teacher_wins": losses,
        "draws": draws,
        "student_score": score,
        "elo_vs_teacher": elo(score),
        "nodes": args.nodes,
        "reasons": reasons,
        "minutes": (time.time() - started) / 60,
    }
    print("\n=== match: student (25 MB net) vs teacher (50 MB net) ===")
    print(f"games           {summary['games']} at {args.nodes} nodes per move")
    print(f"student         {wins} win  {draws} draw  {losses} loss")
    print(f"score           {score:.3f}   Elo vs teacher {summary['elo_vs_teacher']:+.0f}")
    print(f"endings         {reasons}")
    print(f"time            {summary['minutes']:.1f} min")
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(
            json.dumps({"summary": summary, "games": games}, indent=2), encoding="utf-8"
        )
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
