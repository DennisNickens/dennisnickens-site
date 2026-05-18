#!/bin/bash
# check-vercel-logs.sh
# Fetches recent runtime logs for /api/generate-blueprint from Vercel's
# dashboard logs API (vercel.com/api/logs/request-logs). The legacy
# /v3/deployments/<id>/runtime-logs endpoint returns 404 in 2026.
#
# Defaults to the last hour and prints the most recent invocation in full.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  set +a
else
  echo "ERROR: .env file not found at $SCRIPT_DIR/.env"
  exit 1
fi

if [ -z "$VERCEL_API_TOKEN" ] || [ -z "$VERCEL_PROJECT_ID" ]; then
  echo "ERROR: VERCEL_API_TOKEN and VERCEL_PROJECT_ID must be set in .env"
  exit 1
fi

ROUTE="${1:-/api/generate-blueprint}"
WINDOW_MIN="${2:-60}"

NOW_MS=$(( $(date +%s) * 1000 ))
START_MS=$(( NOW_MS - WINDOW_MIN * 60 * 1000 ))

# Resolve team/owner id from the project (needed by the dashboard endpoint).
PROJECT_JSON=$(curl -fsS -H "Authorization: Bearer $VERCEL_API_TOKEN" \
  "https://api.vercel.com/v9/projects/$VERCEL_PROJECT_ID")
TEAM_ID=$(printf '%s' "$PROJECT_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('accountId',''))")

if [ -z "$TEAM_ID" ]; then
  echo "ERROR: could not resolve team/owner id from project metadata"
  exit 1
fi

URL="https://vercel.com/api/logs/request-logs?endDate=$NOW_MS&ownerId=$TEAM_ID&page=0&projectId=$VERCEL_PROJECT_ID&startDate=$START_MS&teamId=$TEAM_ID"

RESP=$(curl -fsS -H "Authorization: Bearer $VERCEL_API_TOKEN" "$URL")

python3 - "$RESP" "$ROUTE" <<'PY'
import json, sys
resp = json.loads(sys.argv[1])
route = sys.argv[2]
rows = [r for r in resp.get('rows', []) if (r.get('requestPath') or '') == route]
if not rows:
    print(f"No log rows for {route} in window.")
    sys.exit(0)
rows.sort(key=lambda r: r.get('timestamp',''), reverse=True)
latest = rows[0]
print(f"=== Most recent invocation: {latest.get('requestId')} ===")
print(f"timestamp:     {latest.get('timestamp')}")
print(f"method:        {latest.get('requestMethod')}")
print(f"statusCode:    {latest.get('statusCode')}")
print(f"durationMs:    {latest.get('requestDurationMs')}")
print(f"crashed:       {latest.get('hasFunctionCrashed')}")
fevs = latest.get('functionEvents') or []
if fevs:
    fe = fevs[0]
    print(f"runtime:       {fe.get('functionRuntime')}  region:{fe.get('region')}  maxDuration:{fe.get('functionMaxDuration')}")
print()
print('--- log messages ---')
for log in latest.get('logs', []):
    print(f"[{log.get('timestamp')}] {log.get('level','info').upper()}: {log.get('message')}")
print()
if len(rows) > 1:
    print(f"(other invocations in window: {len(rows)-1} — pass a larger window in minutes as arg 2 to see them)")
PY
