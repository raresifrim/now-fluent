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
#   CONFIRM_PUSH=1 ./live-validate.sh --auth dev --round-trip --project-scope sn_sow
#       binds the demo project to a scope that ALREADY EXISTS on the instance — a
#       ServiceNow or Store app such as sn_sow / sn_hamp, the way a vendor-scope project
#       is set up (now.config.json scope + scopeId) — so phase 4c really creates records
#       in it. Without it the project is a local-only x_push_demo and 4c can only show
#       push refusing (that app does not exist on the instance). --app is an alias.
#
# Everything is teed into live-validate-<timestamp>.log — send me that file.
# ---------------------------------------------------------------------------

set -uo pipefail   # deliberately NOT -e: a failing assumption is a finding, not a crash

AUTH=""
SCOPE=""
APP=""
ROUND_TRIP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --auth)       AUTH="$2"; shift 2 ;;
    --scope)      SCOPE="$2"; shift 2 ;;
    --project-scope|--app) APP="$2"; shift 2 ;;
    --round-trip) ROUND_TRIP=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done
[ -n "$AUTH" ] || { echo "Usage: $0 --auth <alias> [--scope <scope>] [--project-scope <existing scope>] [--round-trip]"; exit 2; }
# The demo project's scope: an existing scope on the instance (--project-scope), or a local-only x_push_demo.
PSCOPE="${APP:-x_push_demo}"
# With --project-scope and no --scope, the phase 2 spike tests the scope push will actually write into.
[ -z "$SCOPE" ] && [ -n "$APP" ] && SCOPE="$APP"

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
$NF verify-push --auth "$AUTH"
echo "verify-push (global) exit=$?"

if [ -n "$SCOPE" ]; then
  hr "PHASE 2 — Phase 0 spike, scope: $SCOPE"
  note "EXPECTED (seen live, dev410927 / sn_sow): body sys_scope NO (or ?? when $SCOPE is your app picker),"
  note "create AS $SCOPE YES, UPDATED run AS Global NO (403), UPDATED run AS $SCOPE YES, deleted again YES."
  $NF verify-push --auth "$AUTH" --scope "$SCOPE"
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
if [ -n "$APP" ]; then WORK="$REPO/../push-demo-$APP"; else WORK="$REPO/../push-demo-live"; fi
hr "PHASE 3 — cross-scope round trip: a GLOBAL record, edited in a SCOPED project ($PSCOPE)"
if [ ! -d "$WORK" ]; then
  mkdir -p "$WORK" && cd "$WORK"
  # init with a placeholder x_ scope (init expects one), then bind to the real scope below.
  now-sdk init --appName "Push Demo" --packageName push-demo \
    --scopeName x_push_demo --template base && npm install
fi
cd "$WORK"

