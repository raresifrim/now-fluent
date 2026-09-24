#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# now-fluent push/pull — LIVE validation runbook (run this on your own machine)
# ---------------------------------------------------------------------------
# Phases 0-2 are fully automatic and read-only-ish (the Phase 0 spike creates
# throwaway sys_script_include records and deletes them again).
# Phases 3-8 write records, so they are gated behind CONFIRM_PUSH=1.
# Phase 5 pulls by --query: three throwaway Global script includes, two matched.
# Phase 6 deletes one by removing its Fluent source: push --allow-delete.
# Phases 7-8 create a flow in Fluent, push and run it, edit it, pull it back, delete it.
#
#   chmod +x live-validate.sh
#   ./live-validate.sh --auth dev                      # phases 0-2
#   ./live-validate.sh --auth dev --scope sn_hamp      # + scoped spike
#   CONFIRM_PUSH=1 ./live-validate.sh --auth dev --round-trip   # + phases 3-8
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

# ---------------------------------------------------------------------------
hr "PHASE 5 — pull by QUERY: every record an encoded query matches"
# Three throwaway Global script includes sharing a unique name prefix. The query selects the
# two ACTIVE ones, so the inactive third proves the filter is applied, not just the prefix.
QPREFIX="NowFluentQ$(node -e "console.log(require('crypto').randomBytes(3).toString('hex'))")"
create_global_si() {
  node --input-type=module -e "
import { randomBytes } from 'node:crypto'
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
const id = randomBytes(16).toString('hex')
await snRequest(resolveInstance('$AUTH'), 'POST', '/api/now/table/sys_script_include', {
  throwOnError: true,
  body: { sys_id: id, name: '$1', script: 'var $1 = Class.create();', active: '$2',
          description: 'now-fluent live-validate query pull — safe to delete' },
  params: { sysparm_fields: 'sys_id', sysparm_transaction_scope: 'global' }
})
console.log(id)"
}
baseline_mod_count() {
  node -e "
const f = '.now-fluent/state/sys_script_include_$1.json'
try { console.log(JSON.parse(require('fs').readFileSync(f, 'utf8')).sys_mod_count) } catch { console.log('none') }"
}
Q1=$(create_global_si "${QPREFIX}A" true)
Q2=$(create_global_si "${QPREFIX}B" true)
Q3=$(create_global_si "${QPREFIX}C" false)
echo "created: $Q1 (${QPREFIX}A, active)  $Q2 (${QPREFIX}B, active)  $Q3 (${QPREFIX}C, INACTIVE)"
QUERY="nameSTARTSWITH${QPREFIX}^active=true"

if [ -n "$Q1" ] && [ -n "$Q2" ] && [ -n "$Q3" ]; then
  note "pull --query --dry-run — EXPECTED: '[dry-run] would select records ... $QUERY', nothing imported"
  $NF pull --project . --auth "$AUTH" --table sys_script_include --query "$QUERY" --dry-run
  echo "exit=$?"

  note "pull --query AND --sys-id — EXPECTED: refused ('EITHER --sys-id ... OR --query'), exit non-zero"
  $NF pull --project . --auth "$AUTH" --table sys_script_include --query "$QUERY" --sys-id "$Q1"
  echo "exit=$? (non-zero expected)"

  note "pull --query — EXPECTED: '2 record(s) matched', both ADOPTED from Global into $PSCOPE, 2 baselines"
  $NF pull --project . --auth "$AUTH" --table sys_script_include --query "$QUERY"
  echo "pull exit=$?"

  note "which records got a baseline — EXPECTED: A yes, B yes, C (inactive) NO"
  for pair in "A:$Q1" "B:$Q2" "C:$Q3"; do
    id="${pair#*:}"
    if [ -f ".now-fluent/state/sys_script_include_$id.json" ]; then echo "  ${pair%%:*} $id: baseline"; else echo "  ${pair%%:*} $id: no baseline"; fi
  done

  note "change A on the instance, then pull the same query again —"
  note "EXPECTED: 'already exist as Fluent source' warning for A and B, and A's baseline mod_count goes UP"
  BEFORE=$(baseline_mod_count "$Q1")
  node --input-type=module -e "
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
await snRequest(resolveInstance('$AUTH'), 'PUT', '/api/now/table/sys_script_include/$Q1', {
  throwOnError: true, body: { description: 'changed on the instance' },
  params: { sysparm_fields: 'sys_id', sysparm_transaction_scope: 'global' } })
