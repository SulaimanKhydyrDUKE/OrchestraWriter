#!/usr/bin/env bash
# End-to-end smoke test against a running server: sign up, session, presigned upload,
# register, list, download (byte compare), delete, sign out, sign in. Exits non-zero on
# the first failure. Run it before pushing, and against production after a deploy.
#
#   scripts/smoke-test.sh                       # http://localhost:3000
#   scripts/smoke-test.sh https://at2rkgxrxh.us-east-1.awsapprunner.com
#
# Needs curl and node. Creates a throwaway user (smoke-<timestamp>@example.com) and
# removes everything it uploaded; the user row itself stays (delete via psql if you care).
# Written to run on macOS's stock bash 3.2 as well as bash 5.
set -euo pipefail
BASE=${1:-http://localhost:3000}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/cookies"
EMAIL="smoke-$(date +%s)@example.com"
PASS="Smoke-Test-Pass-1"
PASSED=0

say()  { printf '  %-34s' "$1"; }
ok()   { echo "ok   $*"; PASSED=$((PASSED+1)); }
fail() { echo "FAIL $*"; exit 1; }
# json <path>  reads JSON on stdin and prints the value at a dotted path (empty if missing)
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);const v=process.argv[1].split(".").reduce((a,k)=>a==null?undefined:a[k],o);process.stdout.write(v===undefined||v===null?"":String(v))})' "$1"; }
# req  <curl args>  -> response body        code <curl args> -> HTTP status only
req()  { curl -s --max-time 60 -b "$JAR" -c "$JAR" -H "Origin: $BASE" -H 'content-type: application/json' "$@"; }
code() { curl -s --max-time 60 -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -H "Origin: $BASE" -H 'content-type: application/json' "$@"; }

echo "Smoke test against $BASE"

say "page serves HTML"
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/"); [ "$C" = 200 ] && ok || fail "HTTP $C"
say "/health"
C=$(code "$BASE/health"); [ "$C" = 200 ] && ok || fail "HTTP $C"
say "/health/db"
C=$(code "$BASE/health/db"); [ "$C" = 200 ] && ok || fail "HTTP $C (database unreachable)"
say "/api/status ok"
V=$(req "$BASE/api/status" | json ok); [ "$V" = true ] && ok || fail "see $BASE/api/status"
say "files route rejects anonymous"
C=$(code "$BASE/api/files"); [ "$C" = 401 ] && ok || fail "HTTP $C"

say "sign up"
BODY=$(printf '{"name":"Smoke","email":"%s","password":"%s"}' "$EMAIL" "$PASS")
C=$(code -X POST "$BASE/api/auth/sign-up/email" -d "$BODY"); [ "$C" = 200 ] && ok "$EMAIL" || fail "HTTP $C"
say "session"
UID_=$(req "$BASE/api/auth/get-session" | json user.id); [ -n "$UID_" ] && ok "user #$UID_" || fail

head -c 3000 /dev/urandom > "$TMP/in.wav"
say "presign upload"
UP=$(req -X POST "$BASE/api/files/upload-url" -d '{"filename":"smoke test.wav","contentType":"audio/wav"}')
KEY=$(echo "$UP" | json key); URL=$(echo "$UP" | json uploadUrl)
[ -n "$KEY" ] && [ -n "$URL" ] && ok "$KEY" || fail "$UP"
say "PUT bytes to storage"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -X PUT -H 'content-type: audio/wav' --data-binary @"$TMP/in.wav" "$URL")
[ "$C" = 200 ] && ok || fail "HTTP $C (CORS or endpoint problem)"
say "register row"
BODY=$(printf '{"name":"smoke","key":"%s","audioLengthSeconds":75}' "$KEY")
FID=$(req -X POST "$BASE/api/files" -d "$BODY" | json file.id); [ -n "$FID" ] && ok "row #$FID" || fail
say "foreign key rejected"
C=$(code -X POST "$BASE/api/files" -d '{"name":"x","key":"users/0/evil","audioLengthSeconds":1}'); [ "$C" = 403 ] && ok || fail "HTTP $C"
say "list contains it"
req "$BASE/api/files" | grep -q "\"id\":$FID," && ok || fail
say "start transcription job"
JOB=$(req -X POST "$BASE/api/jobs" -d "{\"audioFileId\":$FID}" | json job.id); [ -n "$JOB" ] && ok "job #$JOB" || fail
say "job finishes (75 s audio, 3 chunks)"
STATUS=""
for _ in $(seq 1 90); do
  J=$(req "$BASE/api/jobs/$JOB"); STATUS=$(echo "$J" | json job.status)
  [ "$STATUS" = succeeded ] || [ "$STATUS" = failed ] && break
  sleep 2
done
[ "$STATUS" = succeeded ] && ok "$(echo "$J" | json job.chunkCount) chunks" || fail "status=$STATUS $(echo "$J" | json job.error)"
say "sheets produced"
SID=$(echo "$J" | json job.sheets.0.id); NS=$(echo "$J" | json job.sheets.length)
[ -n "$SID" ] && ok "$NS parts" || fail
say "sheet is MusicXML"
SURL=$(req "$BASE/api/sheets/$SID/download-url" | json url)
curl -s --max-time 60 "$SURL" | grep -q "<score-partwise" && ok || fail

say "download, bytes identical"
DL=$(req "$BASE/api/files/$FID/download-url" | json url)
curl -s --max-time 60 -o "$TMP/out.wav" "$DL"; cmp -s "$TMP/in.wav" "$TMP/out.wav" && ok || fail
say "delete"
C=$(code -X DELETE "$BASE/api/files/$FID"); [ "$C" = 204 ] && ok || fail "HTTP $C"
say "object gone"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$DL"); [ "$C" = 404 ] && ok || fail "HTTP $C"
say "sign out"
C=$(code -X POST "$BASE/api/auth/sign-out" -d '{}'); [ "$C" = 200 ] && ok || fail "HTTP $C"
say "session cleared"
V=$(req "$BASE/api/auth/get-session"); [ "$V" = null ] && ok || fail "$V"
say "wrong password rejected"
BODY=$(printf '{"email":"%s","password":"nope-nope-nope"}' "$EMAIL")
C=$(code -X POST "$BASE/api/auth/sign-in/email" -d "$BODY"); [ "$C" = 401 ] && ok || fail "HTTP $C"
say "sign in"
BODY=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASS")
C=$(code -X POST "$BASE/api/auth/sign-in/email" -d "$BODY"); [ "$C" = 200 ] && ok || fail "HTTP $C"

echo "All $PASSED checks passed."
