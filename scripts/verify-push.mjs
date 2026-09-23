#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Phase 0 spike: prove out the four assumptions `push` is built on, live.
// ---------------------------------------------------------------------------
// Run this ONCE against a dev instance before trusting push in anger. It uses the
// exact transport push uses (now-sdk's stored credential -> /api/now/table), creates
// throwaway sys_script_include records, checks each assumption, and deletes them again.
//
//   node scripts/verify-push.mjs --auth <alias> [--scope <scope|sys_id>] [--keep]
//
//   --auth    credential alias, as stored by "now-fluent auth --add"
//   --scope   also run the whole thing inside this application scope (name like
//             "sn_hamp", or a sys_scope sys_id). Omit to test Global only.
//   --keep    leave the throwaway records behind instead of deleting them.
//
// Exit code is 0 only if every assumption holds.

import { randomBytes } from 'node:crypto'
import { resolveInstance, snRequest, snGetRecord, RAW_READ_PARAMS } from '../bin/now-fluent.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

const auth = flag('auth')
if (!auth) {
  console.error('Usage: node scripts/verify-push.mjs --auth <alias> [--scope <scope|sys_id>] [--keep]')
  process.exit(2)
}
const scopeRef = flag('scope')
const keep = has('keep')

const results = []
const created = [] // { table, sysId }
// Two different kinds of question, and conflating them is a FALSE RED:
//   required    — push is built on it; if it fails, push is unsafe here. Exit 1.
//   capability  — a platform fact push ADAPTS to (refuses, or reports). "No" is an
//                 answer, not a failure: it says what push can do on this instance.
// Treating a capability "no" as a failure made every run exit 1 on facts push already
// handles, which teaches you to ignore the exit code — as bad as a false green.
// A capability answer can also be null: "could not determine" — never to be read as no.
function record(id, question, ok, detail, kind = 'required') {
  results.push({ id, question, ok, detail, kind })
  const tag = kind === 'capability' ? (ok === null ? '??  ' : ok ? 'YES ' : 'NO  ') : (ok ? 'PASS' : 'FAIL')
  console.log(`  ${tag}  ${question}`)
  if (detail) console.log(`        ${detail}`)
}

const sysId = () => randomBytes(16).toString('hex')
const suffix = randomBytes(4).toString('hex')

// Every call here passes throwOnError so an HTTP failure becomes a catchable Error
// rather than ending the process — otherwise a mid-spike refusal would skip cleanup
// and leave throwaway records on the instance.
const THROW = { throwOnError: true }

async function probe(fn) {
  try { return { ok: true, value: await fn() } } catch (error) { return { ok: false, error } }
}
function reason(error) { return String(error && error.message ? error.message : error) }

