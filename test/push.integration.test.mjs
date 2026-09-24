// End-to-end tests for `now-fluent push`: a real child process, a fake now-sdk and a
// mock Table API. Covers the behaviours that would be dangerous to get wrong against
// a live instance — insert identity, partial updates, and the drift guard.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { startMockInstance } from './helpers/mock-instance.mjs'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'now-fluent.mjs')
const FAKE_SDK = resolve(import.meta.dirname, 'helpers', 'fake-sdk.mjs')
const SYS_ID = 'ab12cd34ef56ab12cd34ef56ab12cd34'

let instance
let project

before(async () => { instance = await startMockInstance() })
after(async () => { await instance.stop() })

beforeEach(() => {
  instance.store.clear()
  instance.log.length = 0
  project = mkdtempSync(join(tmpdir(), 'now-fluent-push-'))
  mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
  writeArtifact({ name: 'MyInclude', script: 'var a = 1;', description: 'first' })
})

function writeArtifact({ name, script, description, action = 'INSERT_OR_UPDATE', table = 'sys_script_include' }) {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<record_update table="${table}">`,
    `  <${table} action="${action}">`,
    '    <active>true</active>',
    `    <description>${description}</description>`,
    `    <name>${name}</name>`,
    `    <script><![CDATA[${script}]]></script>`,
    '    <sys_created_on>2020-01-01 00:00:00</sys_created_on>',
    '    <sys_mod_count>99</sys_mod_count>',
    `    <sys_id>${SYS_ID}</sys_id>`,
    '    <sys_scope display_value="Global">global</sys_scope>',
    `  </${table}>`,
    '</record_update>'
  ].join('\n')
  writeFileSync(join(project, 'dist', 'app', 'update', `${table}_${SYS_ID}.xml`), xml)
}

const run = promisify(execFile)

// MUST be async: the mock instance runs in THIS process, so a synchronous spawn
// would block the event loop and deadlock against the CLI's own HTTP request.
async function push(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, 'push', '--project', project, '--auth', 'test', ...args], {
      encoding: 'utf8',
      env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

const baselineFile = () => join(project, '.now-fluent', 'state', `sys_script_include_${SYS_ID}.json`)

test('creates a missing record with POST, carrying the sys_id', async () => {
  const result = await push('--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.stderr)

  const writes = instance.writes()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'POST')
  assert.equal(writes[0].body.sys_id, SYS_ID, 'insert must carry the sys_id so Now.ID identity survives')
  assert.equal(instance.store.get(`sys_script_include/${SYS_ID}`).name, 'MyInclude')
  assert.match(result.stdout, /created/)
})

test('an insert never writes instance-owned bookkeeping fields', async () => {
  await push('--sys-id', SYS_ID)
  const body = instance.writes()[0].body
  for (const field of ['sys_created_on', 'sys_mod_count', 'sys_update_name', 'sys_class_name']) {
    assert.ok(!(field in body), `${field} must not be written (artifact had it)`)
  }
  assert.equal(body.sys_scope, 'global', 'sys_scope IS written — it puts the record in the right scope')
})

test('writes a baseline after a successful push', async () => {
  await push('--sys-id', SYS_ID)
  assert.ok(existsSync(baselineFile()))
  const baseline = JSON.parse(readFileSync(baselineFile(), 'utf8'))
  assert.equal(baseline.fields.name, 'MyInclude')
  assert.equal(baseline.sysId, SYS_ID)
})

test('a second push with no local edit sends nothing', async () => {
  assert.equal((await push('--sys-id', SYS_ID)).status, 0)
  instance.log.length = 0
  const again = await push('--sys-id', SYS_ID)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /unchanged/)
  assert.deepEqual(instance.writes(), [], 'an unchanged record must not be written')
})

test('after a local edit, PUT carries only the changed field', async () => {
  await push('--sys-id', SYS_ID)
  instance.log.length = 0
  writeArtifact({ name: 'MyInclude', script: 'var a = 2; // edited', description: 'first' })

  const result = await push('--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.stderr)
  const writes = instance.writes()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'PUT')
  assert.deepEqual(Object.keys(writes[0].body), ['script'], 'only the edited field should be sent')
  assert.match(writes[0].body.script, /edited/)
  // The merge left the untouched fields alone.
  assert.equal(instance.store.get(`sys_script_include/${SYS_ID}`).description, 'first')
})

test('--full sends every modelled field even when unchanged', async () => {
  await push('--sys-id', SYS_ID)
  instance.log.length = 0
  const result = await push('--sys-id', SYS_ID, '--full')
  assert.equal(result.status, 0, result.stderr)
  const body = instance.writes()[0].body
  assert.deepEqual(Object.keys(body).sort(), ['active', 'description', 'name', 'script', 'sys_scope'])
})

test('refuses a record that changed on the instance since the pull', async () => {
  await push('--sys-id', SYS_ID)
  // Somebody else edits it on the instance.
  const row = instance.store.get(`sys_script_include/${SYS_ID}`)
  instance.store.set(`sys_script_include/${SYS_ID}`, { ...row, sys_updated_on: '2026-09-09 09:09:09', sys_mod_count: '42' })
  writeArtifact({ name: 'MyInclude', script: 'var a = 3;', description: 'first' })
  instance.log.length = 0

  const result = await push('--sys-id', SYS_ID)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /changed on the instance since you pulled it/)
  assert.deepEqual(instance.writes(), [], 'a drifted record must not be written')
})

test('--force overrides drift', async () => {
  await push('--sys-id', SYS_ID)
  const row = instance.store.get(`sys_script_include/${SYS_ID}`)
  instance.store.set(`sys_script_include/${SYS_ID}`, { ...row, sys_updated_on: '2026-09-09 09:09:09', sys_mod_count: '42' })
  writeArtifact({ name: 'MyInclude', script: 'var a = 3;', description: 'first' })
  instance.log.length = 0

  const result = await push('--sys-id', SYS_ID, '--force')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(instance.writes().length, 1)
})

test('refuses an existing record that was never pulled', async () => {
  instance.store.set(`sys_script_include/${SYS_ID}`, {
    sys_id: SYS_ID, name: 'Someone elses', script: 'var x = 0;', sys_updated_on: '2026-01-01 00:00:01', sys_mod_count: '3'
  })
  const result = await push('--sys-id', SYS_ID)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /no usable pull baseline/)
  assert.deepEqual(instance.writes(), [])
})

test('--dry-run reads but never writes, and names the real verb', async () => {
  // A dry run is "everything except the write": it reads the live record so its preview
  // shows the verb, body and refusals the real run would produce.
  const result = await push('--sys-id', SYS_ID, '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(instance.writes(), [], 'a dry run must never write')
  assert.match(result.stdout, /would POST .*sys_script_include/, 'the record does not exist, so: POST')
  assert.match(result.stdout, /MyInclude/)
  assert.ok(!instance.store.has(`sys_script_include/${SYS_ID}`))
})

test('--no-scope omits sys_scope from the write', async () => {
  const result = await push('--sys-id', SYS_ID, '--no-scope')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!('sys_scope' in instance.writes()[0].body))
})

test('a DELETE artifact is skipped unless --allow-delete', async () => {
  await push('--sys-id', SYS_ID)   // creates it, and records a baseline
  writeArtifact({ name: 'MyInclude', script: 'var a = 1;', description: 'first', action: 'DELETE' })

  const skipped = await push('--sys-id', SYS_ID)
  assert.equal(skipped.status, 0, skipped.stderr)
  assert.match(skipped.stdout, /SKIPPED \(a delete/)
  assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`))

  const applied = await push('--sys-id', SYS_ID, '--allow-delete')
  assert.equal(applied.status, 0, applied.stderr)
  assert.ok(!instance.store.has(`sys_script_include/${SYS_ID}`), 'record should be gone')
  assert.ok(!existsSync(baselineFile()), 'the baseline should be removed with the record')
})

