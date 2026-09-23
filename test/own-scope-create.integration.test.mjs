// Scenario 5: push a NEW record authored in the project's own scope (x_push_demo), with
// no install. The body's sys_scope is inert (verified live), so the create runs AS the
// application — ?sysparm_transaction_scope=<app sys_id>, the mechanism the SDK itself
// uses for flow activation.
//
// A wrong create cannot be safely undone (a delete does not undo what the insert
// triggered), so whether the instance honours the parameter is established FIRST, once
// per run, with a throwaway probe record — no record of the user's is created on a
// guess. The real create is still verified, and rolled back as a last resort.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { startMockInstance } from './helpers/mock-instance.mjs'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'now-fluent.mjs')
const FAKE_SDK = resolve(import.meta.dirname, 'helpers', 'fake-sdk.mjs')
const PROJECT_SCOPE_ID = 'e5d61884beaf441ebd67932b798cb00b'
const NEW_ID = 'ee55cd34ef56ab12cd34ef56ab12cd34'
const run = promisify(execFile)

let project

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'now-fluent-own-scope-'))
  writeConfig({ scope: 'x_push_demo', scopeId: PROJECT_SCOPE_ID, name: 'Push Demo' })
  writeArtifact('sys_script_include', NEW_ID, 'first')
})

function writeConfig(config) {
  writeFileSync(join(project, 'now.config.json'), JSON.stringify(config))
}

function writeArtifact(table, id, description, scopeId = PROJECT_SCOPE_ID) {
  mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
  const api = table === 'sys_script_include' ? `<api_name>x_push_demo.A${id.slice(0, 4)}</api_name>` : ''
  writeFileSync(join(project, 'dist', 'app', 'update', `${table}_${id}.xml`),
    `<record_update table="${table}"><${table} action="INSERT_OR_UPDATE" apply_defaults="true">`
    + `<sys_id>${id}</sys_id><sys_scope display_value="x_push_demo">${scopeId}</sys_scope>${api}`
    + `<description>${description}</description><name>A${id.slice(0, 4)}</name></${table}></record_update>`)
}

async function push(instance, ...args) {
  try {
    const { stdout, stderr } = await run(process.execPath,
      [CLI, 'push', '--project', project, '--auth', 'test', ...args], {
        encoding: 'utf8',
        env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
      })
    return { status: 0, output: stdout + stderr }
  } catch (error) {
    return { status: error.code ?? 1, output: (error.stdout ?? '') + (error.stderr ?? '') }
  }
}

// The project's application exists on the instance unless a test says otherwise.
async function withInstance(options, body, { appExists = true } = {}) {
  const instance = await startMockInstance(options)
  if (appExists) {
    instance.store.set(`sys_scope/${PROJECT_SCOPE_ID}`, { sys_id: PROJECT_SCOPE_ID, scope: 'x_push_demo', name: 'Push Demo' })
  }
  try { await body(instance) } finally { await instance.stop() }
}

// The writes made for records OTHER than the throwaway probe.
const realWrites = (instance) => instance.writes().filter((w) => !(w.body && /ScopeProbe/.test(w.body.name || ''))
  && !(w.method === 'DELETE' && w.sysId && !instance.log.some((e) => e.method === 'POST' && e.body && e.body.sys_id === w.sysId
    && !/ScopeProbe/.test(e.body.name || '')) ))

test('an instance that honours it: probe first, then the record is CREATED IN x_push_demo', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /Checking once whether this instance creates records AS x_push_demo/)
    assert.match(result.output, /created in x_push_demo \(run as that application\)/)

    const methods = instance.writes().map((w) => `${w.method} ${w.body ? (w.body.name || '') : ''}`.trim())
    assert.match(methods[0], /^POST NowFluentScopeProbe/, 'the probe goes first')
    assert.equal(methods[1], 'DELETE', 'and is deleted before anything else')
    const realPost = instance.writes()[2]
    assert.equal(realPost.body.sys_id, NEW_ID)
    assert.equal(realPost.params.sysparm_transaction_scope, PROJECT_SCOPE_ID)

    assert.equal(instance.store.get(`sys_script_include/${NEW_ID}`).sys_scope, PROJECT_SCOPE_ID)
    assert.ok(![...instance.store.keys()].some((k) => k !== `sys_script_include/${NEW_ID}` && k.startsWith('sys_script_include/')),
      'the probe record is gone')
    assert.ok(!existsSync(join(project, '.now-fluent', 'adopted.json')), 'it lives in its own scope: nothing adopted')
  }))