// --- a scope to test in ----------------------------------------------------
async function resolveScope(instance, ref) {
  const query = /^[0-9a-f]{32}$/i.test(ref) ? `sys_id=${ref}` : `scope=${ref}`
  const rows = await snRequest(instance, 'GET', '/api/now/table/sys_scope', {
    ...THROW,
    params: { ...RAW_READ_PARAMS, sysparm_query: query, sysparm_fields: 'sys_id,scope,name', sysparm_limit: '5' }
  })
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No sys_scope matched "${ref}"`)
  return rows[0]
}

// --- one full create/update/read cycle in a given scope ---------------------
async function exercise(instance, label, scope) {
  console.log(`\n--- ${label} ---`)
  const id = sysId()
  const name = `NowFluentPushSpike${suffix}`
  const originalScript = `var ${name} = Class.create();\n// marker: original`
  const body = {
    sys_id: id,
    name,
    script: originalScript,
    description: 'now-fluent push spike — safe to delete',
    active: 'true'
  }
  if (scope) body.sys_scope = scope.sys_id

  // Q1 — does a Table API insert honour a supplied sys_id?
  const insert = await probe(() => snRequest(instance, 'POST', '/api/now/table/sys_script_include',
    { ...THROW, body, params: { sysparm_fields: 'sys_id' } }))
  if (!insert.ok) {
    record(`${label}/write`, `[${label}] Table API write is permitted`, false, reason(insert.error),
      scope ? 'capability' : 'required')
    return null
  }
  created.push({ table: 'sys_script_include', sysId: id })
  record(`${label}/write`, `[${label}] Table API write is permitted`, true, '', scope ? 'capability' : 'required')

  const afterInsert = await snGetRecord(instance, 'sys_script_include', id, undefined, THROW)
  record(`${label}/sysid`, `[${label}] insert honours the supplied sys_id (Now.ID identity survives)`,
    Boolean(afterInsert) && afterInsert.sys_id === id,
    afterInsert ? `sys_id on the instance: ${afterInsert.sys_id}` : 'record not readable after insert')

  if (scope) {
    // The one that decides whether push can create anything outside Global.
    const landed = afterInsert ? afterInsert.sys_scope : ''
    record(`${label}/scope`, `[${label}] sys_scope on a write is honoured (record lands in ${scope.scope})`,
      landed === scope.sys_id,
      landed === scope.sys_id
        ? `sys_scope: ${landed}`
        : `ignored: asked for ${scope.scope}, got "${landed}", api_name became `
          + `"${afterInsert ? afterInsert.api_name : '?'}".`,
      'capability')
  }

  // Can a create be run AS an application? The body's sys_scope is ignored (above); the
  // SDK itself sets a REST transaction's scope with ?sysparm_transaction_scope=<app>.
  // If the Table API honours that, push can create records in a project's own scope.
  if (scope) {
    const scopedId = sysId()
    const scopedName = `NowFluentTxScope${suffix}`
    const viaTx = await probe(() => snRequest(instance, 'POST', '/api/now/table/sys_script_include', {
      ...THROW,
      body: { sys_id: scopedId, name: scopedName, script: `var ${scopedName} = Class.create();`,
        description: 'now-fluent push spike — safe to delete', active: 'false' },
      params: { sysparm_fields: 'sys_id', sysparm_transaction_scope: scope.sys_id }
    }))
    if (!viaTx.ok) {
      record(`${label}/transaction-scope`, `[${label}] a create run AS ${scope.scope} (sysparm_transaction_scope) lands in it`,
        false, `the create itself was refused: ${reason(viaTx.error)}`, 'capability')
    } else {
      created.push({ table: 'sys_script_include', sysId: scopedId })
      const landedTx = await snGetRecord(instance, 'sys_script_include', scopedId, undefined, THROW)
      const scopeTx = landedTx ? landedTx.sys_scope : ''
      record(`${label}/transaction-scope`, `[${label}] a create run AS ${scope.scope} (sysparm_transaction_scope) lands in it`,
        !scopeTx ? null : scopeTx === scope.sys_id,
        !scopeTx
          ? 'could not determine: the probe record could not be read back.'
          : scopeTx === scope.sys_id
            ? `sys_scope: ${scopeTx}, api_name: ${landedTx.api_name}`
            : `ignored: landed in "${scopeTx}", api_name "${landedTx.api_name}".`,
        'capability')
    }
  }

  // Q2 — does PUT MERGE (leave unspecified fields alone) rather than replace?
  const update = await probe(() => snRequest(instance, 'PUT', `/api/now/table/sys_script_include/${id}`,
    { ...THROW, body: { description: 'now-fluent push spike — edited' }, params: { sysparm_fields: 'sys_id' } }))
  if (!update.ok) {
    record(`${label}/merge`, `[${label}] PUT merges — omitted fields keep their values`, false, reason(update.error))
  } else {
    const afterUpdate = await snGetRecord(instance, 'sys_script_include', id, undefined, THROW)
    const scriptKept = afterUpdate && afterUpdate.script === originalScript
    const nameKept = afterUpdate && afterUpdate.name === name
    const descChanged = afterUpdate && afterUpdate.description === 'now-fluent push spike — edited'
    record(`${label}/merge`, `[${label}] PUT merges — omitted fields keep their values`,
      Boolean(scriptKept && nameKept && descChanged),
      `script kept: ${scriptKept}, name kept: ${nameKept}, description updated: ${descChanged}`)
  }

  return id
}