console.log('changed ${QPREFIX}A on the instance')"
  $NF pull --project . --auth "$AUTH" --table sys_script_include --query "$QUERY"
  echo "pull exit=$?"
  echo "A baseline sys_mod_count: before $BEFORE, after $(baseline_mod_count "$Q1")"

  note "pull --query --limit 1 — EXPECTED: '1 record(s) matched'"
  $NF pull --project . --auth "$AUTH" --table sys_script_include --query "$QUERY" --limit 1
  echo "pull exit=$?"
fi

note "cleanup: the 3 records on the instance, and their Fluent source, baselines and adoptions here"
for id in $Q1 $Q2 $Q3; do
  [ -n "$id" ] || continue
  delete_record "$id"
  for f in $(grep -rl "$id" src/fluent --include='*.ts' 2>/dev/null | grep -v '/keys.ts$'); do rm -f "$f"; done
  rm -f ".now-fluent/state/sys_script_include_$id.json"
done
node -e "
const fs = require('fs'); const f = '.now-fluent/adopted.json'
if (fs.existsSync(f)) { const a = JSON.parse(fs.readFileSync(f, 'utf8'))
  for (const id of '$Q1 $Q2 $Q3'.split(' ')) delete a[id]
  fs.writeFileSync(f, JSON.stringify(a, null, 2) + '\n') }"
now-sdk build >/dev/null 2>&1 && echo "project still builds" || echo "WARNING: the project no longer builds after cleanup — run now-sdk build to see why"

