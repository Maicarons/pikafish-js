"""What does the student lose per move, measured in the teacher's own scores?

The eval error of a distilled net is not a strength number.  What matters is
whether the search, which is fed a noisy eval, still picks the teacher's moves.
This tool answers that directly: for every position it asks both engines for
their best move, then asks each engine to score the *other's* move, and reports
the value the student throws away per move, in the teacher's judgement.

    python training/python/compare_engines.py \
        --teacher upstream/src --student training/engine/build-512/src \
        --fens training/data/parity-fens.txt --nodes 4000 --count 500

Both engines are given the same node budget, so this compares nets at equal
search, not equal time (the teacher, at L1=1024, is the slower engine).

The two scores per position are always from the side to move's point of view:
after ``position ... moves m`` it is the opponent who is to move, so the
engine's score is negated to describe the position the mover left behind.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from selfplay import Engine  # noqa: E402

SCORE_CP = re.compile(r"\bscore cp (-?\d+)")
SCORE_MATE = re.compile(r"\bscore mate (-?\d+)")
MATE_CP = 30_000


class Search:
    """One engine, one position at a time."""

    def __init__(self, directory: Path, name: str, timeout: float):
        self.directory = directory
        self.name = name
        self.engine = Engine(directory / "pikafish.exe", timeout=timeout, cwd=directory)
        self.engine.send("setoption name Threads value 1")
        self.engine.send("setoption name Hash value 32")
        self.engine.send("isready")
        self.engine.read_until("readyok")

    def search(self, fen: str, moves: list[str], nodes: int) -> tuple[str | None, int | None]:
        command = f"position fen {fen}"
        if moves:
            command += " moves " + " ".join(moves)
        self.engine.send(command)
        self.engine.send(f"go nodes {nodes}")
        lines = self.engine.read_until("bestmove")
        if lines is None:
            raise RuntimeError(f"{self.name}: engine died on {fen}")
        best: str | None = None
        score: int | None = None
        for line in lines:
            if line.startswith("bestmove"):
                parts = line.split()
                best = parts[1] if len(parts) > 1 else None
            found = SCORE_CP.search(line)
            if found:
                score = int(found.group(1))
            found = SCORE_MATE.search(line)
            if found:
                mate = int(found.group(1))
                score = MATE_CP if mate > 0 else -MATE_CP
        return best, score

    def close(self) -> None:
        self.engine.close()


def evaluate(
    teacher: Search, student: Search, fens: list[str], nodes: int, max_abs_score: int
) -> tuple[list[dict], dict]:
    rows: list[dict] = []
    started = time.time()
    for index, fen in enumerate(fens):
        t_best, t_score = teacher.search(fen, [], nodes)
        s_best, s_score = student.search(fen, [], nodes)
        if not t_best or not s_best or t_score is None or s_score is None:
            continue
        if t_best in ("0000", "(none)") or s_best in ("0000", "(none)"):
            continue
        _, t_on_s = teacher.search(fen, [s_best], nodes)
        _, t_on_t = teacher.search(fen, [t_best], nodes)
        _, s_on_t = student.search(fen, [t_best], nodes)
        _, s_on_s = student.search(fen, [s_best], nodes)
        if t_on_s is None or t_on_t is None or s_on_t is None or s_on_s is None:
            continue
        # Positions that are already decided (or a mate away) say nothing about
        # move quality and their scores are huge, so they are dropped.
        scores = (t_score, s_score, t_on_s, t_on_t, s_on_t, s_on_s)
        if any(abs(v) >= MATE_CP for v in scores):
            continue
        if abs(t_score) > max_abs_score:
            continue
        rows.append(
            {
                "fen": fen,
                "teacher_score": t_score,
                "student_score": s_score,
                "same_move": t_best == s_best,
                # Value the student gave up, in the teacher's judgement.  After
                # the move it is the opponent who is to move, so the engine's
                # score is the opponent's view and has to be negated to describe
                # what the mover left behind: regret = before - after.
                "regret_teacher": t_score + t_on_s,
                # The same thing as the student itself sees it.
                "regret_student": s_score + s_on_t,
                # Paired version: the teacher's own move, judged by the same
                # engine, is the baseline.  The difference cancels the search
                # noise and the systematic offset of the two searches.
                "excess_teacher": t_on_s - t_on_t,
                "excess_student": s_on_t - s_on_s,
                # The same baseline as an absolute number, i.e. the noise floor.
                "floor_teacher": t_score + t_on_t,
            }
        )
        if (index + 1) % 25 == 0:
            done = index + 1
            rate = done / (time.time() - started)
            print(
                f"  {done:5d}/{len(fens)}  {rate:5.1f} pos/s  "
                f"eta {(len(fens) - done) / max(rate, 1e-6) / 60:5.1f} min",
                flush=True,
            )
    return rows, {"seconds": time.time() - started}


def percentile(values: list[float], q: float) -> float:
    """Linear-interpolation percentile; `statistics.quantiles` needs two samples."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)


