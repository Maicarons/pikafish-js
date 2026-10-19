#!/usr/bin/env bash
# Build the three Pikafish WebAssembly variants.
#
# Prerequisite: Emscripten 3.1.74 is active (`em++ --version`).
# On CI use mymindstorm/setup-emsdk; locally use $EMSDK/emsdk_env.sh.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

commit=$(node -e "console.log(require('./engine.json').upstream.commit)")
out_root="${OUT_DIR:-$root/dist/wasm}"
upstream="$root/upstream"
src_dir="$upstream/src"

if ! command -v em++ >/dev/null 2>&1; then
  echo "em++ not found. Activate emsdk 3.1.74 first." >&2
  exit 1
fi

emcc_version=$(em++ --version | head -n 1)
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

mapfile -t source_paths < <(find -L "$src_dir" \
  \( -path '*/universal/*' -o -path '*/temp_builds/*' \) -prune -o \
  -name '*.cpp' -print | sort)

common_flags=(
  -I"$src_dir"
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

build_one() {
  local name=$1
  local max_memory=$2
  shift 2
  local out="$out_root/$name"
  mkdir -p "$out"
  echo "Building $name -> $out"
  em++ \
    "${source_paths[@]}" \
    "${common_flags[@]}" \
    -sMAXIMUM_MEMORY="$max_memory" \
    "$@" \
    -o "$out/pikafish.js"
  cp "$upstream/Copying.txt" "$out/COPYING.txt"
  printf '%s\n' "$name" > "$out/VARIANT.txt"
}

simd_flags=(
  -DUSE_SSE2 -msse2
  -DUSE_SSSE3 -mssse3
  -DUSE_SSE41 -msse4.1
  -msimd128
)

thread_flags=(
  -sPTHREAD_POOL_SIZE=8
  -sPTHREAD_POOL_SIZE_STRICT=2
)

build_one threads-simd 1GB "${thread_flags[@]}" "${simd_flags[@]}"
build_one single-simd 512MB "${simd_flags[@]}"
build_one single-nosimd 512MB

node "$root/scripts/write-wasm-manifest.mjs" "$out_root"

echo
echo "WASM builds:"
find "$out_root" -maxdepth 2 -type f \( -name 'pikafish.js' -o -name 'pikafish.wasm' \) -printf '%p %s bytes\n' | sort