test('a delete is refused for a record that was never pulled', async () => {
  instance.store.set(`sys_script_include/${SYS_ID}`, {
    sys_id: SYS_ID, name: 'Someone elses', sys_updated_on: '2026-01-01 00:00:01', sys_mod_count: '3'
  })
  writeArtifact({ name: 'MyInclude', script: 'var a = 1;', description: 'first', action: 'DELETE' })

  const result = await push('--sys-id', SYS_ID, '--allow-delete')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /no usable pull baseline/)
  assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`), 'must not destroy an unpulled record')
})

test('a delete is refused for a record that drifted on the instance', async () => {
  await push('--sys-id', SYS_ID)
  const row = instance.store.get(`sys_script_include/${SYS_ID}`)
  instance.store.set(`sys_script_include/${SYS_ID}`, { ...row, sys_updated_on: '2026-09-09 09:09:09', sys_mod_count: '42' })
  writeArtifact({ name: 'MyInclude', script: 'var a = 1;', description: 'first', action: 'DELETE' })

  const result = await push('--sys-id', SYS_ID, '--allow-delete')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /changed on the instance/)
  assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`), 'must not destroy a drifted record')
})

test('a --table that contradicts the built artifact is rejected', async () => {
  const result = await push('--sys-id', SYS_ID, '--table', 'sys_script')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /does not match the built record/)
  assert.deepEqual(instance.log, [])
})

