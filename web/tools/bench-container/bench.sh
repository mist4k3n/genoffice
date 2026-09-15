#!/usr/bin/env bash
# Run the memory benchmark under Linux, from a macOS or Linux host.
#
# macOS cannot answer this question: `ps rss` there reports a compressed,
# purgeable working set, and the series it produces is non-monotonic -- engine
# RSS *falls* as workbooks are opened. See FINDINGS-PAPAN.md §1.
#
#   npm run bench:linux                                   # 24 corpus copies
#   npm run bench:linux -- --slope 3 --file big.xlsx      # a mounted corpus
#   PLATFORM=linux/amd64 CORPUS_DIR=/tmp/big npm run bench:linux
#   MALLOC_ARENA_MAX=1 npm run bench:linux -- --slope 3 --reopen
#
# The glibc tunables below are forwarded to the engine when set on the host,
# because what the allocator returns to the kernel on free is the difference
# between "half the memory is reclaimed" and "all of it is".
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
platform="${PLATFORM:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"
tag="sheets-bench:${platform##*/}"

docker buildx build --platform "$platform" -f "$here/Dockerfile" -t "$tag" --load "$repo"

# `set -u` and an empty array do not get along on bash 3, which is what macOS
# ships; building the argument list as a string-free list avoids the special
# case entirely.
tunables=""
for name in MALLOC_ARENA_MAX MALLOC_TRIM_THRESHOLD_ MALLOC_MMAP_THRESHOLD_ SERVER_ARGS BENCH; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then tunables="$tunables -e $name=$value"; fi
done

if [ -n "${CORPUS_DIR:-}" ]; then
  # shellcheck disable=SC2086  # $tunables is a flag list, and must split.
  exec docker run --rm --platform "$platform" $tunables \
    -e CORPUS=/corpus -v "$CORPUS_DIR:/corpus:ro" "$tag" "${@:---slope 24}"
fi
# shellcheck disable=SC2086
exec docker run --rm --platform "$platform" $tunables "$tag" "${@:---slope 24}"