test('...and later pushes of it are ordinary updates, with no probe', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    assert.equal((await push(instance, '--sys-id', NEW_ID)).status, 0)
    writeArtifact('sys_script_include', NEW_ID, 'edited')
    instance.log.length = 0
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.equal(result.status, 0, result.output)
    assert.ok(!/Checking once/.test(result.output))
    const writes = instance.writes()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PUT')
    assert.deepEqual(Object.keys(writes[0].body), ['description'])
  }))

test('an instance that ignores it: the probe finds out, and NO record of yours is created', () =>
  withInstance({ honoursTransactionScope: false }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /this instance does not create records AS x_push_demo/)
    assert.match(result.output, /probe record run as x_push_demo landed in Global/)
    assert.match(result.output, /No record of yours was created/)
    assert.ok(!instance.writes().some((w) => w.body && w.body.sys_id === NEW_ID), 'the real record was never sent')
    assert.ok(!instance.store.has(`sys_script_include/${NEW_ID}`))
    assert.ok(![...instance.store.keys()].some((k) => k.startsWith('sys_script_include/')), 'probe cleaned up')
  }))

test('the probe runs once per push, however many new records there are', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    const second = 'ff66cd34ef56ab12cd34ef56ab12cd34'
    writeArtifact('sys_script_include', second, 'second')
    const result = await push(instance, '--sys-id', `${NEW_ID},${second}`)
    assert.equal(result.status, 0, result.output)
    assert.equal(result.output.match(/Checking once/g).length, 1)
    assert.ok(instance.store.has(`sys_script_include/${NEW_ID}`))
    assert.ok(instance.store.has(`sys_script_include/${second}`))
  }))

test('a table the instance treats differently is caught after the write and rolled back — honestly', () =>
  // The probe (a script include) lands correctly, but a business rule does not.
  withInstance({ honoursTransactionScope: ['sys_script_include'] }, async (instance) => {
    const brId = 'aa77cd34ef56ab12cd34ef56ab12cd34'
    writeArtifact('sys_script', brId, 'rule')
    const result = await push(instance, '--sys-id', brId)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /although a probe record landed in x_push_demo, this sys_script record was created in Global/)
    assert.match(result.output, /Anything its insert triggered \(business rules\) is NOT undone/)
    assert.ok(!instance.store.has(`sys_script/${brId}`), 'rolled back')
  }))

test('a create whose scope cannot be read back is reported UNVERIFIED, and not deleted', () =>
  withInstance({ honoursTransactionScope: true, noScopeTables: ['u_widget'] }, async (instance) => {
    const id = 'bb88cd34ef56ab12cd34ef56ab12cd34'
    writeArtifact('u_widget', id, 'widget')
    const result = await push(instance, '--sys-id', id)
    assert.notEqual(result.status, 0, 'unverified is not success')
    assert.match(result.output, /could not be read back, so it is UNVERIFIED/)
    assert.ok(instance.store.has(`u_widget/${id}`), 'never delete what might be right')
  }))

test('tables and columns are never created this way', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    const id = 'cc99cd34ef56ab12cd34ef56ab12cd34'
    writeArtifact('sys_db_object', id, 'a table')
    const result = await push(instance, '--sys-id', id)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /push does not create sys_db_object records/)
    assert.deepEqual(instance.writes(), [], 'not even a probe')
  }))

test('--dry-run writes nothing — not even the probe — and says a real run checks first', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID, '--dry-run')
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, new RegExp(`would POST .*sysparm_transaction_scope=${PROJECT_SCOPE_ID}`))
    assert.match(result.output, /a real run first checks, with a throwaway probe record/)
    assert.deepEqual(instance.writes(), [])
  }))

