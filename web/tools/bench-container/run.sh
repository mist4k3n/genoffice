#!/bin/sh
# Serve a scratch copy of the corpus with one engine process, then measure.
#
# One process because attribution has to be unambiguous: the benchmark reads
# RSS by process name, and a pool of four would report a sum that no single
# workbook is responsible for.
#
# A scratch copy because the benchmark's --slope mode writes N copies of a
# workbook into the corpus directory, and the corpus is the image's.
set -e
# A mounted corpus wins, so a workbook too large to ship in the repo can be
# generated on the host (tools/make-fixture.mjs) and measured here.
cp -r "${CORPUS:-/app/web/fixtures}" /tmp/corpus
cd /app/web

# The per-tenant session quota defaults to 16, and a slope of 24 needs to hold
# 24 open at once. Raising it is the point of the measurement, not a workaround:
# the question is what N resident workbooks cost, and the quota is the thing the
# answer is supposed to inform.
/app/node_modules/.bin/tsx server/dev-server.ts \
  --dir /tmp/corpus --pool 1 --max-sessions "${MAX_SESSIONS:-64}" >/tmp/serve.log 2>&1 &

node -e '
const wait = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch("http://127.0.0.1:5274/health")).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("the server never became healthy")
}
wait().catch((error) => { console.error(String(error)); process.exit(1) })
'

echo "  uname   $(uname -srm)"
echo "  node    $(node -v)"
echo "  memory  $(awk "/MemTotal/ {printf \"%.1f GB\", \$2/1048576}" /proc/meminfo)"
echo

node tools/bench-memory.mjs "$@"
