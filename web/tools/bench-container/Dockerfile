# syntax=docker/dockerfile:1

# Resident memory, measured under Linux.
#
# The number in FINDINGS-PAPAN.md was taken on macOS, and macOS is the wrong
# place to measure RSS: it reports a compressed-memory working set and uses a
# different allocator, while the machine this has to run on is a Linux VPS.
# This reproduces the same benchmark -- same corpus workbook, same
# `--slope` -- on Linux, so the comparison with Collabora's ~145 MB settled is
# made on one axis.
#
# Build context is the repo root; see Dockerfile.dockerignore beside this file.

FROM rust:1-trixie AS engine
WORKDIR /engine
# The crate is edition 2024, so this needs Rust 1.85 or newer.
COPY apps/sheets/native/xlsx-engine/Cargo.toml apps/sheets/native/xlsx-engine/Cargo.lock ./
COPY apps/sheets/native/xlsx-engine/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/engine/target,sharing=locked \
    cargo build --release && cp target/release/xlsx-sidecar /usr/local/bin/xlsx-sidecar

FROM node:22-trixie-slim AS bench
# `ps` is how the benchmark reads RSS, and slim images do not ship it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Only the runtime graph, not the workspace. The server reaches into
# apps/sheets for the gateway and the shared schemas; everything else those
# files import is a type, which tsx erases.
RUN npm install --no-save --no-package-lock --no-audit --no-fund \
      hono @hono/node-server @hono/node-ws ws zod jszip tsx

COPY web ./web
COPY apps/sheets/src ./apps/sheets/src
COPY packages ./packages
COPY --from=engine /usr/local/bin/xlsx-sidecar /usr/local/bin/xlsx-sidecar

ENV XLSX_SIDECAR_PATH=/usr/local/bin/xlsx-sidecar
COPY web/tools/bench-container/run.sh /usr/local/bin/run-bench
RUN chmod +x /usr/local/bin/run-bench
ENTRYPOINT ["/usr/local/bin/run-bench"]