test('--target-scope x_push_demo is accepted, and means the same as no flag', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID, '--target-scope', 'x_push_demo')
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /created in x_push_demo/)
  }))

test('--target-scope global creates in Global, with no probe, run AS Global', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID, '--target-scope', 'global')
    assert.equal(result.status, 0, result.output)
    assert.ok(!/Checking once/.test(result.output))
    const post = instance.writes().find((w) => w.method === 'POST')
    assert.equal(post.params.sysparm_transaction_scope, 'global')
    assert.equal(instance.store.get(`sys_script_include/${NEW_ID}`).sys_scope, 'global')
  }))

test('a Global-bound project creates Global records with one POST, run AS Global', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    writeConfig({ scope: 'global', scopeId: 'global', name: 'Global stuff' })
    writeArtifact('sys_script_include', NEW_ID, 'global one', 'global')
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.equal(result.status, 0, result.output)
    assert.ok(!/Checking once/.test(result.output), 'no probe, no app lookup')
    assert.deepEqual(instance.writes().map((w) => w.method), ['POST'])
    assert.equal(instance.writes()[0].params.sysparm_transaction_scope, 'global')
  }))

test('a new record in a THIRD scope is still refused', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    writeArtifact('sys_script_include', NEW_ID, 'third', 'dd00cd34ef56ab12cd34ef56ab12cd34')
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /neither Global nor this project's own/)
    assert.deepEqual(instance.writes(), [])
  }))

test('if the project\'s application does not exist on the instance, say so — do not try', () =>
  withInstance({ honoursTransactionScope: true }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /the application x_push_demo .* does not exist on this instance/)
    assert.deepEqual(instance.writes(), [], 'no probe either')
  }, { appExists: false }))

// Seen live (sn_sow): a record inside an application refused a DELETE run from Global.
test('an app that refuses deletes from Global: the probe is deleted AS the application', () =>
  withInstance({ honoursTransactionScope: true, protectedFromGlobal: true }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.equal(result.status, 0, result.output)
    const del = instance.writes().find((w) => w.method === 'DELETE')
    assert.equal(del.params.sysparm_transaction_scope, PROJECT_SCOPE_ID)
    assert.ok(![...instance.store.keys()].some((k) => k !== `sys_script_include/${NEW_ID}` && k.startsWith('sys_script_include/')),
      'the probe record is gone')
  }))

test('a probe that cannot be deleted is named, and NOT retried for every record', () =>
  withInstance({ honoursTransactionScope: true, undeletableScopes: [PROJECT_SCOPE_ID] }, async (instance) => {
    const second = 'ff66cd34ef56ab12cd34ef56ab12cd34'
    writeArtifact('sys_script_include', second, 'second')
    const result = await push(instance, '--sys-id', `${NEW_ID},${second}`)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /could not delete the scope probe record sys_script_include [0-9a-f]{32} — delete it by hand/)
    const probes = instance.writes().filter((w) => w.method === 'POST' && /ScopeProbe/.test(w.body.name || ''))
    assert.equal(probes.length, 1, 'one probe per run, even when it fails')
    assert.ok(!instance.store.has(`sys_script_include/${NEW_ID}`) && !instance.store.has(`sys_script_include/${second}`),
      'no record of yours was created')
  }))

test('--allow-delete of a record in the project\'s app runs the delete AS the application', () =>
  withInstance({ honoursTransactionScope: true, protectedFromGlobal: true }, async (instance) => {
    mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
    writeFileSync(join(project, 'dist', 'app', 'update', `sys_script_include_${NEW_ID}.xml`),
      `<record_update table="sys_script_include"><sys_script_include action="DELETE">`
      + `<sys_id>${NEW_ID}</sys_id><sys_scope>${PROJECT_SCOPE_ID}</sys_scope></sys_script_include></record_update>`)
    instance.store.set(`sys_script_include/${NEW_ID}`, { sys_id: NEW_ID, sys_scope: PROJECT_SCOPE_ID, name: 'Aee55',
      sys_updated_on: '2026-01-01 00:00:00', sys_mod_count: '0' })
    mkdirSync(join(project, '.now-fluent', 'state'), { recursive: true })
    writeFileSync(join(project, '.now-fluent', 'state', `sys_script_include_${NEW_ID}.json`), JSON.stringify({
      table: 'sys_script_include', sys_id: NEW_ID, instance: instance.origin,
      sys_updated_on: '2026-01-01 00:00:00', sys_mod_count: '0', fields: { sys_id: NEW_ID, sys_scope: PROJECT_SCOPE_ID }
    }))
    const result = await push(instance, '--sys-id', NEW_ID, '--allow-delete', '--no-build')
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /deleted/)
    assert.ok(!instance.store.has(`sys_script_include/${NEW_ID}`))
  }))