test('a sys_id with no built artifact fails with a useful message', async () => {
  const result = await push('--sys-id', 'f'.repeat(32))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /No built record found/)
})

test('one refused record does not abandon the rest of the run', async () => {
  // A second record that exists on the instance but was never pulled -> refused.
  const other = '99'.repeat(16)
  instance.store.set(`sys_script_include/${other}`, { sys_id: other, name: 'theirs', sys_updated_on: 'a', sys_mod_count: '1' })
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_script_include_${other}.xml`),
    `<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE">`
    + `<name>theirs</name><sys_id>${other}</sys_id></sys_script_include></record_update>`)

  const result = await push('--sys-id', `${other},${SYS_ID}`)
  assert.notEqual(result.status, 0, 'the run should still report failure')
  // ...but the good record was still pushed.
  assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`), 'the healthy record must still be created')
})

// --- regressions for bugs caught in review --------------------------------

test('a DELETE sibling in the same artifact does not delete THIS record', async () => {
  // One artifact file holding a DELETE for record A and an INSERT_OR_UPDATE for B.
  const deleted = '11'.repeat(16)
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_script_include_${deleted}.xml`),
    ['<record_update table="sys_script_include">',
      `  <sys_script_include action="DELETE"><sys_id>${deleted}</sys_id></sys_script_include>`,
      `  <sys_script_include action="INSERT_OR_UPDATE"><name>Survivor</name><sys_id>${SYS_ID}</sys_id></sys_script_include>`,
      '</record_update>'].join('\n'))
  rmSync(join(project, 'dist', 'app', 'update', `sys_script_include_${SYS_ID}.xml`))

  const result = await push('--sys-id', SYS_ID, '--allow-delete')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(instance.writes().map((w) => w.method), ['POST'], 'must create, never DELETE')
  assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`))
})

test('--force on a drifted record really overwrites it, not just the edited field', async () => {
  await push('--sys-id', SYS_ID)
  // Someone else edits a DIFFERENT field on the instance.
  const row = instance.store.get(`sys_script_include/${SYS_ID}`)
  instance.store.set(`sys_script_include/${SYS_ID}`,
    { ...row, description: 'THEIRS', sys_updated_on: '2026-09-09 09:09:09', sys_mod_count: '42' })
  writeArtifact({ name: 'MyInclude', script: 'var a = 3;', description: 'first' })

  const result = await push('--sys-id', SYS_ID, '--force')
  assert.equal(result.status, 0, result.stderr)
  const live = instance.store.get(`sys_script_include/${SYS_ID}`)
  assert.equal(live.description, 'first', '--force must restore the project\'s value, not keep theirs')
  assert.equal(live.script, 'var a = 3;')
})

test('a baseline pulled from a different instance is not used as the diff reference', async () => {
  await push('--sys-id', SYS_ID)
  // Rewrite the baseline as if it had been pulled from another instance.
  const baseline = JSON.parse(readFileSync(baselineFile(), 'utf8'))
  baseline.instance = 'https://someone-elses.service-now.com'
  writeFileSync(baselineFile(), JSON.stringify(baseline))
  instance.log.length = 0

  const result = await push('--sys-id', SYS_ID)
  assert.notEqual(result.status, 0, 'a foreign baseline must not silently authorise the push')
  assert.match(result.stderr + result.stdout, /pulled from https:\/\/someone-elses/)
  assert.deepEqual(instance.writes(), [])
})

test('one unbuilt sys_id does not abort the whole run', async () => {
  const missing = 'e'.repeat(32)
  const result = await push('--sys-id', `${missing},${SYS_ID}`)
  assert.notEqual(result.status, 0, 'the run should still report failure')
  assert.match(result.stderr + result.stdout, /No built record found/)
  assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`), 'the buildable record must still be pushed')
})