# ---------------------------------------------------------------------------
hr "PHASE 6 — delete a record by removing its Fluent source: push --allow-delete"
# A throwaway Global script include, pulled (so it is adopted and has a baseline). Removing its
# source makes the SDK build emit a DELETE artifact (dist/app/author_elective_update), which push
# applies only with --allow-delete and only through the same guards as an update.
DNAME="NowFluentDel$(node -e "console.log(require('crypto').randomBytes(3).toString('hex'))")"
DEL=$(create_global_si "$DNAME" false)
echo "created: $DEL ($DNAME, Global, inactive)"
remove_source() {
  local found=0
  for f in $(grep -rl "$1" src/fluent --include='*.ts' 2>/dev/null | grep -v '/keys.ts$'); do rm -f "$f"; echo "removed $f"; found=1; done
  [ "$found" = 1 ] || echo "no Fluent source found for $1"
}
delete_artifact() {
  local f
  f=$(grep -l "$1" dist/app/author_elective_update/*.xml 2>/dev/null | head -1)
  if [ -n "$f" ] && grep -q 'action="DELETE"' "$f"; then echo "DELETE artifact: $f"; else echo "NO DELETE artifact for $1 in dist/app/author_elective_update"; fi
}
change_on_instance() {
  node --input-type=module -e "
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
await snRequest(resolveInstance('$AUTH'), 'PUT', '/api/now/table/sys_script_include/$1', {
  throwOnError: true, body: { description: 'changed on the instance after the pull' },
  params: { sysparm_fields: 'sys_id', sysparm_transaction_scope: 'global' } })
console.log('changed $1 on the instance')"
}

if [ -n "$DEL" ]; then
  note "pull it — EXPECTED: adopted from Global into $PSCOPE, baseline recorded"
  $NF pull --project . --auth "$AUTH" --table sys_script_include --sys-id "$DEL"
  echo "pull exit=$?"

  note "DRIFT GUARD: change it on the instance, remove its source, build, push --allow-delete"
  note "EXPECTED: a DELETE artifact, then 'REFUSED: changed on the instance since you pulled it', record NOT deleted"
  change_on_instance "$DEL"
  remove_source "$DEL"
  now-sdk build >/dev/null 2>&1; echo "build exit=$?"
  delete_artifact "$DEL"
  $NF push --project . --auth "$AUTH" --sys-id "$DEL" --allow-delete --no-build
  echo "push exit=$? (non-zero expected)"
  now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$DEL" -f sys_id,name,sys_scope

  note "pull again (takes the changed version, restores the source), remove the source again, build"
  $NF pull --project . --auth "$AUTH" --table sys_script_include --sys-id "$DEL"
  echo "pull exit=$?"
  remove_source "$DEL"
  now-sdk build >/dev/null 2>&1; echo "build exit=$?"
  delete_artifact "$DEL"

  note "push WITHOUT --allow-delete — EXPECTED: 'SKIPPED (a delete; pass --allow-delete to apply it)', nothing deleted"
  $NF push --project . --auth "$AUTH" --sys-id "$DEL" --no-build
  echo "push exit=$?"

  note "push --allow-delete --dry-run — EXPECTED: 'would DELETE .../sys_script_include/$DEL', nothing deleted"
  $NF push --project . --auth "$AUTH" --sys-id "$DEL" --allow-delete --no-build --dry-run
  echo "push exit=$?"

  note "push --allow-delete — EXPECTED: '$DEL deleted', exit 0"
  $NF push --project . --auth "$AUTH" --sys-id "$DEL" --allow-delete --no-build
  echo "push exit=$?"

  note "on the instance — EXPECTED: no record (0 retrieved)"
  now-sdk query sys_script_include --auth "$AUTH" -q "sys_id=$DEL" -f sys_id,name,sys_scope
  note "locally — EXPECTED: no baseline, no adopted.json entry"
  [ -f ".now-fluent/state/sys_script_include_$DEL.json" ] && echo "  baseline: STILL THERE" || echo "  baseline: gone"
  node -e "
const fs = require('fs'); const f = '.now-fluent/adopted.json'
const a = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
console.log('  adopted.json entry: ' + ('$DEL' in a ? 'STILL THERE' : 'gone'))"

  note "push --allow-delete AGAIN — EXPECTED: 'already absent', nothing sent"
  $NF push --project . --auth "$AUTH" --sys-id "$DEL" --allow-delete --no-build
  echo "push exit=$?"
fi

note "cleanup: make sure the record is gone, whatever happened above"
[ -n "$DEL" ] && delete_record "$DEL"
[ -n "$DEL" ] && remove_source "$DEL" >/dev/null
[ -n "$DEL" ] && rm -f ".now-fluent/state/sys_script_include_$DEL.json"
[ -n "$DEL" ] && node -e "
const fs = require('fs'); const f = '.now-fluent/adopted.json'
if (fs.existsSync(f)) { const a = JSON.parse(fs.readFileSync(f, 'utf8')); delete a['$DEL']
  fs.writeFileSync(f, JSON.stringify(a, null, 2) + '\n') }"
# keys.ts still registers it, so later builds keep emitting its DELETE artifact; a later
# push --allow-delete of it just reports 'already absent'.

# ---------------------------------------------------------------------------
# Flows: a Flow() builds into ONE artifact (flow + trigger + steps + delete_multiple
# directives); push writes it as one unit, keeps a live flow's active/status, and then
# activates it through api/now/wfa_fluent/activate_flows, as install does.
FRAND=$(node -e "console.log(require('crypto').randomBytes(3).toString('hex'))")
FNAME="NowFluent Flow $FRAND"
FMARK="NowFluentFlow$FRAND"
FSRC="src/fluent/nf-flow-$FRAND.now.ts"
write_flow() { # $1 = log message tag (v1, v2...), $2 = "second" to add a second step
  local second=""
  if [ "${2:-}" = "second" ]; then
    second="
        wfa.action(action.core.log, { \$id: Now.ID['nf_flow_${FRAND}_log2'] }, { log_level: 'warn', log_message: '$FMARK second step' })"
  fi
  cat > "$FSRC" <<FLOWEOF
import { action, Flow, wfa, trigger } from '@servicenow/sdk/automation'

Flow(
    { \$id: Now.ID['nf_flow_$FRAND'], name: '$FNAME', description: 'now-fluent live-validate — safe to delete', runAs: 'system' },
    wfa.trigger(
        trigger.record.created,
        { \$id: Now.ID['nf_flow_${FRAND}_trigger'] },
        { table: 'incident', condition: 'short_descriptionSTARTSWITH$FMARK', run_flow_in: 'background' }
    ),
    (params) => {
        wfa.action(action.core.log, { \$id: Now.ID['nf_flow_${FRAND}_log'] },
            { log_level: 'info', log_message: \`$FMARK $1 saw \${wfa.dataPill(params.trigger.current.number, 'string')}\` })$second
    }
)
FLOWEOF
}
# The flow on the instance: its state, and every part of its graph (step inputs decoded).
flow_report() {
  node --input-type=module -e "
import { gunzipSync } from 'node:zlib'
import { resolveInstance, snRequest, snGetRecord, RAW_READ_PARAMS } from '$REPO/bin/now-fluent.mjs'
const inst = resolveInstance('$AUTH')
const f = await snGetRecord(inst, 'sys_hub_flow', '$1', 'name,active,status,sys_scope,latest_snapshot,master_snapshot', { throwOnError: true })
if (!f) { console.log('  no sys_hub_flow $1 on the instance'); process.exit(0) }
console.log('  flow: ' + f.name + '  active=' + f.active + '  status=' + f.status + '  sys_scope=' + f.sys_scope
  + '  snapshot=' + (f.latest_snapshot || f.master_snapshot ? 'yes' : 'none'))
const list = (t, q, fields) => snRequest(inst, 'GET', '/api/now/table/' + t, { throwOnError: true,
  params: { ...RAW_READ_PARAMS, sysparm_query: q, sysparm_fields: fields, sysparm_limit: '100' } })
const triggers = await list('sys_hub_trigger_instance_v2', 'flow=$1', 'sys_id,trigger_type')
console.log('  triggers: ' + triggers.length + triggers.map((t) => ' [' + t.trigger_type + ']').join(''))
const steps = await list('sys_hub_action_instance_v2', 'flow=$1^ORDERBYorder', 'sys_id,order,values')
console.log('  steps: ' + steps.length)
for (const s of steps) {
  let text = s.values || ''
  try { text = gunzipSync(Buffer.from(text, 'base64')).toString('utf8') } catch {}
  const m = text.match(/$FMARK[^\"\\\\]*/)
  console.log('    #' + s.order + ' ' + s.sys_id + '  log_message: ' + (m ? m[0] : '(not found in values)'))
}"
}
delete_flow() {
  node --input-type=module -e "
import { resolveInstance, snRequest, snGetRecord, snDeleteRecord, RAW_READ_PARAMS } from '$REPO/bin/now-fluent.mjs'
const inst = resolveInstance('$AUTH')
const f = await snGetRecord(inst, 'sys_hub_flow', '$1', 'sys_id,sys_scope', { throwOnError: true })
if (!f) { console.log('flow $1 is already gone'); process.exit(0) }
const scope = f.sys_scope
let n = 0
for (const [t, q] of [['sys_hub_action_instance_v2', 'flow=$1'], ['sys_hub_trigger_instance_v2', 'flow=$1'],
  ['sys_hub_flow_logic_instance_v2', 'flow=$1'], ['sys_hub_sub_flow_instance_v2', 'flow=$1'], ['sys_hub_flow_snapshot', 'parent_flow=$1']]) {
  let rows = []
  try { rows = await snRequest(inst, 'GET', '/api/now/table/' + t, { throwOnError: true,
    params: { ...RAW_READ_PARAMS, sysparm_query: q, sysparm_fields: 'sys_id', sysparm_limit: '200' } }) } catch { continue }
  for (const r of rows) { try { await snDeleteRecord(inst, t, r.sys_id, scope); n++ } catch (e) { console.log('  could not delete ' + t + ' ' + r.sys_id) } }
}
await snDeleteRecord(inst, 'sys_hub_flow', '$1', scope)
console.log('deleted flow $1 and ' + n + ' record(s) of its graph')" || echo "could not delete flow $1 — remove it in Flow Designer"
}
flow_artifact() { grep -l "<name>$FNAME</name>" dist/app/update/sys_hub_flow_*.xml 2>/dev/null | head -1; }

