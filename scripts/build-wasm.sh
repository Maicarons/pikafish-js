#!/usr/bin/env bash
# Build the Pikafish WebAssembly variants.
#
# There are two engine widths and three capability variants each:
#
#   strong  the official L1=1024 net, 50 MB
#   lite    the distilled L1=512 net, 25 MB (see training/README.md)
#
# The two widths differ in exactly one line of the upstream source
# (`nnue/nnue_architecture.h`: the `L1` constant), so the narrower engine is a
# copy of the tree with that line rewritten.  The nets are not part of the
# build: the engine loads one at runtime.
#
# Prerequisite: Emscripten 3.1.74 is active (`em++ --version`).
# On CI use mymindstorm/setup-emsdk; locally use $EMSDK/emsdk_env.sh.
# On Windows with MSYS/Git Bash the POSIX `em++` shim is not executable and
# `em++.bat` must be used instead: `EMXX=em++.bat bash scripts/build-wasm.sh`.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

emxx="${EMXX:-em++}"

commit=$(node -e "console.log(require('./engine.json').upstream.commit)")
out_root="${OUT_DIR:-$root/dist/wasm}"
upstream="$root/upstream"
src_dir="$upstream/src"

if ! command -v "$emxx" >/dev/null 2>&1; then
  echo "$emxx not found. Activate emsdk 3.1.74 first." >&2
  exit 1
fi

emcc_version=$("$emxx" --version | head -n 1)
echo "Using $emcc_version"

if [ ! -f "$src_dir/main.cpp" ]; then
  echo "Cloning Pikafish at $commit"
  git clone "$(node -e "console.log(require('./engine.json').upstream.repository)")" "$upstream"
  git -C "$upstream" checkout "$commit"
fi

actual_commit=$(git -C "$upstream" rev-parse HEAD)
if [ "$actual_commit" != "$commit" ]; then
  echo "Upstream is at $actual_commit, expected $commit." >&2
  echo "Run: git -C upstream fetch origin && git -C upstream checkout $commit" >&2
  exit 1
fi

if ! grep -q "pikafish_initialize" "$src_dir/main.cpp"; then
  echo "Applying browser patch"
  git -C "$upstream" apply --ignore-whitespace "$root/patches/pikafish-wasm.patch"
fi

if ! grep -q "pikafish_initialize" "$src_dir/main.cpp"; then
  echo "Patch did not apply cleanly." >&2
  exit 1
fi

common_flags=(
  -I"@SRC@"
  -std=c++17
  -O3
  -funroll-loops
  -DNDEBUG
  -DIS_64BIT
  -DNO_PREFETCH
  -DUSE_POPCNT
  # Pikafish always needs at least one pthread: ThreadPool creates the main
  # search thread with pthread_create(). Cross-origin isolation (and therefore
  # SharedArrayBuffer) is a hard requirement for every build.
  -pthread
  -DUSE_SLOPPY_ATOMICS
  -Wno-pthreads-mem-growth
  -sWASM=1
  -sMODULARIZE=1
  -sEXPORT_NAME=Pikafish
  -sENVIRONMENT=web,worker
  -sEXPORT_ES6=0
  -sEXPORTED_FUNCTIONS=_pikafish_initialize,_pikafish_command,_main,_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=cwrap,FS
  -sINITIAL_MEMORY=64MB
  -sALLOW_MEMORY_GROWTH=1
  -sSTACK_SIZE=3MB
  -sNO_EXIT_RUNTIME=1
  -sINVOKE_RUN=0
  -sFILESYSTEM=1
  -sASSERTIONS=0
)

# Pikafish's ThreadPool always creates its search threads with pthread_create(),
# so every variant needs a pool. Preallocating is required rather than optional:
# Emscripten's on-demand worker creation from the module's main thread never
# completes here, which leaves engine initialisation hung forever. The pool size
# matches the thread clamp in packages/engine/src/capabilities.ts, and STRICT=2
# turns any unexpected overflow into a loud error instead of a silent hang.
threads_pool_flags=(-sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=2)
single_pool_flags=(-sPTHREAD_POOL_SIZE=2 -sPTHREAD_POOL_SIZE_STRICT=2)

simd_flags=(
  -DUSE_SSE2 -msse2
  -DUSE_SSSE3 -mssse3
  -DUSE_SSE41 -msse4.1
  -msimd128
)

# Upstream's `SRCS` also matches `*.S`, but the tree's only assembly file is
# `external/decompress/huf_decompress_amd64.S`, which is compiled only when
# `ZSTD_ARCH_X86_AMD64` is set (never on wasm32). Compiling `*.cpp` only is
# therefore equivalent here and avoids handing x86 asm to the wasm assembler.
source_paths_for() {
  find -L "$1" \
    \( -path '*/universal/*' -o -path '*/temp_builds/*' \) -prune -o \
    -name '*.cpp' -print | sort
}

# A copy of the tree with the `L1` width rewritten.  The copy is what the
# narrow engine is compiled from; the upstream checkout stays untouched.
tree_for_l1() {
  local l1=$1
  if [ "$l1" = "1024" ]; then
    echo "$src_dir"
    return
  fi
  local copy="$out_root/../src-l1-$l1"
  rm -rf "$copy"
  mkdir -p "$(dirname "$copy")"
  cp -r "$src_dir" "$copy"
  # The objects and the net belong to the native build, not to this copy.
  find "$copy" -maxdepth 1 -name '*.o' -delete
  rm -f "$copy"/*.nnue
  sed -i -E "s/^(constexpr IndexType L1 = )[0-9]+;/\1${l1};/" "$copy/nnue/nnue_architecture.h"
  if ! grep -q "constexpr IndexType L1 = ${l1};" "$copy/nnue/nnue_architecture.h"; then
    echo "Could not set L1 to $l1 in $copy/nnue/nnue_architecture.h" >&2
    exit 1
  fi
  echo "$copy"
}

build_one() {
  local engine=$1
  local build=$2
  local tree=$3
  local max_memory=$4
  shift 4
  local out="$out_root/$engine/$build"
  mkdir -p "$out"
  echo "Building $engine/$build -> $out"
  local sources=()
  mapfile -t sources < <(source_paths_for "$tree")
  local flags=()
  for flag in "${common_flags[@]}"; do
    flags+=("${flag//@SRC@/$tree}")
  done
  "$emxx" \
    "${sources[@]}" \
    "${flags[@]}" \
    -sMAXIMUM_MEMORY="$max_memory" \
    "$@" \
    -o "$out/pikafish.js"
  cp "$upstream/Copying.txt" "$out/COPYING.txt"
  printf '%s\n' "$engine" > "$out/ENGINE.txt"
}

# The engines and their widths come from engine.json, so adding one is a
# configuration change rather than a script change.
while read -r engine l1; do
  tree=$(tree_for_l1 "$l1")
  build_one "$engine" threads-simd "$tree" 1GB "${threads_pool_flags[@]}" "${simd_flags[@]}"
  build_one "$engine" single-simd "$tree" 512MB "${single_pool_flags[@]}" "${simd_flags[@]}"
  build_one "$engine" single-nosimd "$tree" 512MB "${single_pool_flags[@]}"
done < <(node -e "
  const c = require('./engine.json');
  for (const [name, e] of Object.entries(c.engines)) console.log(name, e.l1);
")

node "$root/scripts/write-wasm-manifest.mjs" "$out_root"

echo
echo "WASM builds:"
find "$out_root" -maxdepth 3 -type f \( -name 'pikafish.js' -o -name 'pikafish.wasm' \) -printf '%p %s bytes\n' | sort
