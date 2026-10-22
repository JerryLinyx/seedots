#!/usr/bin/env bash
# Start the foundation (8001), the learning backend (8000), the rig service (8002) and the web app (3000).
# Usage: scripts/dev.sh            (Ctrl+C stops everything)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — add SEEDOTS_LLM_API_KEY (or set SEEDOTS_LLM_FAKE=1)."
fi

PY="$ROOT/services/.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "Python env missing. Run:  cd services && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'"
  exit 1
fi
if [ ! -d apps/web/node_modules ]; then
  echo "Web deps missing. Run:  cd apps/web && npm install"
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "The rig service needs Node 22.18 or later (it runs TypeScript directly)."
  exit 1
fi

trap 'kill 0' EXIT
(cd services/rigs && node server.ts) &
(cd services && "$PY" -m uvicorn --factory seedots.media.api:create_app --port 8001 --log-level info) &
(cd services && "$PY" -m uvicorn --factory seedots.learning.api:create_app --port 8000 --log-level info) &
(cd apps/web && npm run dev) &
wait