// --- update set capture ----------------------------------------------------
// Two separate questions, and conflating them is a FALSE GREEN: "a capture row exists"
// is not "it landed where we asked". Live testing found a record captured into Default
// while the session was pointed at a named set, and the old check called that a pass.
async function checkUpdateSetCapture(instance, ids) {
  console.log('\n--- update set capture ---')
  const names = ids.map((id) => `sys_script_include_${id}`)
  const rows = await snRequest(instance, 'GET', '/api/now/table/sys_update_xml', {
    ...THROW,
    params: {
      ...RAW_READ_PARAMS,
      sysparm_query: `nameIN${names.join(',')}^ORDERBYDESCsys_created_on`,
      sysparm_fields: 'sys_id,name,update_set',
      sysparm_limit: '20'
    }
  })
  const captured = Array.isArray(rows) ? rows : []
  record('capture', 'Table API writes are captured into an update set',
    captured.length > 0,
    captured.length
      ? `${captured.length} sys_update_xml row(s)`
      : 'no sys_update_xml rows for these writes',
    'capability')
  if (!captured.length) return

  const setIds = [...new Set(captured.map((r) => r.update_set).filter(Boolean))]
  const setRows = setIds.length
    ? await snRequest(instance, 'GET', '/api/now/table/sys_update_set', {
      ...THROW,
      params: { ...RAW_READ_PARAMS, sysparm_query: `sys_idIN${setIds.join(',')}`, sysparm_fields: 'sys_id,name', sysparm_limit: '20' }
    })
    : []
  const nameOf = new Map((Array.isArray(setRows) ? setRows : []).map((r) => [r.sys_id, r.name]))
  const where = setIds.map((id) => `${nameOf.get(id) || id}`).join(', ')

  // The real question --update-set rests on: can the session STEER the destination?
  const steered = await probe(() => steerAndCheck(instance, captured))
  record('capture-steering', 'the session update set preference steers capture',
    steered.ok && steered.value === true,
    steered.ok
      ? (steered.value === true
        ? 'the sys_update_set preference decided the destination'
        : `ignored: the platform chose the update set itself (landed in: ${where}).`)
      : `could not determine — the probe itself failed: ${reason(steered.error)}`,
    'capability')
}

// Point the session at a fresh update set, write once more, and see where it lands.
async function steerAndCheck(instance, previousCaptures) {
  const setId = sysId()
  await snRequest(instance, 'POST', '/api/now/table/sys_update_set', {
    ...THROW,
    body: { sys_id: setId, name: `now-fluent spike ${suffix}`, description: 'now-fluent push spike — safe to delete' },
    params: { sysparm_fields: 'sys_id' }
  })
  created.push({ table: 'sys_update_set', sysId: setId })

  const me = await snRequest(instance, 'GET', '/api/now/ui/user/current_user', THROW)
  const userId = me && (me.user_sys_id || me.sys_id)
  if (!userId) throw new Error('could not resolve the current user')
  const existing = await snRequest(instance, 'GET', '/api/now/table/sys_user_preference', {
    ...THROW,
    params: { ...RAW_READ_PARAMS, sysparm_query: `name=sys_update_set^user=${userId}`, sysparm_fields: 'sys_id,value', sysparm_limit: '1' }
  })
  const pref = Array.isArray(existing) && existing.length ? existing[0] : null
  const before = pref ? pref.value : null
  if (pref) await snRequest(instance, 'PUT', `/api/now/table/sys_user_preference/${pref.sys_id}`, { ...THROW, body: { value: setId } })
  else await snRequest(instance, 'POST', '/api/now/table/sys_user_preference', { ...THROW, body: { name: 'sys_update_set', user: userId, value: setId, type: 'string' } })

  try {
    const probeId = sysId()
    await snRequest(instance, 'POST', '/api/now/table/sys_script_include', {
      ...THROW,
      body: { sys_id: probeId, name: `NowFluentSteer${suffix}`, script: `var NowFluentSteer${suffix} = Class.create();`, description: 'now-fluent push spike — safe to delete' },
      params: { sysparm_fields: 'sys_id' }
    })
    created.push({ table: 'sys_script_include', sysId: probeId })
    const rows = await snRequest(instance, 'GET', '/api/now/table/sys_update_xml', {
      ...THROW,
      params: { ...RAW_READ_PARAMS, sysparm_query: `name=sys_script_include_${probeId}^ORDERBYDESCsys_created_on`, sysparm_fields: 'update_set', sysparm_limit: '1' }
    })
    const landed = Array.isArray(rows) && rows.length ? rows[0].update_set : null
    return landed === setId
  } finally {
    if (pref) await snRequest(instance, 'PUT', `/api/now/table/sys_user_preference/${pref.sys_id}`, { ...THROW, body: { value: before || '' } })
  }
}

// --- main ------------------------------------------------------------------
const instance = resolveInstance(auth)
console.log(`now-fluent push spike -> ${instance.origin} (alias: ${auth})\n`)

console.log('--- connectivity ---')
const reachable = await probe(() => snRequest(instance, 'GET', '/api/now/table/sys_user',
  { ...THROW, params: { ...RAW_READ_PARAMS, sysparm_limit: '1', sysparm_fields: 'sys_id' } }))
record('read', 'the stored credential can read the Table API', reachable.ok,
  reachable.ok ? '' : reason(reachable.error))