hr "PHASE 7 — a NEW flow authored in Fluent, pushed to the instance, activated, and run"
write_flow v1
now-sdk build >/dev/null 2>&1
FART=$(flow_artifact)
FLOW=""
if [ -z "$FART" ]; then
  echo "the build produced no artifact for '$FNAME' — build output:"; now-sdk build 2>&1 | tail -20
else
  FLOW=$(basename "$FART" .xml | sed 's/^sys_hub_flow_//')
  echo "flow artifact: $FART"
  grep -o '<[a-z_0-9]* action="[A-Za-z_]*"' "$FART" | sed 's/^/  /'

  note "push --dry-run — EXPECTED: 'pushed as one unit', would POST sys_hub_flow + trigger + step, 'then activate it'"
  $NF push --project . --auth "$AUTH" --sys-id "$FLOW" --no-build --dry-run
  echo "exit=$?"

  note "push — EXPECTED: 'created in $PSCOPE: 3 record(s) written, 0 removed, activated (active=true, status=published)'"
  $NF push --project . --auth "$AUTH" --sys-id "$FLOW" --no-build
  echo "push exit=$?"

  note "on the instance — EXPECTED: active=true status=published, a snapshot, 1 trigger [record_create], 1 step saying 'v1'"
  flow_report "$FLOW"

  note "DIAGNOSTIC: how the instance returns a trigger's compressed inputs — ours vs one built in Flow Designer"
  note "EXPECTED: both start with '[' (plain JSON). If a Flow Designer one does and ours starts with 'H4sI',"
  note "push sent the stored gzip form, and activation cannot read the trigger."
  node --input-type=module -e "
