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
note "PUT merge / POST honours sys_id / sys_scope honoured? / can capture be steered?"
( cd "$REPO" && npm run verify-push -- --auth "$AUTH" )
echo "verify-push (global) exit=$?"

if [ -n "$SCOPE" ]; then
  hr "PHASE 2 — Phase 0 spike, scope: $SCOPE"
  note "EXPECTED on a stock instance: the 'sys_scope is HONOURED' check FAILS."
  note "That is the finding, not a bug in the spike — the Table API ignores sys_scope"
  note "and puts the record in Global. push now refuses scoped CREATEs because of it."
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
hr "PHASE 3 — cross-scope round trip: a GLOBAL record, edited in a SCOPED project (x_push_demo)"
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

# Delete the throwaway through push's own transport (now-sdk has no write command).
cleanup_target() {
  node --input-type=module -e "
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
await snRequest(resolveInstance('$AUTH'), 'DELETE', '/api/now/table/sys_script_include/$TARGET', { allow404: true, throwOnError: true })
console.log('deleted throwaway sys_script_include $TARGET')
" || echo "could not delete $TARGET — remove it in the UI"
}

note "pull — EXPECTED: 'pull ADOPTS them', and the record imports (no TS11)"
if ! $NF pull --project . --auth "$AUTH" --sys-id "$TARGET"; then
  # Everything below depends on the pull. Cascading into three more errors would hide
  # which one is real.
  echo "PHASE 3 STOPPED: pull failed, so there is nothing to push. See the error above."
  cleanup_target
  exit 1
fi

note "adoption — EXPECTED: .now-fluent/adopted.json has an entry for it, from global to x_push_demo"
node -e "const a = require('./.now-fluent/adopted.json'); console.log(JSON.stringify(a['$TARGET'] || 'NOT RECORDED', null, 2))" 2>/dev/null \
  || echo "NOT RECORDED: .now-fluent/adopted.json missing"
note "baseline — EXPECTED: the LIVE record, still global / global.NowFluentRoundTrip..."
node -e "const fs=require('fs'); const f=fs.readdirSync('.now-fluent/state').find(n=>n.includes('$TARGET')); const b=JSON.parse(fs.readFileSync('.now-fluent/state/'+f,'utf8')); console.log(JSON.stringify({ sys_scope: b.fields.sys_scope, api_name: b.fields.api_name }))" 2>/dev/null

note "edit ONLY the description in the generated Fluent source"
GEN=$(grep -rl "$TARGET" src/ 2>/dev/null | head -1)
echo "generated file: $GEN"
note "EXPECTED: its apiName starts with 'x_push_demo.' — that is what makes it compile"
grep -n "apiName" "$GEN" 2>/dev/null
[ -n "$GEN" ] && sed -i.bak "s/round-trip target — safe to delete/EDITED BY PUSH/" "$GEN" && grep -n "EDITED BY PUSH" "$GEN"

note "push --dry-run (reads only) — EXPECTED: 'would PUT ... (1 field(s))', only description"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET" --dry-run

note "push FOR REAL — EXPECTED: 'adopted from global: pushing it back there', 'updated (1 field(s))'"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET"
echo "push exit=$?"

note "verify ON THE INSTANCE — EXPECTED: description='EDITED BY PUSH', script still 'marker: ORIGINAL BODY',"
note "sys_scope STILL 'global', api_name STILL 'global.NowFluentRoundTrip...' (NOT x_push_demo.)"
now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$TARGET" -f name,api_name,description,script,sys_scope,sys_mod_count

note "push again with no edit — EXPECTED: unchanged, nothing sent"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET"

# ---------------------------------------------------------------------------
hr "PHASE 3b — update-set-package and an ADOPTED record (local only, writes nothing)"
note "packaging it for the PROJECT scope — EXPECTED: REFUSED ('would MOVE them into x_push_demo')"
$NF update-set-package --project . --update-set-name "nf adopted check" --include "$TARGET"
echo "exit=$? (non-zero expected)"
note "packaging it for its ORIGIN — EXPECTED: 'IN-PLACE edits in their origin scope'"
$NF update-set-package --project . --update-set-name "nf adopted check" --include "$TARGET" \
  --scope global --scope-id global
