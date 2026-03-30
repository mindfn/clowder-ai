#!/usr/bin/env bash
# Temporary: delete all cats + quest/bootcamp threads on dev restart so first-run wizard always shows.
# Remove this script after final E2E verification.
set -euo pipefail

API="http://localhost:3204"
MAX_WAIT=60

echo "[dev-reset] Waiting for API on $API..."
for i in $(seq 1 $MAX_WAIT); do
  if curl -sf "$API/api/cats" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Delete all cats
CATS=$(curl -sf "$API/api/cats" | python3 -c "import sys,json; [print(c['id']) for c in json.load(sys.stdin).get('cats',[])]" 2>/dev/null || true)
if [ -n "$CATS" ]; then
  for id in $CATS; do
    curl -sf -X DELETE -H 'x-cat-cafe-user: default-user' "$API/api/cats/$id" >/dev/null
    echo "[dev-reset] Deleted cat: $id"
  done
fi

# Delete quest threads AND bootcamp threads
THREADS=$(curl -sf -H 'x-cat-cafe-user: default-user' "$API/api/threads" 2>/dev/null | \
  python3 -c "import sys,json; [print(t['id']) for t in json.load(sys.stdin).get('threads',[]) if t.get('firstRunQuestState') or t.get('bootcampState')]" 2>/dev/null || true)
if [ -n "$THREADS" ]; then
  for tid in $THREADS; do
    curl -sf -X DELETE -H 'x-cat-cafe-user: default-user' "$API/api/threads/$tid" >/dev/null 2>&1 || true
    echo "[dev-reset] Deleted thread: $tid"
  done
fi

echo "[dev-reset] Done. Clear browser localStorage and refresh:"
echo "  localStorage.removeItem('cat-cafe:first-run-quest:skip-v1')"
