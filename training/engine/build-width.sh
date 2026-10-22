#!/usr/bin/env bash
# Builds the engine and the dump tool for one NNUE feature width.
#
#   bash training/engine/build-width.sh 256
#
# The width is a compile-time constant of the engine (`L1` in
# `nnue/nnue_architecture.h`), so a narrower engine is a copy of the tree with
# that one line rewritten.  The build then prints the architecture hashes of
# that width, which the Python side needs before it can write a net the engine
# will accept.
#
# The native build needs a `pikafish.nnue` in the tree (the Makefile depends on
# it), but only its presence: the file is read at runtime, not at build time.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: bash training/engine/build-width.sh <L1> [upstream-dir]" >&2
  exit 2
fi

width=$1
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
upstream="${2:-$root/upstream}"
tree="$here/build-$width"

if [ ! -f "$upstream/src/nnue/nnue_architecture.h" ]; then
  echo "no upstream sources at $upstream" >&2
  exit 1
fi

rm -rf "$tree"
mkdir -p "$tree"
cp -r "$upstream/src" "$tree/src"
cp -r "$upstream/scripts" "$tree/scripts"
find "$tree/src" -maxdepth 1 -name '*.o' -delete
rm -f "$tree/src"/*.nnue

sed -i -E "s/^(constexpr IndexType L1 = )[0-9]+;/\1${width};/" \
  "$tree/src/nnue/nnue_architecture.h"
if ! grep -q "constexpr IndexType L1 = ${width};" "$tree/src/nnue/nnue_architecture.h"; then
  echo "could not set L1 to $width" >&2
  exit 1
fi

# The Makefile's `net` target only checks that the file exists.
printf 'placeholder for the build; the real net is copied in afterwards\n' \
  > "$tree/src/pikafish.nnue"

SRC="$tree/src" OUT="$here/pikafish-dump-$width" bash "$here/build.sh"

echo
echo "width $width:"
"$here/pikafish-dump-$width" inspect