if [ -n "$APP" ]; then
  note "binding the project to the EXISTING scope $APP (now.config.json scope + scopeId from the instance)"
  APP_ID=$(node --input-type=module -e "
import { resolveInstance, snRequest, RAW_READ_PARAMS } from '$REPO/bin/now-fluent.mjs'
const rows = await snRequest(resolveInstance('$AUTH'), 'GET', '/api/now/table/sys_scope', { throwOnError: true,
  params: { ...RAW_READ_PARAMS, sysparm_query: 'scope=$APP', sysparm_fields: 'sys_id', sysparm_limit: '1' } })
console.log(rows && rows.length ? rows[0].sys_id : '')")
  if [ -z "$APP_ID" ]; then
    echo "no scope '$APP' exists on the instance (check sys_scope). Stopping."
    exit 1
  fi
  node -e "
const fs = require('fs'); const c = JSON.parse(fs.readFileSync('now.config.json', 'utf8'))
c.scope = '$APP'; c.scopeId = '$APP_ID'
fs.writeFileSync('now.config.json', JSON.stringify(c, null, 4) + '\\n')"
  echo "now.config.json: scope $APP, scopeId $APP_ID"
fi

note "creating a THROWAWAY sys_script_include to round-trip (safer than editing an OOB record)"
# Create the target through push's OWN transport (the spike already proved inserts work):
TARGET=$(node --input-type=module -e "
import { randomBytes } from 'node:crypto'
import { resolveInstance, snRequest, snGetRecord } from '$REPO/bin/now-fluent.mjs'
const id = randomBytes(16).toString('hex')
const inst = resolveInstance('$AUTH')
// Named explicitly: a create that names no scope lands in the account's current application
// (seen live: with the app picker on sn_sow, this 'Global' target landed in sn_sow).
await snRequest(inst, 'POST', '/api/now/table/sys_script_include', {
  throwOnError: true,
  body: { sys_id: id, name: 'NowFluentRoundTrip' + id.slice(0, 6),
          script: 'var X = Class.create();\n// marker: ORIGINAL BODY',
          description: 'round-trip target — safe to delete', active: 'true' },
  params: { sysparm_fields: 'sys_id', sysparm_transaction_scope: 'global' }
})
const row = await snGetRecord(inst, 'sys_script_include', id, 'sys_scope', { throwOnError: true })
if (!row || row.sys_scope !== 'global') console.error('WARNING: the target landed in ' + (row ? row.sys_scope : '?') + ', not Global — phase 3 will not test adoption. Switch the app picker to Global.')
console.log(id)
")
echo "target sys_id: $TARGET"

# Delete the throwaway through push's own transport (now-sdk has no write command).
cleanup_target() {
  node --input-type=module -e "
import { resolveInstance, snDeleteRecord } from '$REPO/bin/now-fluent.mjs'
await snDeleteRecord(resolveInstance('$AUTH'), 'sys_script_include', '$TARGET', 'global')
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

note "adoption — EXPECTED: .now-fluent/adopted.json has an entry for it, from global to $PSCOPE"
node -e "const a = require('./.now-fluent/adopted.json'); console.log(JSON.stringify(a['$TARGET'] || 'NOT RECORDED', null, 2))" 2>/dev/null \
  || echo "NOT RECORDED: .now-fluent/adopted.json missing"
note "baseline — EXPECTED: the LIVE record, still global / global.NowFluentRoundTrip..."
node -e "const fs=require('fs'); const f=fs.readdirSync('.now-fluent/state').find(n=>n.includes('$TARGET')); const b=JSON.parse(fs.readFileSync('.now-fluent/state/'+f,'utf8')); console.log(JSON.stringify({ sys_scope: b.fields.sys_scope, api_name: b.fields.api_name }))" 2>/dev/null

note "edit ONLY the description in the generated Fluent source"
GEN=$(grep -rl "$TARGET" src/ 2>/dev/null | head -1)
echo "generated file: $GEN"
note "EXPECTED: its apiName starts with '$PSCOPE.' — that is what makes it compile"
grep -n "apiName" "$GEN" 2>/dev/null
[ -n "$GEN" ] && sed -i.bak "s/round-trip target — safe to delete/EDITED BY PUSH/" "$GEN" && grep -n "EDITED BY PUSH" "$GEN"

note "push --dry-run (reads only) — EXPECTED: 'would PUT ... (1 field(s))', only description"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET" --dry-run

note "push FOR REAL — EXPECTED: 'adopted from global: pushing it back there', 'updated (1 field(s))'"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET"
echo "push exit=$?"

note "verify ON THE INSTANCE — EXPECTED: description='EDITED BY PUSH', script still 'marker: ORIGINAL BODY',"
note "sys_scope STILL 'global', api_name STILL 'global.NowFluentRoundTrip...' (NOT $PSCOPE.)"
now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$TARGET" -f name,api_name,description,script,sys_scope,sys_mod_count

note "push again with no edit — EXPECTED: unchanged, nothing sent"
$NF push --project . --auth "$AUTH" --sys-id "$TARGET"

# ---------------------------------------------------------------------------
hr "PHASE 3b — update-set-package and an ADOPTED record (local only, writes nothing)"
note "packaging it for the PROJECT scope — EXPECTED: REFUSED ('would MOVE them into $PSCOPE')"
$NF update-set-package --project . --update-set-name "nf adopted check" --include "$TARGET"
echo "exit=$? (non-zero expected)"
note "packaging it for its ORIGIN — EXPECTED: 'IN-PLACE edits in their origin scope'"
$NF update-set-package --project . --update-set-name "nf adopted check" --include "$TARGET" \
  --scope global --scope-id global
note "EXPECTED: the payload says global.NowFluentRoundTrip..., never $PSCOPE."
grep -o "global\.NowFluentRoundTrip[0-9a-f]*\|$PSCOPE\.NowFluentRoundTrip[0-9a-f]*" \
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
# Author a throwaway (active:false) script include as Fluent source in the scoped project,
# build, and find the sys_id Now.ID gave it. Sets SRC, AUTHORED, NEWID (NEWID empty on failure).
author_record() {
  RAND=$(node -e "console.log(require('crypto').randomBytes(3).toString('hex'))")
  AUTHORED="NowFluent$1$RAND"
  SRC="src/fluent/nf-$1-$RAND.now.ts"
  cat > "$SRC" <<EOF
import { ScriptInclude } from '@servicenow/sdk/core'

ScriptInclude({
    \$id: Now.ID['nf-$1-$RAND'],
    name: '$AUTHORED',
    active: false,
    description: 'now-fluent live-validate — safe to delete',
    script: 'var $AUTHORED = Class.create();\n$AUTHORED.prototype = { type: "$AUTHORED" };',
})
EOF
  BUILD_OUT=$(now-sdk build 2>&1)
  local art
  art=$(grep -l "<name>$AUTHORED</name>" dist/app/update/*.xml 2>/dev/null | head -1)
  NEWID=$(basename "$art" .xml 2>/dev/null | sed 's/.*_\([0-9a-f]\{32\}\)$/\1/')
  if [ -z "$art" ] || [ -z "$NEWID" ]; then
    echo "could not author a record: the build produced no artifact for $AUTHORED. Build output:"
    echo "$BUILD_OUT" | tail -20
    rm -f "$SRC"; NEWID=""
  else
    echo "wrote $SRC — Now.ID gave it sys_id $NEWID (api_name in source: $PSCOPE.$AUTHORED)"
  fi
}

delete_record() {
  node --input-type=module -e "
import { resolveInstance, snGetRecord, snDeleteRecord } from '$REPO/bin/now-fluent.mjs'
// A record inside an app can refuse a delete run from Global (seen live), so delete it AS its app.
const inst = resolveInstance('$AUTH')
const row = await snGetRecord(inst, 'sys_script_include', '$1', 'sys_id,sys_scope', { throwOnError: true })
if (!row) { console.log('sys_script_include $1 is already gone'); process.exit(0) }
const how = await snDeleteRecord(inst, 'sys_script_include', '$1', row.sys_scope)
console.log('deleted sys_script_include $1 (' + (how === 'as-scope' ? 'run as its scope' : 'naming no scope') + ')')" \
    || echo "could not delete $1 — remove it in the UI"
}

# ---------------------------------------------------------------------------
hr "PHASE 4c — a NEW record in the project's OWN scope ($PSCOPE), no install"
PROJECT_SCOPE_ID=$(node -e "console.log(require('./now.config.json').scopeId || '')")
APP_EXISTS=$(node --input-type=module -e "
import { resolveInstance, snGetRecord } from '$REPO/bin/now-fluent.mjs'
const row = await snGetRecord(resolveInstance('$AUTH'), 'sys_scope', '$PROJECT_SCOPE_ID', 'sys_id', { throwOnError: true })
console.log(row ? 'yes' : 'no')" 2>/dev/null)
echo "does the $PSCOPE application ($PROJECT_SCOPE_ID) exist on the instance? $APP_EXISTS"
author_record Own
if [ -n "$NEWID" ]; then
  if [ "$APP_EXISTS" != "yes" ]; then
    note "the app is NOT on the instance (this project was only init-ed locally), so push must refuse up front."
    note "EXPECTED: 'the application $PSCOPE ... does not exist on this instance', nothing written"
    $NF push --project . --auth "$AUTH" --sys-id "$NEWID"
    echo "exit=$? (non-zero expected)"
    note "Whether the PLATFORM supports creating in an app's scope is answered by the spike's"
    note "'a create run AS <scope> (sysparm_transaction_scope) lands in it' line in phase 2."
  else
    note "push, no flag — EXPECTED one of:"
    note "  'created in $PSCOPE (run as that application)'  — the instance honours sysparm_transaction_scope"
    note "  'this instance does not create records AS $PSCOPE ... No record of yours was created' — it does not"
    $NF push --project . --auth "$AUTH" --sys-id "$NEWID" --dry-run
    $NF push --project . --auth "$AUTH" --sys-id "$NEWID"
    echo "push exit=$?"
    note "on the instance — EXPECTED: sys_scope $PROJECT_SCOPE_ID and api_name $PSCOPE.$AUTHORED, or no record at all"
    now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$NEWID" -f sys_id,api_name,sys_scope,description
    note "edit and push again — EXPECTED (only if it was created): a plain update, 'updated (1 field(s))'"
    sed -i.bak "s/now-fluent live-validate — safe to delete/EDITED IN OWN SCOPE/" "$SRC" && rm -f "$SRC.bak"
    $NF push --project . --auth "$AUTH" --sys-id "$NEWID"
    echo "push exit=$?"
    delete_record "$NEWID"
  fi
  rm -f "$SRC"
fi

# ---------------------------------------------------------------------------
hr "PHASE 4d — a record AUTHORED in the scoped project, pushed to GLOBAL on purpose"
author_record Global
if [ -n "$NEWID" ]; then
  note "push --target-scope x_other — EXPECTED: refused before any request, pointing at update-set-package"
  $NF push --project . --auth "$AUTH" --sys-id "$NEWID" --target-scope x_other
  echo "exit=$? (non-zero expected)"

  note "push --dry-run --target-scope global — EXPECTED: 'would POST ...?sysparm_transaction_scope=global', nothing created"
  $NF push --project . --auth "$AUTH" --sys-id "$NEWID" --target-scope global --dry-run

  note "push --target-scope global — EXPECTED: created, 'landed in GLOBAL', api_name global.$AUTHORED, 'Recorded as adopted'"
  $NF push --project . --auth "$AUTH" --sys-id "$NEWID" --target-scope global
  echo "push exit=$?"
  now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$NEWID" -f sys_id,api_name,sys_scope

  note "edit and push AGAIN, no flag — EXPECTED: 'pushing it back there', 'updated (1 field(s))', still Global"
  sed -i.bak "s/now-fluent live-validate — safe to delete/EDITED AFTER CREATE/" "$SRC" && rm -f "$SRC.bak"
  $NF push --project . --auth "$AUTH" --sys-id "$NEWID"
  echo "push exit=$?"
  now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$NEWID" -f api_name,sys_scope,description

  delete_record "$NEWID"
  rm -f "$SRC"
fi

hr "DONE — transcript: $LOG"
