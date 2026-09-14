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
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
platform="${PLATFORM:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"
tag="sheets-bench:${platform##*/}"

docker buildx build --platform "$platform" -f "$here/Dockerfile" -t "$tag" --load "$repo"

# `set -u` and an empty array do not get along on bash 3, which is what macOS
# ships; building the argument list as a string-free list avoids the special
# case entirely.
if [ -n "${CORPUS_DIR:-}" ]; then
  exec docker run --rm --platform "$platform" \
    -e CORPUS=/corpus -v "$CORPUS_DIR:/corpus:ro" "$tag" "${@:---slope 24}"
fi
exec docker run --rm --platform "$platform" "$tag" "${@:---slope 24}"