note "EXPECTED: the payload says global.NowFluentRoundTrip..., never x_push_demo."
grep -o "global\.NowFluentRoundTrip[0-9a-f]*\|x_push_demo\.NowFluentRoundTrip[0-9a-f]*" \
  exports/nf-adopted-check/update-set-*.xml 2>/dev/null | sort | uniq -c

# ---------------------------------------------------------------------------
hr "PHASE 4b — --update-set on a real push (repoints the preference, then VERIFIES capture)"
# Runs BEFORE cleanup: it needs the round-trip record to still exist.
US_NAME="now-fluent 4b $(node -e "console.log(require('crypto').randomBytes(3).toString('hex'))")"
US_ID=$(node --input-type=module -e "
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
const r = await snRequest(resolveInstance('$AUTH'), 'POST', '/api/now/table/sys_update_set', {
  throwOnError: true, body: { name: '$US_NAME', description: 'now-fluent live-validate 4b — safe to delete' },
  params: { sysparm_fields: 'sys_id' } })
console.log(r.sys_id)")
echo "created update set: $US_NAME ($US_ID)"

pref_value() {
  node --input-type=module -e "
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
const inst = resolveInstance('$AUTH')
const me = await snRequest(inst, 'GET', '/api/now/ui/user/current_user', { throwOnError: true })
const rows = await snRequest(inst, 'GET', '/api/now/table/sys_user_preference', { throwOnError: true,
  params: { sysparm_query: 'name=sys_update_set^user=' + (me.user_sys_id || me.sys_id), sysparm_fields: 'value', sysparm_limit: '1' } })
console.log(rows.length ? rows[0].value : '(none)')"
}
BEFORE=$(pref_value)
echo "your update set preference BEFORE: $BEFORE"

[ -n "$GEN" ] && sed -i.bak "s/EDITED BY PUSH/EDITED AGAIN FOR 4b/" "$GEN"
note "push --update-set — EXPECTED: 'did NOT land in \"$US_NAME\"', names where it went, exit non-zero"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET" --update-set "$US_ID"
echo "push exit=$? (non-zero expected: capture cannot be steered on this instance)"

AFTER=$(pref_value)
echo "your update set preference AFTER:  $AFTER"
if [ "$BEFORE" = "$AFTER" ]; then echo "OK: preference restored"; else echo "PROBLEM: preference NOT restored ($BEFORE -> $AFTER)"; fi

node --input-type=module -e "
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
await snRequest(resolveInstance('$AUTH'), 'DELETE', '/api/now/table/sys_update_set/$US_ID', { allow404: true, throwOnError: true })
console.log('deleted update set $US_ID')" || echo "could not delete update set $US_ID — remove it in the UI"

cleanup_target

# ---------------------------------------------------------------------------
hr "PHASE 4a — push a record that does NOT exist yet (expect POST, sys_id preserved)"
NEWID=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
echo "new sys_id: $NEWID"
note "add a new script include to the Fluent source with Now.ID['$NEWID'], then:"
echo "    $NF push --project . --auth $AUTH --sys-id $NEWID --dry-run"
echo "    $NF push --project . --auth $AUTH --sys-id $NEWID"
echo "    now-sdk query sys_script_include --auth $AUTH -q sys_id=$NEWID -f sys_id,name"
note "(left manual — it needs a hand-written Fluent source file)"

hr "PHASE 4c — --target-scope (scoped project -> Global)"
note "From a SCOPED project, a create is refused unless you name the outcome:"
echo "    $NF push --project . --auth $AUTH --sys-id <new sys_id>"
note "  EXPECTED: REFUSED, naming --target-scope global"
echo "    $NF push --project . --auth $AUTH --sys-id <new sys_id> --target-scope global"
note "  EXPECTED: created, with a line saying it landed in GLOBAL and what api_name it got"
echo "    $NF push --project . --auth $AUTH --sys-id <new sys_id> --target-scope x_other"
note "  EXPECTED: refused before any request, pointing at update-set-package"
note "This is for records AUTHORED in the scoped project. A record PULLED from Global"
note "needs none of this: pull adopts it and push returns it to Global (phase 3)."

hr "DONE — transcript: $LOG"