test('an update of a record inside the app runs AS the app, so a Global-refusing app still accepts it', () =>
  withInstance({ honoursTransactionScope: true, protectedFromGlobal: true }, async (instance) => {
    assert.equal((await push(instance, '--sys-id', NEW_ID)).status, 0)
    writeArtifact('sys_script_include', NEW_ID, 'edited')
    instance.log.length = 0
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.equal(result.status, 0, result.output)
    const put = instance.writes().find((w) => w.method === 'PUT')
    assert.equal(put.params.sysparm_transaction_scope, PROJECT_SCOPE_ID)
    assert.equal(instance.store.get(`sys_script_include/${NEW_ID}`).description, 'edited')
  }))

// Seen live: with the account's app picker on sn_sow, a plain REST create landed in sn_sow,
// and a --target-scope global push reported success for a record that was NOT in Global.
const PICKER_APP = '5ca1bcb3733320103e366238edf6a706'

test('with the app picker on another app, a Global create still lands in Global — run AS Global', () =>
  withInstance({ honoursTransactionScope: true, currentApp: PICKER_APP }, async (instance) => {
    const result = await push(instance, '--sys-id', NEW_ID, '--target-scope', 'global')
    assert.equal(result.status, 0, result.output)
    assert.equal(instance.store.get(`sys_script_include/${NEW_ID}`).sys_scope, 'global')
  }))

test('...and an instance that ignores that is caught: the create is rolled back, the picker named', () =>
  withInstance({ honoursTransactionScope: false, currentApp: PICKER_APP }, async (instance) => {
    instance.store.set(`sys_scope/${PICKER_APP}`, { sys_id: PICKER_APP, scope: 'sn_sow' })
    const result = await push(instance, '--sys-id', NEW_ID, '--target-scope', 'global')
    assert.notEqual(result.status, 0, 'never reported as a success')
    assert.match(result.output, /asked to create it AS Global, but this sys_script_include record was created in sn_sow/)
    assert.match(result.output, /current application \(the app picker\)/)
    assert.ok(!instance.store.has(`sys_script_include/${NEW_ID}`), 'rolled back')
  }))

test('an update of a Global record runs AS Global, whatever the picker says', () =>
  withInstance({ honoursTransactionScope: true, currentApp: PICKER_APP }, async (instance) => {
    assert.equal((await push(instance, '--sys-id', NEW_ID, '--target-scope', 'global')).status, 0)
    writeArtifact('sys_script_include', NEW_ID, 'edited')
    instance.log.length = 0
    const result = await push(instance, '--sys-id', NEW_ID)
    assert.equal(result.status, 0, result.output)
    const put = instance.writes().find((w) => w.method === 'PUT')
    assert.equal(put.params.sysparm_transaction_scope, 'global')
    assert.equal(instance.store.get(`sys_script_include/${NEW_ID}`).sys_scope, 'global')
  }))

test('a Global schema create is probed first, and refused when the probe lands elsewhere', () =>
  withInstance({ honoursTransactionScope: false, currentApp: PICKER_APP }, async (instance) => {
    writeConfig({ scope: 'global', scopeId: 'global', name: 'Global stuff' })
    const tableId = 'bb88cd34ef56ab12cd34ef56ab12cd34'
    writeArtifact('sys_db_object', tableId, 'a table', 'global')
    const result = await push(instance, '--sys-id', tableId)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /this instance does not create records AS Global/)
    assert.match(result.output, /switch it to Global/)
    assert.ok(!instance.store.has(`sys_db_object/${tableId}`), 'the table was never created')
  }))
