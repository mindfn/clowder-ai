#!/usr/bin/env bash
# F-8 parity driver for the ISOLATED stack: enables the template ragdoll (claude) + moonshot (kimi) breeds in the gate catalog,
# restarts the API with --only-cat claude (kimi CLI shimmed), runs one real native invocation (@sonnet) and one
# pipeline invocation (@kimi), then prints each trace summary's session-init IDs and delivery channels.
# Prereq: node /tmp/f257-iso/f8-breeds.py equivalent (breeds + roster entries with evaluation) — see f8-breeds.py alongside.
set -uo pipefail
G=/Users/lang/workspace/github-lab/clowder-ai-f257-gate
S=/Users/lang/workspace/github-lab/clowder-ai-f257-falsifiers/scripts/f257-falsifiers/iso-stack.sh
CAT=$G/.cat-cafe/cat-catalog.json
API=http://127.0.0.1:3122
H='X-Cat-Cafe-User: default-user'
kill "$(cat /tmp/f257-iso/api.pid 2>/dev/null)" 2>/dev/null; sleep 1; /bin/rm -f /tmp/f257-iso/api.pid
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_PID -u CLAUDE_EFFORT -u CLAUDE_CODE_EXECPATH "$S" api-start --worktree "$G" --only-cat claude || exit 1
echo "boot errors: $(grep -E '"level":(50|60)' /tmp/f257-iso/api.log | grep -v TELEMETRY_HMAC | wc -l | tr -d ' ')"
CJ=/tmp/f257-iso/cj2; curl -s -c $CJ -b $CJ -H "$H" $API/api/session >/dev/null
echo "--- cats now ---"
curl -s -b $CJ -H "$H" $API/api/cats | python3 -c 'import json,sys; d=json.load(sys.stdin); cats=d.get("cats",d) if isinstance(d,dict) else d; [print(c.get("id"), c.get("clientId"), (c.get("cli") or {}).get("command"), c.get("defaultModel"), c.get("mentionPatterns")) for c in cats]'
drive() { # $1 label $2 mention
  local tid resp turn
  resp=$(curl -s -b $CJ -H "$H" -H 'Content-Type: application/json' -X POST $API/api/threads -d "{\"title\":\"f257-s5-f8-$1\"}")
  tid=$(echo "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or d.get("thread",{}).get("id") or d.get("threadId") or "")')
  echo "[$1] thread=$tid"
  [ -z "$tid" ] && { echo "$resp" | head -c 300; return 1; }
  resp=$(curl -s -b $CJ -H "$H" -H 'Content-Type: application/json' -X POST $API/api/messages -d "{\"threadId\":\"$tid\",\"content\":\"$2 请只回复一个字：好\"}")
  echo "[$1] post → $(echo "$resp" | head -c 200)"
  for i in $(seq 1 60); do
    turn=$(redis-cli -p 6378 ZRANGE "cat-cafe:injection-trace-index:$tid" 0 -1 | tail -1)
    [ -n "$turn" ] && break; sleep 4
  done
  echo "[$1] trace turn=${turn:-NONE} after ~$((i*4))s"
  [ -n "$turn" ] && redis-cli -p 6378 GET "cat-cafe:injection-trace-summary:$tid:$turn" | python3 -c 'import json,sys; s=json.load(sys.stdin); seg=[x["segmentId"] for x in s["segments"] if x["stage"]=="session-init"]; print("  cat", s["catId"], "session-init ids", len(seg), sorted(seg)); print("  delivery", [(d["stage"], d["channel"]) for d in s["delivery"]])'
  echo "$tid" > /tmp/f257-iso/f8-thread-$1
}
drive native "@sonnet"
drive pipeline "@kimi"
echo "--- messages in native thread (reply check) ---"
tid=$(cat /tmp/f257-iso/f8-thread-native); for path in "/api/threads/$tid/messages" "/api/messages?threadId=$tid"; do code=$(curl -s -o /tmp/f257-iso/msgs.json -w '%{http_code}' -b $CJ -H "$H" "$API$path"); echo "$path → $code"; [ "$code" = "200" ] && { python3 -c 'import json; d=json.load(open("/tmp/f257-iso/msgs.json")); ms=d.get("messages",d) if isinstance(d,dict) else d; [print(" ", m.get("catId") or m.get("speaker") or m.get("role"), "|", (m.get("content") or "")[:80].replace("\n"," ")) for m in ms[-4:]]'; break; }; done
echo "--- api.log L0/session-prompt errors ---"; grep -E '"level":(50|60)' /tmp/f257-iso/api.log | grep -v TELEMETRY_HMAC | grep -i -E 'L0|session prompt|native' | cut -c1-240 | head -5
