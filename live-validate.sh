#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# now-fluent push/pull — LIVE validation runbook (run this on your own machine)
# ---------------------------------------------------------------------------
# Phases 0-2 are fully automatic and read-only-ish (the Phase 0 spike creates
# throwaway sys_script_include records and deletes them again).
# Phase 3-4 write records, so they are gated behind CONFIRM_PUSH=1.
#
#   chmod +x live-validate.sh
#   ./live-validate.sh --auth dev                      # phases 0-2
#   ./live-validate.sh --auth dev --scope sn_hamp      # + scoped spike
#   CONFIRM_PUSH=1 ./live-validate.sh --auth dev --round-trip   # + phases 3-4
#
# Everything is teed into live-validate-<timestamp>.log — send me that file.
# ---------------------------------------------------------------------------

set -uo pipefail   # deliberately NOT -e: a failing assumption is a finding, not a crash

AUTH=""
SCOPE=""
ROUND_TRIP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --auth)       AUTH="$2"; shift 2 ;;
    --scope)      SCOPE="$2"; shift 2 ;;
    --round-trip) ROUND_TRIP=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done
[ -n "$AUTH" ] || { echo "Usage: $0 --auth <alias> [--scope <scope>] [--round-trip]"; exit 2; }

REPO="$(cd "$(dirname "$0")" && pwd)"
LOG="$REPO/live-validate-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

NF="node $REPO/bin/now-fluent.mjs"     # no npm link needed
hr() { printf '\n%s\n== %s\n%s\n' "$(printf '=%.0s' {1..72})" "$1" "$(printf '=%.0s' {1..72})"; }
note() { printf '\n--> %s\n' "$1"; }

hr "PHASE 0 — preflight"
node --version
now-sdk --version 2>&1 | tail -1     # push/pull need the SDK's `query` => 4.10+
( cd "$REPO" && npm test 2>&1 | tail -8 )
note "doctor — must say push/pull credentials are ready for alias '$AUTH'"
$NF doctor

hr "PHASE 1 — Phase 0 spike, Global scope"
note "PUT merge / POST honours sys_id / writes permitted / update-set capture"
( cd "$REPO" && npm run verify-push -- --auth "$AUTH" )
echo "verify-push (global) exit=$?"

if [ -n "$SCOPE" ]; then
  hr "PHASE 2 — Phase 0 spike, scope: $SCOPE"
  ( cd "$REPO" && npm run verify-push -- --auth "$AUTH" --scope "$SCOPE" )
  echo "verify-push (scope $SCOPE) exit=$?"
else
  hr "PHASE 2 — SKIPPED (no --scope given)"
  note "candidate scopes on the instance:"
  now-sdk query sys_scope --auth "$AUTH" -q "private=false^scope!=global" -f scope,name,sys_id --limit 15 2>&1 | head -40
  note "re-run with --scope <one of the above> to test the scoped-write assumption"
fi

if [ "$ROUND_TRIP" != "1" ]; then
  hr "DONE (phases 0-2). Re-run with --round-trip to exercise pull/push."
  echo "transcript: $LOG"
  exit 0
fi

if [ "${CONFIRM_PUSH:-}" != "1" ]; then
  hr "PHASE 3-4 need CONFIRM_PUSH=1 — these WRITE to $AUTH. Stopping."
  exit 0
fi

# ---------------------------------------------------------------------------
WORK="$REPO/../push-demo-live"
hr "PHASE 3 — real round trip (project: $WORK)"
if [ ! -d "$WORK" ]; then
  mkdir -p "$WORK" && cd "$WORK"
  now-sdk init --appName "Push Demo" --packageName push-demo \
    --scopeName x_push_demo --template base && npm install
fi
cd "$WORK"

note "creating a THROWAWAY sys_script_include to round-trip (safer than editing an OOB record)"
# Create the target through push's OWN transport (the spike already proved inserts work):
TARGET=$(node --input-type=module -e "
import { randomBytes } from 'node:crypto'
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
const id = randomBytes(16).toString('hex')
const inst = resolveInstance('$AUTH')
await snRequest(inst, 'POST', '/api/now/table/sys_script_include', {
  throwOnError: true,
  body: { sys_id: id, name: 'NowFluentRoundTrip' + id.slice(0, 6),
          script: 'var X = Class.create();\n// marker: ORIGINAL BODY',
          description: 'round-trip target — safe to delete', active: 'true' },
  params: { sysparm_fields: 'sys_id' }
})
console.log(id)
")
echo "target sys_id: $TARGET"

note "pull"
$NF pull --project . --auth "$AUTH" --sys-id "$TARGET"

note "baseline recorded at:"
ls -l .now-fluent/state/ 2>/dev/null

note "edit ONLY the description in the generated Fluent source"
GEN=$(grep -rl "$TARGET" src/ 2>/dev/null | head -1)
echo "generated file: $GEN"
[ -n "$GEN" ] && sed -i.bak "s/round-trip target — safe to delete/EDITED BY PUSH/" "$GEN" && grep -n "EDITED BY PUSH" "$GEN"

note "push --dry-run (safe, shows exactly what would be written)"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET" --dry-run

note "push FOR REAL"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET"

note "verify: ONLY description changed — script must still say 'marker: ORIGINAL BODY'"
now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$TARGET" -f name,description,script,sys_scope,sys_mod_count

# ---------------------------------------------------------------------------
hr "PHASE 4a — push a record that does NOT exist yet (expect POST, sys_id preserved)"
NEWID=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
echo "new sys_id: $NEWID"
note "add a new script include to the Fluent source with Now.ID['$NEWID'], then:"
echo "    $NF push --project . --auth $AUTH --sys-id $NEWID --dry-run"
echo "    $NF push --project . --auth $AUTH --sys-id $NEWID"
echo "    now-sdk query sys_script_include --auth $AUTH -q sys_id=$NEWID -f sys_id,name"
note "(left manual — it needs a hand-written Fluent source file)"

hr "PHASE 4b — --update-set (EXPERIMENTAL: repoints + restores sys_update_set preference)"
note "BEFORE: your current update set preference"
now-sdk query sys_user_preference --auth "$AUTH" -q "name=sys_update_set" -f user,value --limit 5
note "create an in-progress update set in the UI, then:"
echo "    $NF push --project . --auth $AUTH --sys-id $TARGET --update-set '<name>'"
note "AFTER the push, re-run the query above — the value MUST be back to what it was."

hr "DONE — transcript: $LOG"
echo "throwaway record left behind for inspection: sys_script_include $TARGET"
echo "delete it with: now-sdk query is read-only; remove it in the UI, or re-run verify-push style DELETE."
