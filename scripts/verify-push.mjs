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
function record(id, question, ok, detail) {
  results.push({ id, question, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${question}`)
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
    record(`${label}/write`, `[${label}] Table API write is permitted`, false, reason(insert.error))
    return null
  }
  created.push({ table: 'sys_script_include', sysId: id })
  record(`${label}/write`, `[${label}] Table API write is permitted`, true)

  const afterInsert = await snGetRecord(instance, 'sys_script_include', id, undefined, THROW)
  record(`${label}/sysid`, `[${label}] insert honours the supplied sys_id (Now.ID identity survives)`,
    Boolean(afterInsert) && afterInsert.sys_id === id,
    afterInsert ? `sys_id on the instance: ${afterInsert.sys_id}` : 'record not readable after insert')

  if (scope) {
    record(`${label}/scope`, `[${label}] the record landed in scope ${scope.scope}`,
      Boolean(afterInsert) && afterInsert.sys_scope === scope.sys_id,
      afterInsert ? `sys_scope: ${afterInsert.sys_scope} (wanted ${scope.sys_id})` : '')
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
async function checkUpdateSetCapture(instance, ids) {
  console.log('\n--- update set capture ---')
  const names = ids.map((id) => `sys_script_include_${id}`)
  const rows = await snRequest(instance, 'GET', '/api/now/table/sys_update_xml', {
    ...THROW,
    params: {
      ...RAW_READ_PARAMS,
      sysparm_query: `nameIN${names.join(',')}`,
      sysparm_fields: 'sys_id,name,update_set',
      sysparm_limit: '10'
    }
  })
  const captured = Array.isArray(rows) ? rows : []
  record('update-set', 'Table API writes are captured into the session update set',
    captured.length > 0,
    captured.length
      ? `${captured.length} sys_update_xml row(s); update_set ${captured[0].update_set || '(none)'} — --update-set is viable`
      : 'no sys_update_xml rows for these writes — push does NOT produce an update set; keep using update-set-package to promote')
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
    if (!capture.ok) record('update-set', 'Table API writes are captured into the session update set', false, reason(capture.error))
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
  for (const item of created) {
    const removed = await probe(() => snRequest(instance, 'DELETE', `/api/now/table/${item.table}/${item.sysId}`, { ...THROW, allow404: true }))
    console.log(`  ${removed.ok ? 'deleted' : `COULD NOT DELETE (${reason(removed.error)})`} ${item.table} ${item.sysId}`)
  }
}

// --- verdict ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${'='.repeat(70)}`)
console.log(`${results.length - failed.length}/${results.length} assumptions hold.`)
for (const item of failed) console.log(`  FAILED: ${item.question}`)
console.log(failed.length
  ? '\npush is NOT safe to use for the cases above — see each FAIL line for what the instance refused.'
  : '\nAll good: push/pull are safe to use against this instance.')
process.exit(failed.length ? 1 : 0)