import { resolveInstance, snRequest, RAW_READ_PARAMS } from '$REPO/bin/now-fluent.mjs'
const inst = resolveInstance('$AUTH')
const get = (q) => snRequest(inst, 'GET', '/api/now/table/sys_hub_trigger_instance_v2', { throwOnError: true,
  params: { ...RAW_READ_PARAMS, sysparm_query: q, sysparm_fields: 'sys_id,flow,trigger_inputs', sysparm_limit: '1' } })
const show = (label, rows) => console.log('  ' + label + ': ' + (rows[0] ? JSON.stringify(String(rows[0].trigger_inputs || '').slice(0, 60)) : '(none found)'))
show('ours            ', await get('flow=$FLOW'))
show('Flow Designer   ', await get('flow!=$FLOW^trigger_inputsISNOTEMPTY^flow.sys_created_byNOT LIKEnow-fluent'))"

  note "does it RUN? creating an incident whose short description matches the trigger, then waiting for a flow context"
  INC=$(node --input-type=module -e "
import { randomBytes } from 'node:crypto'
import { resolveInstance, snRequest } from '$REPO/bin/now-fluent.mjs'
const id = randomBytes(16).toString('hex')
await snRequest(resolveInstance('$AUTH'), 'POST', '/api/now/table/incident', { throwOnError: true,
  body: { sys_id: id, short_description: '$FMARK trigger test — safe to delete' },
  params: { sysparm_fields: 'sys_id', sysparm_transaction_scope: 'global' } })
console.log(id)")
  echo "incident: $INC"
  node --input-type=module -e "
import { resolveInstance, snRequest, RAW_READ_PARAMS } from '$REPO/bin/now-fluent.mjs'
const inst = resolveInstance('$AUTH')
for (let i = 0; i < 12; i++) {
  let rows = []
  try { rows = await snRequest(inst, 'GET', '/api/now/table/sys_flow_context', { throwOnError: true,
    params: { ...RAW_READ_PARAMS, sysparm_query: 'flow=$FLOW', sysparm_fields: 'sys_id,state,name', sysparm_limit: '5' } }) } catch (e) { console.log('  cannot read sys_flow_context: ' + e.message); break }
  if (rows.length) { console.log('  RAN: ' + rows.map((r) => r.name + ' state=' + r.state).join(', ')); process.exit(0) }
  await new Promise((r) => setTimeout(r, 5000))
}
console.log('  no flow context within 60s — check Flow Designer > Executions (a background flow can queue)')"
  [ -n "$INC" ] && node --input-type=module -e "
import { resolveInstance, snDeleteRecord } from '$REPO/bin/now-fluent.mjs'
await snDeleteRecord(resolveInstance('$AUTH'), 'incident', '$INC', 'global'); console.log('deleted incident $INC')"
fi

hr "PHASE 8 — editing that EXISTING flow: change a step, add one, remove it, drift, pull it back"
if [ -n "$FLOW" ]; then
  note "edit: log message v1 -> v2, and ADD a second step; push — EXPECTED: 'updated', 1 new step POSTed, re-activated"
  write_flow v2 second
  now-sdk build >/dev/null 2>&1
  $NF push --project . --auth "$AUTH" --sys-id "$FLOW" --no-build --dry-run
  $NF push --project . --auth "$AUTH" --sys-id "$FLOW" --no-build
  echo "push exit=$?"
  note "EXPECTED: still active/published, 2 steps, the first saying 'v2'"
  flow_report "$FLOW"

  note "REMOVE the second step; push — EXPECTED: '1 removed' (through delete_multiple), re-activated"
  write_flow v2
  now-sdk build >/dev/null 2>&1
  $NF push --project . --auth "$AUTH" --sys-id "$FLOW" --no-build
  echo "push exit=$?"
  note "EXPECTED: 1 step left, saying 'v2'"
  flow_report "$FLOW"

  note "DRIFT: change the flow on the instance, then push an edit — EXPECTED: REFUSED 'changed on the instance', nothing written"
  node --input-type=module -e "
import { resolveInstance, snRequest, snGetRecord } from '$REPO/bin/now-fluent.mjs'
const inst = resolveInstance('$AUTH')
const f = await snGetRecord(inst, 'sys_hub_flow', '$FLOW', 'sys_scope', { throwOnError: true })
await snRequest(inst, 'PUT', '/api/now/table/sys_hub_flow/$FLOW', { throwOnError: true,
  body: { description: 'changed on the instance' }, params: { sysparm_fields: 'sys_id', sysparm_transaction_scope: f.sys_scope } })
console.log('changed the flow description on the instance')"
  write_flow v3
  now-sdk build >/dev/null 2>&1
  $NF push --project . --auth "$AUTH" --sys-id "$FLOW" --no-build
  echo "push exit=$? (non-zero expected)"

  note "PULL it back: the authored source is set aside; pull must go through the online transform"
  note "EXPECTED: 'graphs the query path cannot rebuild — importing them through the online transform', a baseline"
  mv "$FSRC" "$FSRC.authored"
  $NF pull --project . --auth "$AUTH" --table sys_hub_flow --sys-id "$FLOW"
  PULL_EXIT=$?
  echo "pull exit=$PULL_EXIT"
  PULLED=$(grep -rl "$FLOW" src/fluent --include='*.ts' 2>/dev/null | grep -v '/keys.ts$' | head -5)
  echo "generated source for the flow: ${PULLED:-none}"
  if [ "$PULL_EXIT" = 0 ] && [ -n "$PULLED" ]; then
    note "edit the PULLED source (whatever version is live -> 'v4' in the log message) and push — EXPECTED: 'updated', step says 'v4'"
    for f in $PULLED; do sed -i.bak "s/$FMARK v[0-9][0-9]* saw/$FMARK v4 saw/" "$f" && rm -f "$f.bak"; done
    if grep -q "$FMARK v4 saw" $PULLED; then
      now-sdk build >/dev/null 2>&1
      $NF push --project . --auth "$AUTH" --sys-id "$FLOW" --no-build
      echo "push exit=$?"
      flow_report "$FLOW"
    else
      echo "the pulled source does not carry the log message as text (the SDK may have produced low-level Record() files) — not edited:"
      for f in $PULLED; do echo "  --- $f"; sed -n '1,40p' "$f"; done
    fi
  fi

  note "cleanup: the flow and its whole graph on the instance, and its source, baselines here"
  delete_flow "$FLOW"
  for f in $(grep -rl "$FLOW" src/fluent --include='*.ts' 2>/dev/null | grep -v '/keys.ts$'); do rm -f "$f"; done
  rm -f "$FSRC" "$FSRC.authored" .now-fluent/state/sys_hub_*.json
  now-sdk build >/dev/null 2>&1; echo "project rebuilt after cleanup"
else
  echo "skipped: phase 7 created no flow"
  rm -f "$FSRC"
fi

hr "DONE — transcript: $LOG"
