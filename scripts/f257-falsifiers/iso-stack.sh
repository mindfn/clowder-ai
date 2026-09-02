#!/usr/bin/env bash
# F257 isolated gate stack (complete-design-v1 §14): disposable Redis seeded from a dump COPY,
# S0 cleanup against that Redis only, API started from a branch build on private ports.
# Never touches the runtime instance (6099 / 3002 / 3001 / 4099) or the production sanctum (6399).
set -euo pipefail

ACTION="${1:-help}"
if [[ $# -gt 0 ]]; then shift; fi
ISO_ROOT="${F257_ISO_ROOT:-/tmp/f257-iso}"
REDIS_PORT="${F257_ISO_REDIS_PORT:-6378}"
API_PORT="${F257_ISO_API_PORT:-3122}"
WEB_PORT="${F257_ISO_WEB_PORT:-5122}"
OWNER_USER_ID="${F257_ISO_OWNER_USER_ID:-default-user}"
FORBIDDEN_PORTS="6099 6399 3002 3001 4099"

usage() {
  cat <<'USAGE'
Usage:
  iso-stack.sh redis-start --seed <dump.rdb>   disposable Redis (default port 6378) from an RDB copy; no AOF, no save
  iso-stack.sh s0 --worktree <dir> [--apply]   S0 cleanup script from <dir> against the disposable Redis (dry-run unless --apply)
  iso-stack.sh api-start --worktree <dir> [--no-cats | --only-cat <cli>]
                                               --no-cats: shim every provider CLI (exit 127) + isolate HOME → no real LLM call possible
                                               --only-cat codex: shim every provider CLI except codex (real HOME) → exactly one cat family can run
  iso-stack.sh status | stop | help
Env: F257_ISO_ROOT=/tmp/f257-iso  F257_ISO_REDIS_PORT=6378  F257_ISO_API_PORT=3122  F257_ISO_WEB_PORT=5122  F257_ISO_OWNER_USER_ID=default-user
USAGE
}

refuse_forbidden_port() {
  for port in $FORBIDDEN_PORTS; do
    if [[ "$1" == "$port" ]]; then
      echo "iso-stack: refusing runtime/sanctum port $1" >&2
      exit 2
    fi
  done
}

read_flag_value() {
  local flag="$1"
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$flag" ]]; then
      echo "${2:-}"
      return 0
    fi
    shift
  done
  return 1
}

redis_start() {
  local seed
  seed="$(read_flag_value --seed "$@")" || { echo "iso-stack: --seed <dump.rdb> required" >&2; exit 2; }
  refuse_forbidden_port "$REDIS_PORT"
  [[ -f "$seed" ]] || { echo "iso-stack: seed not found: $seed" >&2; exit 2; }
  if redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    echo "iso-stack: port $REDIS_PORT already serving Redis; stop it first" >&2
    exit 2
  fi
  mkdir -p "$ISO_ROOT/redis"
  rm -f "$ISO_ROOT/redis/dump.rdb"
  cp "$seed" "$ISO_ROOT/redis/dump.rdb"
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$ISO_ROOT/redis" --dbfilename dump.rdb \
    --appendonly no --save "" --daemonize yes --pidfile "$ISO_ROOT/redis.pid" --logfile "$ISO_ROOT/redis.log"
  for _ in $(seq 1 600); do
    if [[ "$(redis-cli -p "$REDIS_PORT" ping 2>/dev/null || true)" == "PONG" ]]; then break; fi
    sleep 0.5
  done
  echo "iso-stack: redis :$REDIS_PORT dbsize=$(redis-cli -p "$REDIS_PORT" dbsize) seed=$seed"
}

s0_cleanup() {
  local worktree apply=false
  worktree="$(read_flag_value --worktree "$@")" || { echo "iso-stack: --worktree <dir> required" >&2; exit 2; }
  for arg in "$@"; do [[ "$arg" == "--apply" ]] && apply=true; done
  refuse_forbidden_port "$REDIS_PORT"
  local script="$worktree/scripts/f257-s0-clean-derived-state.mjs"
  [[ -f "$script" ]] || { echo "iso-stack: S0 script missing in worktree: $script" >&2; exit 2; }
  local url="redis://127.0.0.1:$REDIS_PORT"
  mkdir -p "$ISO_ROOT"
  (cd "$worktree" && node "$script" --owner-user-id "$OWNER_USER_ID" --redis-url "$url") > "$ISO_ROOT/s0-dry-run.json"
  local digest
  digest="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(p.planDigest)' "$ISO_ROOT/s0-dry-run.json")"
  echo "iso-stack: S0 dry-run digest=$digest → $ISO_ROOT/s0-dry-run.json"
  if [[ "$apply" == true ]]; then
    (cd "$worktree" && node "$script" --owner-user-id "$OWNER_USER_ID" --redis-url "$url" --apply --confirm-plan "$digest") | tee "$ISO_ROOT/s0-apply.json"
  fi
}

api_start() {
  local worktree no_cats=false path_prefix="" home_dir="$HOME"
  worktree="$(read_flag_value --worktree "$@")" || { echo "iso-stack: --worktree <dir> required" >&2; exit 2; }
  local only_cat=""
  for arg in "$@"; do [[ "$arg" == "--no-cats" ]] && no_cats=true; done
  only_cat="$(read_flag_value --only-cat "$@")" || true
  refuse_forbidden_port "$API_PORT"
  refuse_forbidden_port "$REDIS_PORT"
  [[ -f "$worktree/packages/api/dist/index.js" ]] || { echo "iso-stack: build api first ($worktree/packages/api/dist/index.js)" >&2; exit 2; }
  mkdir -p "$ISO_ROOT/data" "$ISO_ROOT/home"
  if [[ "$no_cats" == true || -n "$only_cat" ]]; then
    # --no-cats: shim every provider CLI to exit 127 and hide real credentials (HOME).
    # --only-cat <cli>: shim every provider CLI except <cli> (real HOME so that one cat can run).
    rm -rf "$ISO_ROOT/nobin"; mkdir -p "$ISO_ROOT/nobin"
    for cli in claude codex opencode kimi kimi-cli gemini agy antigravity qwen; do
      [[ -n "$only_cat" && "$cli" == "$only_cat" ]] && continue
      printf '#!/usr/bin/env bash\necho "iso-stack: %s blocked" >&2\nexit 127\n' "$cli" > "$ISO_ROOT/nobin/$cli"
      chmod +x "$ISO_ROOT/nobin/$cli"
    done
    path_prefix="$ISO_ROOT/nobin:"
    [[ "$no_cats" == true ]] && home_dir="$ISO_ROOT/home"
  fi
  (
    cd "$worktree/packages/api"
    # Never inherit the launching cat's invocation identity or the runtime API address into the isolated API.
    env -u CAT_CAFE_INVOCATION_ID -u CAT_CAFE_CALLBACK_TOKEN -u CAT_CAFE_EXECUTION_ID -u CAT_CAFE_THREAD_ID -u CAT_CAFE_CAT_ID \
        -u CAT_CAFE_USER_ID -u CAT_CAFE_RUNTIME_MODE -u CAT_CAFE_MCP_SERVER_PATH -u NEXT_PUBLIC_API_URL \
    PATH="${path_prefix}$PATH" HOME="$home_dir" CAT_CAFE_API_URL="http://127.0.0.1:$API_PORT" \
    REDIS_URL="redis://127.0.0.1:$REDIS_PORT" REDIS_PORT="$REDIS_PORT" API_SERVER_PORT="$API_PORT" API_SERVER_HOST=127.0.0.1 \
    FRONTEND_PORT="$WEB_PORT" PREVIEW_GATEWAY_PORT=0 NODE_ENV=production CAT_CAFE_DATA_DIR="$ISO_ROOT/data" \
    CAT_CAFE_MCP_SERVER_PATH="$worktree/packages/mcp-server/dist/index.js" CAT_CAFE_DEPLOYMENT_ID=f257-iso \
    ANTHROPIC_PROXY_ENABLED=0 ASR_ENABLED=0 TTS_ENABLED=0 LLM_POSTPROCESS_ENABLED=0 EMBED_ENABLED=0 EMBED_MODE=off AUDIO_SERVICE_ENABLED=0 \
    nohup node dist/index.js > "$ISO_ROOT/api.log" 2>&1 &
    echo $! > "$ISO_ROOT/api.pid"
  )
  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:$API_PORT/api/session" >/dev/null 2>&1; then
      echo "iso-stack: api :$API_PORT up (pid $(cat "$ISO_ROOT/api.pid"), log $ISO_ROOT/api.log)"
      return 0
    fi
    sleep 1
  done
  echo "iso-stack: api did not answer on :$API_PORT within 120s; see $ISO_ROOT/api.log" >&2
  exit 1
}

stack_status() {
  echo "redis :$REDIS_PORT → $(redis-cli -p "$REDIS_PORT" ping 2>/dev/null || echo down)"
  if [[ -f "$ISO_ROOT/api.pid" ]] && kill -0 "$(cat "$ISO_ROOT/api.pid")" 2>/dev/null; then
    echo "api :$API_PORT → pid $(cat "$ISO_ROOT/api.pid") session=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/api/session")"
  else
    echo "api :$API_PORT → down"
  fi
}

stack_stop() {
  if [[ -f "$ISO_ROOT/api.pid" ]]; then kill "$(cat "$ISO_ROOT/api.pid")" 2>/dev/null || true; rm -f "$ISO_ROOT/api.pid"; fi
  refuse_forbidden_port "$REDIS_PORT"
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  echo "iso-stack: stopped (api + redis :$REDIS_PORT)"
}

case "$ACTION" in
  redis-start) redis_start "$@" ;;
  s0) s0_cleanup "$@" ;;
  api-start) api_start "$@" ;;
  status) stack_status ;;
  stop) stack_stop ;;
  help|-h|--help) usage ;;
  *) echo "iso-stack: unknown action $ACTION" >&2; usage; exit 2 ;;
esac