def summarise(rows: list[dict]) -> dict:
    if not rows:
        return {}
    regrets_t = [r["regret_teacher"] for r in rows]
    regrets_s = [r["regret_student"] for r in rows]
    excess_t = [r["excess_teacher"] for r in rows]
    excess_s = [r["excess_student"] for r in rows]
    floor = [r["floor_teacher"] for r in rows]
    same = [r for r in rows if r["same_move"]]
    diff = [r for r in rows if not r["same_move"]]
    t_scores = [r["teacher_score"] for r in rows]
    s_scores = [r["student_score"] for r in rows]
    return {
        "positions": len(rows),
        "move_agreement": 100.0 * len(same) / len(rows),
        "regret_teacher_mean": statistics.fmean(regrets_t),
        "regret_teacher_median": statistics.median(regrets_t),
        "regret_student_mean": statistics.fmean(regrets_s),
        "regret_student_median": statistics.median(regrets_s),
        "excess_teacher_mean": statistics.fmean(excess_t),
        "excess_teacher_median": statistics.median(excess_t),
        "excess_teacher_p75": percentile(excess_t, 0.75),
        "excess_teacher_p90": percentile(excess_t, 0.90),
        "excess_student_mean": statistics.fmean(excess_s),
        "excess_student_median": statistics.median(excess_s),
        "excess_teacher_when_different": statistics.fmean(
            [r["excess_teacher"] for r in diff]
        )
        if diff
        else 0.0,
        "excess_teacher_when_same": statistics.fmean([r["excess_teacher"] for r in same])
        if same
        else 0.0,
        "noise_floor_mean": statistics.fmean(floor),
        "noise_floor_median": statistics.median(floor),
        "score_correlation": (
            statistics.correlation(t_scores, s_scores) if len(rows) > 2 else 0.0
        ),
        "score_bias": statistics.fmean(s_scores) - statistics.fmean(t_scores),
        "teacher_score_mean": statistics.fmean(t_scores),
    }


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--teacher", required=True, help="directory with pikafish.exe and the teacher net")
    p.add_argument("--student", required=True, help="directory with pikafish.exe and the student net")
    p.add_argument("--fens", required=True, help="file with one FEN per line")
    p.add_argument("--nodes", type=int, default=4000)
    p.add_argument("--count", type=int, default=500)
    p.add_argument("--skip", type=int, default=0)
    p.add_argument("--timeout", type=float, default=120.0)
    p.add_argument(
        "--max-abs-score",
        type=int,
        default=1000,
        help="drop positions the teacher already calls decided (|score| above this)",
    )
    p.add_argument("--out", default="")
    args = p.parse_args(argv[1:])

    fens = [
        line.strip()
        for line in Path(args.fens).read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    fens = fens[args.skip : args.skip + args.count]
    if not fens:
        print("no positions")
        return 2

    teacher = Search(Path(args.teacher), "teacher", args.timeout)
    student = Search(Path(args.student), "student", args.timeout)
    print(f"positions {len(fens)}  nodes {args.nodes} per search", flush=True)
    try:
        rows, timing = evaluate(teacher, student, fens, args.nodes, args.max_abs_score)
    finally:
        teacher.close()
        student.close()

    summary = summarise(rows)
    print("\n=== per-move cost of the distilled net ===")
    print(f"positions            {summary.get('positions', 0)}")
    print(f"move agreement       {summary.get('move_agreement', 0):.1f}%")
    print(
        f"excess cost         {summary.get('excess_teacher_mean', 0):+7.1f} cp mean, "
        f"{summary.get('excess_teacher_median', 0):+6.1f} cp median, "
        f"p75 {summary.get('excess_teacher_p75', 0):+6.1f}, "
        f"p90 {summary.get('excess_teacher_p90', 0):+6.1f}   (teacher's judgement)"
    )
    print(
        f"  student thinks     {summary.get('excess_student_mean', 0):+7.1f} cp mean, "
        f"{summary.get('excess_student_median', 0):+6.1f} cp median"
    )
    print(
        f"  when the move differs {summary.get('excess_teacher_when_different', 0):+7.1f} cp"
        f"   (n={summary.get('positions', 0) * (1 - summary.get('move_agreement', 0) / 100):.0f})"
    )
    print(f"  when the move agrees  {summary.get('excess_teacher_when_same', 0):+7.1f} cp")
    print(
        f"noise floor         {summary.get('noise_floor_mean', 0):+7.1f} cp mean, "
        f"{summary.get('noise_floor_median', 0):+6.1f} cp median"
    )
    print(f"score correlation     {summary.get('score_correlation', 0):.4f}")
    print(f"score bias            {summary.get('score_bias', 0):+.1f} cp")
    print(f"teacher score mean    {summary.get('teacher_score_mean', 0):+.1f} cp")
    print(f"search time           {timing['seconds'] / 60:.1f} min")

    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(
            json.dumps({"summary": summary, "rows": rows}, indent=2), encoding="utf-8"
        )
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
