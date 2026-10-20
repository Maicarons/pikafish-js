"""Kaggle entry point: build, make positions, label, shard, train, export.

Six stages, each skipped once it has a marker in `PIKAFISH_WORK`, so a session
that hits Kaggle's 12-hour limit can be continued:

    build      copy `upstream/src` to the work dir, `make build`, link the dump
               tool.  A second copy with `L1 = PIKAFISH_HALF` is built when the
               student is narrower than the teacher, because only an engine of
               the student's width can load the student's net.
    positions  `training/python/selfplay.py` recipes: some games at low strength
               (real play, where the teacher's opinion matters) and some from
               material aimed at each layer-stack bucket.  The stage fails if
               the corpus does not cover all 32.
    label      `pikafish-dump` writes PKFD v2: both perspectives' feature
               indices, the bucket, and the teacher's internal evaluation.
    shards     `reader.write_shards` turns the dump into `.npz` shards.
    train      `train.py`, warm started from the teacher and resumable.
    export     `export_student.py`: write the `.nnue`, check it against the
               model, then load it in the half-width engine and bench it.

Environment (all optional except the teacher net):
    PIKAFISH_REPO         repo root; default: the current directory
    PIKAFISH_WORK         scratch and output; default: /kaggle/working/train
    PIKAFISH_NET          teacher net; default: <repo>/assets/pikafish.nnue
    PIKAFISH_HALF         student L1; default 512
    PIKAFISH_STEPS        training steps; default 200000
    PIKAFISH_GEN_MINUTES  minutes of position generation; default 20
    PIKAFISH_BATCH        batch size; default 1024
    PIKAFISH_LR           learning rate; default 1e-3
    PIKAFISH_STAGES       space-separated subset of the stages, default all
    PIKAFISH_FORCE        1 to redo stages that have a marker
    PIKAFISH_ARCH         engine ARCH; default x86-64

The Kaggle API token is never read here: upload datasets and push kernels with
the CLI on your own machine, where ~/.kaggle/kaggle.json lives.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(os.environ.get("PIKAFISH_REPO", ".")).resolve()
WORK = Path(os.environ.get("PIKAFISH_WORK", "/kaggle/working/train"))
NET = Path(os.environ.get("PIKAFISH_NET", REPO / "assets" / "pikafish.nnue")).resolve()
HALF = int(os.environ.get("PIKAFISH_HALF", "512"))
STEPS = os.environ.get("PIKAFISH_STEPS", "200000")
GEN_MINUTES = os.environ.get("PIKAFISH_GEN_MINUTES", "20")
BATCH = os.environ.get("PIKAFISH_BATCH", "1024")
LR = os.environ.get("PIKAFISH_LR", "1e-3")
ARCH = os.environ.get("PIKAFISH_ARCH", "x86-64")
FORCE = os.environ.get("PIKAFISH_FORCE", "") == "1"
STAGES = os.environ.get(
    "PIKAFISH_STAGES", "build positions label shard train export"
).split()

PY = sys.executable
PYDIR = REPO / "training" / "python"


def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run([str(c) for c in cmd], cwd=cwd, check=check)


def stage(name: str) -> bool:
    return name in STAGES


def finished(name: str) -> bool:
    return (WORK / f".{name}.done").exists() and not FORCE


def mark(name: str, note: str = "") -> None:
    (WORK / f".{name}.done").write_text(note + "\n", encoding="utf-8")


def jobs() -> str:
    return os.environ.get("PIKAFISH_JOBS", str(max(1, (os.cpu_count() or 2))))


def link_dump_tool(src: Path, out: Path) -> None:
    """Links the tool against the objects `make build` just produced.

    The object files are reused as they are, so only the link flags have to
    match the compiler's; which OpenMP or static flags the Makefile chose is not
    knowable here, so the plausible combinations are tried in turn and the
    first that produces a runnable binary wins.
    """
    objects = sorted(p for p in src.glob("*.o") if p.name != "main.o")
    if not objects:
        raise SystemExit(f"no object files in {src}; did `make build` run?")

    base = [
        os.environ.get("CXX", "g++"),
        "-std=c++17",
        "-O2",
        "-DNDEBUG",
        "-DIS_64BIT",
        "-DUSE_SSE2",
        "-msse2",
        f"-DARCH={ARCH}",
        "-flto",
        "-I",
        str(src),
        str(REPO / "training" / "engine" / "dump_tool.cpp"),
        *objects,
        "-o",
        str(out),
    ]
    attempts = [
        ["-lpthread"],
        ["-fopenmp", "-lpthread"],
        ["-static", "-lpthread"],
        ["-fopenmp", "-static", "-lpthread"],
    ]
    for extra in attempts:
        result = subprocess.run([str(c) for c in base + extra], capture_output=True, text=True)
        if result.returncode:
            print(f"link with {' '.join(extra)} failed:\n{result.stderr[-1200:]}")
            continue
        probe = subprocess.run([str(out), "inspect", str(NET)], capture_output=True, text=True)
        if "l1" in probe.stdout or "l1" in probe.stderr:
            print(f"linked {out} with {' '.join(extra)}")
            print(probe.stdout.strip() or probe.stderr.strip())
            return
        print(f"linked with {' '.join(extra)} but `inspect` misbehaved:\n{probe.stderr[-800:]}")
    raise SystemExit(f"could not link {out}")


def patch_l1(src: Path, half: int) -> None:
    """Sets `L1` in the copied tree; it is the only 1024 that means the width."""
    path = src / "nnue" / "nnue_architecture.h"
    text = path.read_text(encoding="utf-8")
    out, hits = [], 0
    for line in text.splitlines(keepends=True):
        if "L1" in line and "1024" in line:
            line = line.replace("1024", str(half))
            hits += 1
        out.append(line)
    if hits != 1:
        raise SystemExit(f"expected exactly one `L1 = 1024` in {path}, found {hits}")
    path.write_text("".join(out), encoding="utf-8")
    print(f"patched {path} to L1 = {half}")


def build_engine(tag: str, half: int | None) -> tuple[Path, Path]:
    """Builds one engine tree and its dump tool.  Returns `(engine, tool)`."""
    src = WORK / (f"src-{half}" if half else "src")
    if src.exists():
        shutil.rmtree(src)
    shutil.copytree(REPO / "upstream" / "src", src)
    for junk in (".build_sha.txt", ".depend", ".build_diffindex.txt"):
        (src / junk).unlink(missing_ok=True)
    if half:
        patch_l1(src, half)

    run(["make", "-j", jobs(), "build", f"ARCH={ARCH}"], cwd=src)
    engine = src / "pikafish"
    if not engine.exists():
        raise SystemExit(f"{engine} was not produced")
    shutil.copyfile(NET, src / "pikafish.nnue")

    tool = WORK / (f"pikafish-dump-{half}" if half else "pikafish-dump")
    link_dump_tool(src, tool)
    print(f"{tag}: engine {engine}")
    return engine, tool


def resolve_paths() -> tuple[Path, Path, Path, Path]:
    """Where the engine, the teacher's tool and the student's tool live.

    Overridable so a run can reuse an engine built outside this script (a local
    MinGW build, or a previous Kaggle session's work directory).
    """
    engine = Path(os.environ.get("PIKAFISH_ENGINE", WORK / "src" / "pikafish"))
    teacher_tool = Path(os.environ.get("PIKAFISH_TEACHER_TOOL", WORK / "pikafish-dump"))
    student_tool = Path(
        os.environ.get(
            "PIKAFISH_STUDENT_TOOL",
            WORK / (f"pikafish-dump-{HALF}" if HALF != 1024 else "pikafish-dump"),
        )
    )
    student_engine = Path(
        os.environ.get(
            "PIKAFISH_STUDENT_ENGINE",
            WORK / (f"src-{HALF}" if HALF != 1024 else "src") / "pikafish",
        )
    )
    return engine, teacher_tool, student_tool, student_engine


def build_if_needed() -> None:
    if not stage("build") or finished("build"):
        print("build: skipped")
        return
    build_engine("teacher", None)
    if HALF != 1024:
        build_engine("student", HALF)
    mark("build", f"HALF={HALF} ARCH={ARCH}")


# Games per generation recipe.  The first two are ordinary play (which is the
# data the teacher's opinion is really about), the rest aim at material the
# layer stacks need: no rooks, two rooks with no knights, and two rooks with a
# single knight on one side.
RECIPES: list[tuple[str, list[str]]] = [
    ("search", ["--policy", "search", "--nodes", "2000", "--thin-prob", "0.35"]),
    ("random", ["--policy", "random", "--thin-prob", "0.5", "--max-plies", "180"]),
    ("rookless", ["--thin-prob", "1.0", "--thin-ratio", "0", "--target-rooks", "0", "--target-nc", "4", "--max-plies", "50"]),
    ("rooks2nc0", ["--thin-prob", "1.0", "--thin-ratio", "0", "--target-rooks", "2", "--target-nc", "0", "--max-plies", "50"]),
    ("rooks2nc10", ["--thin-prob", "1.0", "--thin-ratio", "0", "--target-rooks", "2", "--target-nc", "1,0", "--max-plies", "30"]),
    ("nothing", ["--thin-prob", "1.0", "--thin-ratio", "0", "--target-rooks", "0", "--target-nc", "1,0", "--max-plies", "30"]),
]


def stage_positions(engine: Path) -> Path:
    fens_dir = WORK / "fens"
    out = WORK / "fens.txt"
    if finished("positions") and out.exists():
        print("positions: already done")
        return out

    fens_dir.mkdir(parents=True, exist_ok=True)
    games = os.environ.get("PIKAFISH_GEN_GAMES", "")
    per_recipe = max(2, int(float(GEN_MINUTES) / len(RECIPES)))
    budget = ["--games", games] if games else ["--max-minutes", str(per_recipe)]
    for i, (name, extra) in enumerate(RECIPES):
        target = fens_dir / f"{name}.txt"
        if target.exists() and not FORCE:
            print(f"positions: {name} already done")
            continue
        run(
            [
                PY,
                PYDIR / "selfplay.py",
                "--engine",
                engine,
                "--out",
                target,
                "--seed",
                str(100 + i),
                "--quiet-every",
                "200",
                *budget,
                *extra,
            ]
        )

    # Merge, and refuse a corpus that cannot train every layer stack.
    sys.path.insert(0, str(PYDIR))
    from selfplay import bucket_of  # noqa: E402

    seen: set[str] = set()
    for path in sorted(fens_dir.glob("*.txt")):
        seen.update(line.strip() for line in path.read_text().splitlines() if line.strip())
    out.write_text("".join(f + "\n" for f in sorted(seen)), encoding="utf-8")

    counts: dict[int, int] = {}
    for f in seen:
        counts[bucket_of(f)] = counts.get(bucket_of(f), 0) + 1
    missing = [i for i in range(32) if i not in counts]
    print(f"positions: {len(seen)} unique, buckets {32 - len(missing)}/32")
    print("  " + "  ".join(f"{i}:{counts.get(i, 0)}" for i in range(32)))
    if missing:
        raise SystemExit(f"missing layer-stack buckets {missing}; raise PIKAFISH_GEN_MINUTES")
    mark("positions", f"{len(seen)} positions")
    return out


def stage_label(tool: Path, fens: Path) -> Path:
    dump = WORK / "all.bin"
    if finished("label") and dump.exists():
        print("label: already done")
        return dump
    run([tool, "dump", NET, fens, dump])
    mark("label", str(dump.stat().st_size))
    return dump


def stage_shard(dump: Path) -> Path:
    shards = WORK / "shards"
    if finished("shard") and any(shards.glob("shard-*.npz")):
        print("shard: already done")
        return shards
    run(
        [
            PY,
            "-c",
            "import sys; sys.path.insert(0, r'%s');"
            "from reader import read_dump, write_shards;"
            "d = read_dump(r'%s');"
            "print(len(write_shards(d, r'%s', per_shard=200000)), 'shards')" % (PYDIR, dump, shards),
        ]
    )
    mark("shard")
    return shards


def stage_train(shards: Path) -> Path:
    ckpt = WORK / "student.pt"
    args = [
        PY,
        PYDIR / "train.py",
        "--shards",
        shards,
        "--init-from",
        NET,
        "--half",
        str(HALF),
        "--steps",
        STEPS,
        "--batch-size",
        BATCH,
        "--lr",
        LR,
        "--target-clip",
        "4000",
        "--out",
        ckpt,
        "--save-every",
        os.environ.get("PIKAFISH_SAVE_EVERY", "2000"),
        "--log-every",
        "500",
        "--max-minutes",
        os.environ.get("PIKAFISH_TRAIN_MINUTES", "0"),
    ]
    if ckpt.exists() and not FORCE:
        args += ["--resume", ckpt]
        print("train: resuming")
    run(args)
    mark("train")
    return ckpt


def engine_smoke(engine: Path, nodes: str = "50000") -> None:
    """Confirms the engine loads the net and searches, with a bounded budget.

    Two traps avoided here: this fork's `bench` parses its own arguments, so a
    wrong guess means an unbounded run; and its `go` reads the rest of the input
    stream, so a piped script ending in `quit` never quits and the search runs
    until it is killed.  Commands are therefore sent one at a time and answered,
    which is how `selfplay.py` drives the engine all day.
    """
    sys.path.insert(0, str(PYDIR))
    from selfplay import Engine  # noqa: E402

    handle = Engine(engine)
    try:
        handle.send("position startpos")
        handle.send(f"go nodes {nodes}")
        lines = handle.read_until("bestmove")
    finally:
        handle.close()

    if lines is None:
        raise SystemExit(f"{engine} did not answer `go`")
    depth = [ln for ln in lines if ln.startswith("info depth")]
    best = [ln for ln in lines if ln.startswith("bestmove")]
    print("\n".join(depth[-2:] + best))
    if not best:
        raise SystemExit(f"{engine} did not search with the new net")
def stage_export(ckpt: Path, student_tool: Path, student_engine: Path | None, fens: Path) -> None:
    net = WORK / "student.nnue"
    args = [
        PY,
        PYDIR / "export_student.py",
        "--checkpoint",
        ckpt,
        "--out",
        net,
        "--shards",
        WORK / "shards",
        "--verify-positions",
        "600",
        "--engine",
        student_tool,
        "--fens",
        fens,
    ]
    run(args)

    # The net must also run in the engine proper, with search.
    if student_engine:
        shutil.copyfile(net, student_engine.parent / "pikafish.nnue")
        engine_smoke(student_engine, os.environ.get("PIKAFISH_BENCH_NODES", "50000"))

    report = {
        "half": HALF,
        "steps": STEPS,
        "net": str(net),
        "bytes": net.stat().st_size,
        "meta": json.loads(net.with_suffix(".json").read_text()),
    }
    (WORK / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    mark("export")


def main() -> int:
    started = time.time()
    WORK.mkdir(parents=True, exist_ok=True)
    print(f"repo {REPO}\nwork {WORK}\nnet  {NET}\nhalf {HALF}\nstages {' '.join(STAGES)}")
    if not NET.exists():
        print(f"no teacher net at {NET}", file=sys.stderr)
        return 2

    build_if_needed()
    engine, teacher_tool, student_tool, student_engine = resolve_paths()

    fens = stage_positions(engine) if stage("positions") else WORK / "fens.txt"
    dump = stage_label(teacher_tool, fens) if stage("label") else WORK / "all.bin"
    shards = stage_shard(dump) if stage("shard") else WORK / "shards"
    ckpt = stage_train(shards) if stage("train") else WORK / "student.pt"
    if stage("export"):
        stage_export(ckpt, student_tool, student_engine, fens)

    print(f"done in {(time.time() - started) / 60:.1f} minutes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
