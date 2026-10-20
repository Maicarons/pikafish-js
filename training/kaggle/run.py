"""Kaggle entry point: bootstrap, build, make positions, label, shard, train, export.

The kernel upload only needs this folder.  Everything else is fetched, so the
code that runs is the commit you pushed rather than a dataset snapshot:

    repo       `git clone` of the public repository, when it is not already
               around (locally it is, so this is a no-op)
    upstream   Pikafish at the commit pinned in `engine.json`, fetched shallow,
               then `make build` on it
    net        the teacher net, verified against the size and SHA-256 in
               `engine.json`

Then six stages, each skipped once it has a marker in `PIKAFISH_WORK`, so a
session that hits Kaggle's 12-hour limit can be continued:

    build      `make build` and the dump tool.  A second tree with
               `L1 = PIKAFISH_HALF` is built when the student is narrower than
               the teacher, because only an engine of the student's width can
               load the student's net.
    positions  `training/python/selfplay.py` recipes: some games at low strength
               (real play, where the teacher's opinion matters) and some from
               material aimed at each layer-stack bucket.  The stage fails if
               the corpus does not cover all 32.
    label      `pikafish-dump` writes PKFD v2: both perspectives' feature
               indices, the bucket, and the teacher's internal evaluation.
    shards     `reader.write_shards` turns the dump into `.npz` shards.
    train      `train.py`, warm started from the teacher and resumable.
    export     `export_student.py`: write the `.nnue`, check it against the
               model, then load it in the half-width engine and search with it.

Knobs live in `kernel-params.json` next to this file (it travels with the kernel,
since Kaggle gives a script no way to pass environment variables) and can be
overridden by the environment, which is how the local smoke test works:

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

The Kaggle API token is never read here: pushing the kernel is the CLI's job,
on a machine where `kaggle auth login` has run or `KAGGLE_API_TOKEN` is set.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_URL = "https://github.com/Maicarons/pikafish-js.git"
PARAM_FILES = (HERE / "kernel-params.json", Path.cwd() / "kernel-params.json")


def _read_params(paths) -> tuple[dict[str, str], Path | None]:
    """The first `kernel-params.json` that parses, and where it came from.

    Kaggle runs the script from a directory of its own choosing and does not
    necessarily copy the kernel's other files next to it, so the knobs are also
    looked for in the repository, which `main` provides once it is cloned.
    """
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        return {str(k): str(v) for k, v in data.items() if v is not None}, path
    return {}, None


PARAMS, PARAMS_FROM = _read_params(PARAM_FILES)


def knob(name: str, default: str) -> str:
    """Environment first (that is how the local smoke test overrides), then the
    params file, then the default."""
    return os.environ.get(name) or PARAMS.get(name) or default


def _default_work() -> Path:
    kaggle = Path("/kaggle/working")
    return kaggle / "train" if kaggle.is_dir() else Path("training/out/kaggle")


REPO = Path(knob("PIKAFISH_REPO", ".")).resolve()
WORK = Path(knob("PIKAFISH_WORK", str(_default_work()))).resolve()
NET = Path(knob("PIKAFISH_NET", str(REPO / "assets" / "pikafish.nnue"))).resolve()


def refresh_knobs() -> None:
    """Reads the knobs, which may only be visible once the repository is there."""
    global HALF, STEPS, GEN_MINUTES, BATCH, LR, ARCH, FORCE, STAGES
    HALF = int(knob("PIKAFISH_HALF", "512"))
    STEPS = knob("PIKAFISH_STEPS", "200000")
    GEN_MINUTES = knob("PIKAFISH_GEN_MINUTES", "20")
    BATCH = knob("PIKAFISH_BATCH", "1024")
    LR = knob("PIKAFISH_LR", "1e-3")
    ARCH = knob("PIKAFISH_ARCH", "x86-64")
    FORCE = knob("PIKAFISH_FORCE", "") == "1"
    STAGES = knob("PIKAFISH_STAGES", "build positions label shard train export").split()


HALF = 512
STEPS = "200000"
GEN_MINUTES = "20"
BATCH = "1024"
LR = "1e-3"
ARCH = "x86-64"
FORCE = False
STAGES: list[str] = []
refresh_knobs()

PY = sys.executable
PYDIR = REPO / "training" / "python"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def engine_json(repo: Path) -> dict:
    return json.loads((repo / "engine.json").read_text(encoding="utf-8"))


def ensure_repo(repo: Path) -> Path:
    """The repository this script belongs to.

    The Kaggle upload holds only this folder, so the repository is cloned from
    the pushed branch; locally it is already there and this changes nothing.
    """
    if (repo / "training" / "python" / "train.py").is_file():
        return repo

    dest = WORK / "repo"
    if not (dest / "training" / "python" / "train.py").is_file():
        if dest.exists():
            shutil.rmtree(dest)
        run(["git", "clone", "--depth", "1", knob("PIKAFISH_REPO_URL", REPO_URL), dest])
        commit = subprocess.run(
            ["git", "-C", str(dest), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
        ).stdout.strip()
        print(f"repo: cloned at {commit}")
    return dest


def ensure_sources(repo: Path) -> None:
    """Pikafish at the commit pinned in `engine.json`, fetched shallowly.

    The wasm build patches this tree, the native one does not, so a pristine
    checkout is what the engine and the dump tool are compiled from.
    """
    if (repo / "upstream" / "src" / "nnue" / "nnue_architecture.h").is_file():
        return

    config = engine_json(repo)["upstream"]
    url, commit = config["repository"], config["commit"]
    dest = repo / "upstream"
    dest.mkdir(parents=True, exist_ok=True)
    if not (dest / ".git").is_dir():
        run(["git", "init", str(dest)])
        run(["git", "-C", str(dest), "remote", "add", "origin", url])

    # Asking for one hash keeps the 100 MB of history out of the download;
    # GitHub serves a reachable commit directly, and a full clone is the
    # fallback when it does not.
    fetched = subprocess.run(
        ["git", "-C", str(dest), "fetch", "--depth", "1", "origin", commit],
        capture_output=True,
        text=True,
    )
    if fetched.returncode:
        print(f"fetch of {commit[:12]} failed, cloning the history instead", flush=True)
        shutil.rmtree(dest)
        run(["git", "clone", "--filter=blob:none", url, dest])
    run(["git", "-C", str(dest), "checkout", "--detach", commit])

    got = subprocess.run(
        ["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip()
    if got != commit:
        raise SystemExit(f"upstream is at {got or 'nothing'}, expected {commit}")
    print(f"upstream: {commit[:12]} in {dest}")


def ensure_net(repo: Path) -> Path:
    """The teacher net, verified against the size and hash in `engine.json`."""
    explicit = os.environ.get("PIKAFISH_NET") or PARAMS.get("PIKAFISH_NET")
    target = Path(explicit).resolve() if explicit else (repo / "assets" / "pikafish.nnue").resolve()
    if explicit and target.is_file():
        print(f"net: {target} (given, {target.stat().st_size} bytes)")
        return target

    config = engine_json(repo)["net"]
    size, digest = int(config["size"]), config["sha256"]
    if target.is_file() and target.stat().st_size == size and sha256_file(target) == digest:
        print(f"net: {target} verified ({size} bytes)")
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    print(f"net: downloading {config['url']}", flush=True)
    request = urllib.request.Request(config["url"], headers={"User-Agent": "pikafish-js-distill"})
    seen = 0
    with urllib.request.urlopen(request) as response, part.open("wb") as out:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            if out.tell() - seen >= 10 << 20:
                seen = out.tell()
                print(f"  {seen / 1e6:.0f} MB", flush=True)

    got_hash, got_size = sha256_file(part), part.stat().st_size
    if got_size != size or got_hash != digest:
        part.unlink()
        raise SystemExit(f"net mismatch: {got_size} bytes / {got_hash}, expected {size} / {digest}")
    part.replace(target)
    print(f"net: {target} ({size} bytes)")
    return target


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


def engine_binary(tree: Path) -> Path:
    """`pikafish` in a build tree; MinGW names it `.exe`."""
    for name in ("pikafish", "pikafish.exe"):
        if (tree / name).exists():
            return tree / name
    return tree / "pikafish"


def build_engine(tag: str, half: int | None) -> tuple[Path, Path]:
    """Builds one engine tree and its dump tool.  Returns `(engine, tool)`."""
    src = WORK / (f"src-{half}" if half else "src")
    if src.exists():
        shutil.rmtree(src)
    shutil.copytree(REPO / "upstream" / "src", src)

    # `make build` depends on `net`, which runs `../scripts/net.sh`; only `src/`
    # was copied above, so the script has to be put back too.  With the net
    # already in the tree, net.sh prints "Exists … skipping download" instead of
    # fetching another 50 MB.
    scripts = WORK / "scripts"
    if not scripts.exists():
        shutil.copytree(REPO / "upstream" / "scripts", scripts)
    shutil.copyfile(NET, src / "pikafish.nnue")

    for junk in (".build_sha.txt", ".depend", ".build_diffindex.txt"):
        (src / junk).unlink(missing_ok=True)
    if half:
        patch_l1(src, half)

    run(["make", "-j", jobs(), "build", f"ARCH={ARCH}"], cwd=src)
    engine = engine_binary(src)
    if not engine.exists():
        raise SystemExit(f"{src / 'pikafish'} was not produced")

    tool = WORK / (f"pikafish-dump-{half}" if half else "pikafish-dump")
    link_dump_tool(src, tool)
    print(f"{tag}: engine {engine}")
    return engine, tool


def resolve_paths() -> tuple[Path, Path, Path, Path]:
    """Where the engine, the teacher's tool and the student's tool live.

    Overridable so a run can reuse an engine built outside this script (a local
    MinGW build, or a previous Kaggle session's work directory).
    """
    engine = Path(
        os.environ.get("PIKAFISH_ENGINE", engine_binary(WORK / "src"))
    )
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
            engine_binary(WORK / (f"src-{HALF}" if HALF != 1024 else "src")),
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
                "-u",
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
            "-u",
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
        "-u",
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
        knob("PIKAFISH_TRAIN_MINUTES", "600"),
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
        "-u",
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


def ensure_zstd() -> None:
    """`nnue_io` needs a zstd codec to read the teacher and write the student.

    Kaggle's image is Python 3.11, where the standard library has no zstd, and
    `zstandard` is not installed; it is a few seconds of pip.
    """
    for probe in ("import zstandard", "from compression import zstd"):
        if subprocess.run([PY, "-c", probe], capture_output=True).returncode == 0:
            return
    print("zstd: installing zstandard", flush=True)
    run([PY, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "zstandard"])


def main() -> int:
    started = time.time()
    global REPO, PYDIR, NET, PARAMS, PARAMS_FROM

    WORK.mkdir(parents=True, exist_ok=True)
    ensure_zstd()
    REPO = ensure_repo(REPO)
    PYDIR = REPO / "training" / "python"

    if PARAMS_FROM is None:
        # The kernel's own copy is not always next to the script; the repository
        # always has one, so this is the copy that counts on Kaggle.
        PARAMS, PARAMS_FROM = _read_params([REPO / "training" / "kaggle" / "kernel-params.json"])
        refresh_knobs()

    ensure_sources(REPO)
    NET = ensure_net(REPO)

    print(f"params {PARAMS_FROM or 'none, built-in defaults'}")
    print(
        f"repo {REPO}\nwork {WORK}\nnet  {NET}\nhalf {HALF}\n"
        f"steps {STEPS}\ngen {GEN_MINUTES} min\nbatch {BATCH} lr {LR}\nstages {' '.join(STAGES)}"
    )

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