test('--all skips the SDK\'s own sys_module scaffolding records', async () => {
  const moduleId = '77'.repeat(16)
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_module_${moduleId}.xml`),
    '<record_update table="sys_module"><sys_module action="INSERT_OR_UPDATE">'
    + `<name>bom.json</name><sys_id>${moduleId}</sys_id></sys_module></record_update>`)

  const result = await push('--all')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!instance.store.has(`sys_module/${moduleId}`), 'build bookkeeping must not be written')
  assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`), 'the real record still goes')
  assert.match(result.stdout, /skipping the SDK's own sys_module/)
})

test('--all --include sys_module opts back in', async () => {
  const moduleId = '77'.repeat(16)
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_module_${moduleId}.xml`),
    '<record_update table="sys_module"><sys_module action="INSERT_OR_UPDATE">'
    + `<name>bom.json</name><sys_id>${moduleId}</sys_id></sys_module></record_update>`)

  const result = await push('--all', '--include', 'sys_module')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(instance.store.has(`sys_module/${moduleId}`))
})

test('a baseline filed under a different table is still found', async () => {
  // pull --table X writes X_<id>.json; the artifact may say table Y. Keying only on
  // the artifact's table made push miss it and refuse the record on every attempt.
  await push('--sys-id', SYS_ID)
  const { renameSync } = await import('node:fs')
  const dir = join(project, '.now-fluent', 'state')
  renameSync(join(dir, `sys_script_include_${SYS_ID}.json`), join(dir, `sys_ui_policy_${SYS_ID}.json`))
  writeArtifact({ name: 'MyInclude', script: 'var a = 9;', description: 'first' })

  const result = await push('--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /updated \(1 field\(s\)\)/, 'should diff against the found baseline, not refuse')
})

// Seen in a real SDK 4.12.2 build: a Flow() compiles into ONE artifact holding the flow,
// its trigger and step instances and delete_multiple directives, with active=false /
// status=draft. However it is selected — the flow, one of its steps, or --all — it is
// pushed as one unit, so a live flow that was never pulled is refused whole.
// (test/flow-push.integration.test.mjs covers pushing flows properly.)
const writeArtifactFile = (name, xml) => writeFileSync(join(project, 'dist', 'app', 'update', name), xml)

test('a live flow that was never pulled is refused as a unit, however it is selected', async () => {
  const flowId = 'f10f10f10f10f10f10f10f10f10f10f1'
  const stepId = 'a55a55a55a55a55a55a55a55a55a55a5'
  writeArtifactFile(`sys_hub_flow_${flowId}.xml`, [
    '<record_update table="sys_hub_flow">',
    `  <sys_hub_flow action="INSERT_OR_UPDATE"><sys_id>${flowId}</sys_id><active>false</active><status>draft</status><name>F</name></sys_hub_flow>`,
    `  <sys_hub_action_instance_v2 action="delete_multiple" query="flow=${flowId}^sys_idNOT IN${stepId}"/>`,
    `  <sys_hub_action_instance_v2 action="INSERT_OR_UPDATE"><sys_id>${stepId}</sys_id><flow>${flowId}</flow></sys_hub_action_instance_v2>`,
    '</record_update>'
  ].join('\n'))
  instance.store.set(`sys_hub_flow/${flowId}`, { sys_id: flowId, active: 'true', status: 'published', name: 'F',
    sys_updated_on: '2026-01-01 00:00:00', sys_mod_count: '3' })
  for (const args of [['--sys-id', flowId], ['--sys-id', stepId], ['--all', '--include', 'sys_hub_flow']]) {
    const result = await push(...args)
    assert.notEqual(result.status, 0, `push ${args.join(' ')} must fail`)
    assert.match(result.stdout + result.stderr, /pushed as one unit/)
    assert.match(result.stdout + result.stderr, /no pull baseline for it/)
  }
  assert.ok(!instance.log.some((entry) => entry.method !== 'GET'), 'nothing written')
  assert.equal(instance.store.get(`sys_hub_flow/${flowId}`).active, 'true', 'the live flow is still active')
})