if (!reachable.ok) process.exit(1)

// Everything from here on can create records, so failures must still reach cleanup.
try {
  const ids = []
  const globalId = await exercise(instance, 'global', null)
  if (globalId) ids.push(globalId)

  if (scopeRef) {
    const scope = await resolveScope(instance, scopeRef)
    console.log(`\nUsing scope: ${scope.scope} (${scope.name}) ${scope.sys_id}`)
    const scopedId = await exercise(instance, `scope:${scope.scope}`, scope)
    if (scopedId) ids.push(scopedId)
  } else {
    console.log('\n(no --scope given: the scoped-write assumption was NOT tested)')
  }

  if (ids.length) {
    const capture = await probe(() => checkUpdateSetCapture(instance, ids))
    if (!capture.ok) record('update-set', 'the update set capture probe ran', false, reason(capture.error), 'capability')
  }
} catch (error) {
  console.error(`\nSpike aborted: ${reason(error)}`)
  record('spike', 'the spike ran to completion', false, reason(error))
}

// --- cleanup ---------------------------------------------------------------
if (keep) {
  console.log(`\n--keep: leaving ${created.length} spike record(s) on the instance:`)
  for (const item of created) console.log(`  ${item.table} ${item.sysId}`)
} else if (created.length) {
  console.log('\n--- cleanup ---')
  for (const item of [...created].reverse()) {
    const removed = await probe(() => snRequest(instance, 'DELETE', `/api/now/table/${item.table}/${item.sysId}`, { ...THROW, allow404: true }))
    console.log(`  ${removed.ok ? 'deleted' : `COULD NOT DELETE (${reason(removed.error)})`} ${item.table} ${item.sysId}`)
  }
}

// --- verdict ---------------------------------------------------------------
// What push does about each capability being absent. Keyed by the id's last segment.
const ADAPTATION = {
  // Depends on the transaction-scope answer for the same scope, so the two lines agree.
  scope: (item) => {
    const tx = results.find((r) => r.id === item.id.replace(/\/scope$/, '/transaction-scope'))
    if (tx && tx.ok === true) {
      return 'the body\'s sys_scope is ignored, but running the create AS the application works (below): push creates\n'
        + '            records in a project\'s own scope that way. Global creates: --target-scope global.'
    }
    if (tx && tx.ok === false) {
      return 'and running the create AS the application does not help either (below): push cannot create records in\n'
        + '            a project\'s own scope on this instance. Use install or update-set-package; push still UPDATES them.'
    }
    return 'the body\'s sys_scope is ignored; see the transaction-scope line for whether push can create in a scope.'
  },
  'capture-steering': '--update-set cannot choose the set; it REPORTS where each write landed and fails\n'
    + '            on a mismatch. Use update-set-package when changes must be in a specific set.',
  capture: 'push produces no update set here; promote with update-set-package.',
  write: 'push gets a 403 per record in this scope, reports it with a hint, and carries on.',
  'transaction-scope': 'push cannot create records in a project\'s own scope here: it tries, sees the record land in\n'
    + '            Global, and deletes it again. Create them with install or update-set-package; push still UPDATES them.',
  'update-set': 'the probe itself failed — check capture by hand.'
}

const required = results.filter((r) => r.kind !== 'capability')
const brokenRequired = required.filter((r) => !r.ok)
const capabilities = results.filter((r) => r.kind === 'capability')

console.log(`\n${'='.repeat(70)}`)
console.log(`LOAD-BEARING — push is unsafe if any fail: ${required.length - brokenRequired.length}/${required.length} hold`)
for (const item of brokenRequired) console.log(`  FAILED: ${item.question}`)

if (capabilities.length) {
  console.log('\nCAPABILITIES — platform facts push adapts to (a "no" is an answer, not a failure):')
  for (const item of capabilities) {
    console.log(`  ${item.ok === null ? '?  ' : item.ok ? 'yes' : 'NO '}  ${item.question}`)
    const key = item.id.split('/').pop()
    const adaptation = typeof ADAPTATION[key] === 'function' ? ADAPTATION[key](item) : ADAPTATION[key]
    if (item.ok === false && adaptation) console.log(`       -> ${adaptation}`)
    if (item.ok === null) console.log(`       -> ${item.detail}`)
  }
}

console.log(brokenRequired.length
  ? '\npush is NOT safe against this instance — a load-bearing assumption failed (see FAILED above).'
  : '\npush is safe against this instance, within the capabilities listed above.')
process.exit(brokenRequired.length ? 1 : 0)
