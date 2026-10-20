#!/usr/bin/env bash
# Builds the training data tool against the engine sources.
#
#   bash training/engine/build.sh                    # against upstream/src (L1=1024)
#   SRC=training/engine/build-512/src OUT=training/engine/pikafish-dump-512 \
#       bash training/engine/build.sh                # against an L1=512 tree
#   CXX=clang++ bash training/engine/build.sh
#
# The tool links the object files the normal engine build already produced
# (everything except main.o) and reuses the engine's feature extraction and
# evaluation, so the dumped indices are exactly the ones the engine uses.
# Nothing in upstream/src is modified.
#
# In-tree building puts the objects next to the sources, which is what the repo
# has always done; `training/kaggle/run.py` instead copies the tree into its work
# directory and patches `L1` for the student, so prefer overriding SRC/OUT when
# you need a width other than the teacher's.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="${SRC:-$ROOT/upstream/src}"
OUT="${OUT:-$HERE/pikafish-dump}"
CXX="${CXX:-g++}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
NET="${PIKAFISH_NET:-$ROOT/assets/pikafish.nnue}"

if [ ! -d "$SRC" ]; then
    echo "no engine sources at $SRC; run scripts/fetch-wasm.sh or clone the pinned commit" >&2
    exit 1
fi

# 1. Engine objects.  `make build` also needs a net; the Makefile's `net` target
#    would download 50 MB, so hand it the local copy when we have one.
if [ ! -f "$SRC/pikafish.nnue" ] && [ -f "$NET" ]; then
    cp "$NET" "$SRC/pikafish.nnue"
    echo "placed net at $SRC/pikafish.nnue"
fi

if ! ls "$SRC"/*.o >/dev/null 2>&1; then
    echo "building engine objects (this takes a few minutes)"
    ( cd "$SRC" && make -j"$JOBS" build ARCH=x86-64 )
fi

# 2. The tool.  Which OpenMP or static flags the Makefile chose is not knowable
#    from here, so the plausible combinations are tried in turn.
mapfile -t OBJS < <(find "$SRC" -maxdepth 1 -name '*.o' ! -name 'main.o' | sort)
BASE=(-std=c++17 -O2 -DNDEBUG -DIS_64BIT -DUSE_SSE2 -msse2 -DARCH=x86-64 -flto
      -I"$SRC" "$HERE/dump_tool.cpp" "${OBJS[@]}" -o "$OUT")

for EXTRA in "-lpthread" "-fopenmp -lpthread" "-static -lpthread" "-fopenmp -static -lpthread"; do
    # shellcheck disable=SC2086
    if "$CXX" "${BASE[@]}" $EXTRA 2>/tmp/pikafish-dump-link.log && out="$("$OUT" inspect "$SRC/pikafish.nnue" 2>&1)" && [[ "$out" == *l1* ]]; then
        echo "built $OUT ($EXTRA)"
        echo "$out"
        exit 0
    fi
done

echo "could not link $OUT; last attempt's error:" >&2
cat /tmp/pikafish-dump-link.log >&2
exit 1
