// Pushing a Workflow Automation flow. Uses REAL SDK 4.12.2 build output (see
// test/fixtures/real-sdk-build/flow): one artifact per flow holding the flow, its trigger
// and step instances and delete_multiple directives, with active=false / status=draft —
// install activates flows afterwards through api/now/wfa_fluent/activate_flows.
// push writes the artifact the way install does for a configuration project: through the
// SDK's loader (POST api/fluent/load/<scope>), never record by record — seen live, rows
// written through the Table API leave a flow Flow Designer shows as empty.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { startMockInstance } from './helpers/mock-instance.mjs'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'now-fluent.mjs')
const FAKE_SDK = resolve(import.meta.dirname, 'helpers', 'fake-sdk.mjs')
const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'real-sdk-build', 'flow')
const APP = 'e5d61884beaf441ebd67932b798cb00b' // x_push_demo, the scope the fixtures were built in
const FLOW = '21d91be40ad84dc9975a24bd4d5edf93'
const TRIGGER = 'e25c3a8ddd3e4a6b903a450d3e99bafc'
const STEP = 'a37ab71ef1d14fa19f2c24f46dec4a3b'
const STEP2 = '01e2e79243d24b38bba03274e4a48109' // only in two-steps.xml
const run = promisify(execFile)

let project

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'now-fluent-flow-'))
  writeFileSync(join(project, 'now.config.json'), JSON.stringify({ scope: 'x_push_demo', scopeId: APP, name: 'Push Demo' }))
  build('one-step')
})

// Stand in for `now-sdk build`: put a real build's flow artifact where push reads it.
function build(version) {
  mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
  copyFileSync(join(FIXTURES, `${version}.xml`), join(project, 'dist', 'app', 'update', `sys_hub_flow_${FLOW}.xml`))
}

async function push(instance, ...args) {
  try {
    const { stdout, stderr } = await run(process.execPath,
      [CLI, 'push', '--project', project, '--auth', 'test', '--no-build', ...args], {
        encoding: 'utf8',
        env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
      })
    return { status: 0, output: stdout + stderr }
  } catch (error) {
    return { status: error.code ?? 1, output: (error.stdout ?? '') + (error.stderr ?? '') }
  }
}

async function withInstance(options, body) {
  const instance = await startMockInstance({ honoursTransactionScope: true, ...options })
  instance.store.set(`sys_scope/${APP}`, { sys_id: APP, scope: 'x_push_demo', name: 'Push Demo' })
  try { await body(instance) } finally { await instance.stop() }
}

const flowWrites = (instance) => instance.writes().filter((w) => w.table && w.table.startsWith('sys_hub_'))
const activations = (instance) => instance.log.filter((e) => e.table === 'activate_flows')
const loads = (instance) => instance.log.filter((e) => e.table === 'fluent_load')

test('a new flow is LOADED as one unit — the artifact as built, through api/fluent/load as the app — then activated', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /flow "NowFluent Flow Demo": 3 record\(s\), 3 delete_multiple directive\(s\), pushed as one unit/)
    assert.match(result.output, /created in x_push_demo: 3 record\(s\) loaded, 0 removed, captured in update set \(loadset0+1\), activated \(active=true, status=published\)/)

    assert.deepEqual(flowWrites(instance), [], 'no record is written through the Table API')
    const [load] = loads(instance)
    assert.equal(load.sysId, APP, 'loaded as the app, like install')
    assert.ok(load.body.includes(readFileSync(join(FIXTURES, 'one-step.xml'), 'utf8').match(/<sys_hub_trigger_instance_v2[\s\S]*?<\/sys_hub_trigger_instance_v2>/)[0]),
      'the artifact goes up as built')
    assert.equal(instance.store.get(`sys_hub_action_instance_v2/${STEP}`).flow, FLOW)

    const [activation] = activations(instance)
    assert.deepEqual(activation.body, { flows: [{ sys_id: FLOW, active: '', state: '' }], actions: [] })
    assert.equal(activation.params.sysparm_transaction_scope, APP, 'activated as the app, like install')
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'true')

    for (const [table, id] of [['sys_hub_flow', FLOW], ['sys_hub_trigger_instance_v2', TRIGGER], ['sys_hub_action_instance_v2', STEP]]) {
      assert.ok(existsSync(join(project, '.now-fluent', 'state', `${table}_${id}.json`)), `${table} has a baseline`)
    }
  }))

test('naming one of its steps, or --all, pushes the whole flow — once', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--all')
    assert.equal(result.status, 0, result.output)
    assert.equal(result.output.match(/pushed as one unit/g).length, 1, 'three records, one unit')
    assert.equal(loads(instance).length, 1)

    const again = await push(instance, '--sys-id', STEP)
    assert.equal(again.status, 0, again.output)
    assert.match(again.output, /pushed as one unit/)
    assert.match(again.output, /unchanged/, 'nothing changed since the last push')
    assert.equal(loads(instance).length, 1, 'an unchanged flow is not loaded again')
  }))

test('--dry-run lists every change, the load and the activation, and sends nothing', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW, '--dry-run')
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /would create sys_hub_flow 21d91be4/)
    assert.match(result.output, /would create sys_hub_action_instance_v2 a37ab71e/)
    assert.match(result.output, new RegExp(`by loading the whole artifact as x_push_demo \\(POST .*/api/fluent/load/${APP}, as install does\\)`))
    assert.match(result.output, /then activate it \(POST .*\/api\/now\/wfa_fluent\/activate_flows\)/)
    assert.deepEqual(instance.writes(), [])
  }))

test('editing a live flow: a step added then removed — the removal goes through delete_multiple, the flow stays on', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)

    build('two-steps')
    instance.log.length = 0
    const added = await push(instance, '--sys-id', FLOW)
    assert.equal(added.status, 0, added.output)
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP2}`), 'the new step exists')
    assert.equal(loads(instance).length, 1)
    assert.equal(activations(instance).length, 1, 're-activated so the change takes effect, like install')
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'true')

    build('one-step')
    instance.log.length = 0
    const removed = await push(instance, '--sys-id', FLOW)
    assert.equal(removed.status, 0, removed.output)
    assert.match(removed.output, /1 removed/)
    assert.ok(!instance.store.has(`sys_hub_action_instance_v2/${STEP2}`), 'the removed step is gone')
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP}`), 'the remaining step is untouched')
    assert.ok(!existsSync(join(project, '.now-fluent', 'state', `sys_hub_action_instance_v2_${STEP2}.json`)),
      'the removed step has no baseline left')
    assert.deepEqual(flowWrites(instance), [], 'the loader removed it, not a Table API DELETE')
  }))

test('a flow changed on the instance since the pull is refused before anything is written', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    Object.assign(instance.store.get(`sys_hub_flow/${FLOW}`), { name: 'Renamed in Flow Designer', sys_mod_count: '42' })
    build('two-steps')
    instance.log.length = 0
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /changed on the instance since you pulled it/)
    assert.deepEqual(instance.writes(), [])
  }))

test('an existing flow with no baseline is refused (nothing to tell your edits from someone else\'s)', () =>
  withInstance({}, async (instance) => {
    instance.store.set(`sys_hub_flow/${FLOW}`, { sys_id: FLOW, sys_scope: APP, active: 'true', status: 'published',
      name: 'NowFluent Flow Demo', sys_updated_on: '2026-01-01 00:00:00', sys_mod_count: '7' })
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /no pull baseline for it/)
    assert.deepEqual(instance.writes(), [])
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'true', 'the live flow is still on')
  }))

test('an inactive flow stays inactive unless --activate', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    const row = instance.store.get(`sys_hub_flow/${FLOW}`)
    row.active = 'false'
    row.status = 'draft'
    // re-baseline as if pulled in this state
    const stateFile = join(project, '.now-fluent', 'state', `sys_hub_flow_${FLOW}.json`)
    const baseline = JSON.parse(readFileSync(stateFile, 'utf8'))
    baseline.fields.active = 'false'
    writeFileSync(stateFile, JSON.stringify(baseline))

    build('two-steps')
    instance.log.length = 0
    const kept = await push(instance, '--sys-id', FLOW)
    assert.equal(kept.status, 0, kept.output)
    assert.match(kept.output, /saved as an inactive draft, as it was \(--activate to activate it\)/)
    assert.equal(activations(instance).length, 0)
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'false')

    const forced = await push(instance, '--sys-id', FLOW, '--activate')
    assert.equal(forced.status, 0, forced.output)
    assert.equal(activations(instance).length, 1)
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'true')
  }))

test('an instance without the activation endpoint: written, reported NOT activated, non-zero exit', () =>
  withInstance({ flowActivation: 'missing' }, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /3 record\(s\) loaded and 0 removed, .*but NOT activated: this instance has no flow activation endpoint/)
    assert.ok(instance.store.has(`sys_hub_flow/${FLOW}`))
  }))

test('a failed activation is reported with the reason', () =>
  withInstance({ flowActivation: 'fail' }, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /NOT activated/)
  }))

test('a delete_multiple directive that does not name this flow is refused before any write', () =>
  withInstance({}, async (instance) => {
    const file = join(project, 'dist', 'app', 'update', `sys_hub_flow_${FLOW}.xml`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('</record_update>',
      '  <sys_hub_action_instance_v2 action="delete_multiple" query="active=true"/>\n</record_update>'))
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /does not name this flow or any of its records, so it is not trusted/)
    assert.deepEqual(instance.writes(), [])
  }))

test('a directive matching more than 50 records is refused before any write', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    for (let i = 0; i < 51; i++) {
      const id = `bad${String(i).padStart(29, '0')}`
      instance.store.set(`sys_hub_action_instance_v2/${id}`, { sys_id: id, flow: FLOW })
    }
    build('two-steps')
    instance.log.length = 0
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /matches more than 50 records/)
    assert.deepEqual(instance.writes(), [])
  }))

test('the separate DELETE the build writes for a removed step is skipped; deleting a whole flow is refused', () =>
  withInstance({}, async (instance) => {
    const deletions = join(project, 'dist', 'app', 'author_elective_update')
    mkdirSync(deletions, { recursive: true })
    writeFileSync(join(deletions, `sys_hub_action_instance_v2_${STEP2}.xml`),
      `<record_update table="sys_hub_action_instance_v2"><sys_hub_action_instance_v2 action="DELETE"><sys_id>${STEP2}</sys_id></sys_hub_action_instance_v2></record_update>`)
    const step = await push(instance, '--sys-id', STEP2, '--allow-delete')
    assert.equal(step.status, 0, step.output)
    assert.match(step.output, /SKIPPED \(a removed flow step: pushing its flow removes it/)

    const gone = 'deadbeefdeadbeefdeadbeefdeadbeef'
    writeFileSync(join(deletions, `sys_hub_flow_${gone}.xml`),
      `<record_update table="sys_hub_flow"><sys_hub_flow action="DELETE"><sys_id>${gone}</sys_id></sys_hub_flow></record_update>`)
    const flow = await push(instance, '--sys-id', gone, '--allow-delete')
    assert.notEqual(flow.status, 0)
    assert.match(flow.output, /does not delete a whole flow or action/)
    assert.deepEqual(instance.writes(), [])
  }))

test('a flow in a Global project is loaded as Global, with no probe', () =>
  withInstance({}, async (instance) => {
    writeFileSync(join(project, 'now.config.json'), JSON.stringify({ scope: 'global', scopeId: 'global', name: 'G' }))
    const file = join(project, 'dist', 'app', 'update', `sys_hub_flow_${FLOW}.xml`)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/<sys_scope display_value="x_push_demo">[0-9a-f]{32}<\/sys_scope>/g,
      '<sys_scope display_value="Global">global</sys_scope>'))
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    assert.ok(!/Checking once/.test(result.output), 'no probe')
    assert.deepEqual(loads(instance).map((l) => l.sysId), ['global'])
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).sys_scope, 'global')
  }))

async function pull(instance, ...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, 'pull', '--project', project, '--auth', 'test', ...args], {
      encoding: 'utf8',
      env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
    })
    return { status: 0, output: stdout + stderr }
  } catch (error) {
    return { status: error.code ?? 1, output: (error.stdout ?? '') + (error.stderr ?? '') }
  }
}

test('pull takes a flow through the online transform (the query path cannot rebuild a graph), then push edits it', () =>
  withInstance({}, async (instance) => {
    // An existing, active flow on the instance, as the one-step build would have created it.
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    const { rmSync } = await import('node:fs')
    rmSync(join(project, '.now-fluent'), { recursive: true, force: true }) // a fresh checkout: no baselines

    const pulled = await pull(instance, '--table', 'sys_hub_flow', '--sys-id', FLOW)
    assert.equal(pulled.status, 0, pulled.output)
    assert.match(pulled.output, /graphs the query path cannot rebuild — importing them through the online transform/)
    assert.match(pulled.output, /transform --auth test --table sys_hub_flow --id 21d91be4/)
    assert.ok(existsSync(join(project, '.now-fluent', 'state', `sys_hub_flow_${FLOW}.json`)), 'the flow has a baseline')
    for (const [table, id] of [['sys_hub_trigger_instance_v2', TRIGGER], ['sys_hub_action_instance_v2', STEP]]) {
      assert.ok(existsSync(join(project, '.now-fluent', 'state', `${table}_${id}.json`)), `${table} (a part of the flow) has a baseline`)
    }
    assert.match(pulled.output, /baseline recorded \(part of flow 21d91be4/)

    build('two-steps')
    instance.log.length = 0
    const pushed = await push(instance, '--sys-id', FLOW)
    assert.equal(pushed.status, 0, pushed.output)
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP2}`))
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'true')
  }))

test('compressed flow fields go up exactly as built (gzip+base64, as a Flow Designer trigger stores them)', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    assert.match(loads(instance)[0].body, /<trigger_inputs>H4sI/)
    assert.ok(instance.store.get(`sys_hub_trigger_instance_v2/${TRIGGER}`).trigger_inputs.startsWith('H4sI'))
    assert.ok(instance.store.get(`sys_hub_action_instance_v2/${STEP}`).values.startsWith('H4sI'))
  }))

test('a failed activation says why, and the NEXT push is not refused as drift (seen live)', () =>
  withInstance({ flowActivation: 'fail' }, async (instance) => {
    const first = await push(instance, '--sys-id', FLOW)
    assert.notEqual(first.status, 0)
    assert.match(first.output, /NOT activated: PUBLISH_FAILED: Error publishing flow sys id .*No Trigger instance found/)
    assert.doesNotMatch(first.output, /\{"result"/, 'the reason, not the raw JSON')

    build('two-steps')
    const second = await push(instance, '--sys-id', FLOW)
    assert.doesNotMatch(second.output, /changed on the instance since you pulled it/,
      'our own failed activation attempt is not someone else\'s drift')
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP2}`), 'the edit was written')
  }))

test('an instance without the loader endpoint: refused, and nothing is written record by record', () =>
  withInstance({ fluentLoad: 'missing' }, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /REFUSED: this instance has no XML load endpoint \(api\/fluent\/load/)
    assert.match(result.output, /Flow Designer shows the flow empty/)
    assert.deepEqual(flowWrites(instance), [])
    assert.equal(activations(instance).length, 0)
    assert.ok(!instance.store.has(`sys_hub_flow/${FLOW}`))
  }))

test('--update-set is handed to the loader, which captures the flow there', () =>
  withInstance({}, async (instance) => {
    const SET = '5e7000000000000000000000000000a1'
    instance.store.set(`sys_update_set/${SET}`, { sys_id: SET, name: 'Flow work', state: 'in progress' })
    const result = await push(instance, '--sys-id', FLOW, '--update-set', SET)
    assert.equal(result.status, 0, result.output)
    assert.equal(loads(instance)[0].params.targetUpdateSetId, SET)
    assert.match(result.output, new RegExp(`captured in update set "Flow work" \\(${SET}\\)`))
  }))

test('--target-scope global creates a flow built in the project scope in Global: the payload names Global', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW, '--target-scope', 'global')
    assert.equal(result.status, 0, result.output)
    const [load] = loads(instance)
    assert.equal(load.sysId, 'global')
    assert.doesNotMatch(load.body, new RegExp(`<sys_scope[^>]*>${APP}<`), 'no record still names the app')
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).sys_scope, 'global')
    assert.equal(instance.store.get(`sys_hub_action_instance_v2/${STEP}`).sys_scope, 'global')
  }))

test('activation rewrites the trigger (seen live); every part is re-baselined, so the next edit is not refused as drift', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    assert.equal(instance.store.get(`sys_hub_trigger_instance_v2/${TRIGGER}`).sys_mod_count, '1', 'the mock models it')
    build('two-steps')
    const edited = await push(instance, '--sys-id', FLOW)
    assert.equal(edited.status, 0, edited.output)
    assert.doesNotMatch(edited.output, /changed on the instance/)
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP2}`))
  }))

test('a step changed on the instance is refused, naming the fields that changed', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    const step = instance.store.get(`sys_hub_action_instance_v2/${STEP}`)
    step.comment = 'edited in Flow Designer'
    step.sys_mod_count = String(Number(step.sys_mod_count) + 1)
    build('two-steps')
    instance.log.length = 0
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /sys_hub_action_instance_v2 a37ab71e\S* \(part of this flow\) changed on the instance since you pulled it \(comment\)/)
    assert.equal(loads(instance).length, 0)
  }))

// A flow pulled back through the online transform builds with DELETE records inside its
// artifact (seen live): records on the instance that the regenerated source no longer has.
const INPUT = 'f1a0000000000000000000000000beef'
function withDeleteRecord() {
  const file = join(project, 'dist', 'app', 'update', `sys_hub_flow_${FLOW}.xml`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('</record_update>',
    `  <sys_hub_flow_input action="DELETE"><sys_id>${INPUT}</sys_id><model>${FLOW}</model></sys_hub_flow_input>\n</record_update>`))
}

test('DELETE records inside a flow artifact are left in place by default — named, and not sent to the loader', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    instance.store.set(`sys_hub_flow_input/${INPUT}`, { sys_id: INPUT, model: FLOW, sys_mod_count: '0', sys_updated_on: 'x' })
    build('two-steps')
    withDeleteRecord()
    instance.log.length = 0
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, new RegExp(`left in place: 1 record\\(s\\) the source no longer has \\(sys_hub_flow_input ${INPUT}\\) — --allow-delete removes them`))
    assert.doesNotMatch(loads(instance)[0].body, /action="DELETE"/)
    assert.ok(instance.store.has(`sys_hub_flow_input/${INPUT}`))
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP2}`), 'the rest of the edit was loaded')
  }))

test('--allow-delete loads a DELETE record only with an unchanged baseline, and checks it is gone', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    instance.store.set(`sys_hub_flow_input/${INPUT}`, { sys_id: INPUT, model: FLOW, sys_mod_count: '0', sys_updated_on: 'x' })
    build('two-steps')
    withDeleteRecord()
    instance.log.length = 0
    const unpulled = await push(instance, '--sys-id', FLOW, '--allow-delete')
    assert.notEqual(unpulled.status, 0)
    assert.match(unpulled.output, /deletes sys_hub_flow_input f1a0\S+, which this project has no pull baseline for/)
    assert.deepEqual(instance.writes(), [])

    const stateDir = join(project, '.now-fluent', 'state')
    writeFileSync(join(stateDir, `sys_hub_flow_input_${INPUT}.json`), JSON.stringify({ table: 'sys_hub_flow_input', sysId: INPUT,
      instance: instance.origin, sys_updated_on: 'x', sys_mod_count: '0', fields: instance.store.get(`sys_hub_flow_input/${INPUT}`) }))
    const dry = await push(instance, '--sys-id', FLOW, '--allow-delete', '--dry-run')
    assert.match(dry.output, new RegExp(`would delete sys_hub_flow_input ${INPUT}`))
    const result = await push(instance, '--sys-id', FLOW, '--allow-delete')
    assert.equal(result.status, 0, result.output)
    assert.match(loads(instance)[0].body, /<sys_hub_flow_input action="DELETE">/)
    assert.ok(!instance.store.has(`sys_hub_flow_input/${INPUT}`))
    assert.ok(!existsSync(join(stateDir, `sys_hub_flow_input_${INPUT}.json`)), 'its baseline is gone too')
  }))

test('the platform changing a field the source does not model (compiled_snapshot, seen live) is not drift', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    // After activation the platform recompiles and stamps the step on its own.
    const step = instance.store.get(`sys_hub_action_instance_v2/${STEP}`)
    step.compiled_snapshot = 'f94d0c1583238710b4529c50ceaad3cc'
    step.sys_mod_count = String(Number(step.sys_mod_count) + 1)
    step.sys_updated_on = '2026-01-01 00:59:59'
    const flow = instance.store.get(`sys_hub_flow/${FLOW}`)
    flow.latest_snapshot = '446d405583238710b4529c50ceaad3c2'
    flow.sys_mod_count = String(Number(flow.sys_mod_count) + 1)
    build('two-steps')
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    assert.doesNotMatch(result.output, /changed on the instance/)
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP2}`))
  }))

test('a real edit to a modelled field of the flow is still drift, and named', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    const flow = instance.store.get(`sys_hub_flow/${FLOW}`)
    flow.description = 'changed on the instance'
    flow.sys_mod_count = String(Number(flow.sys_mod_count) + 1)
    build('two-steps')
    instance.log.length = 0
    const result = await push(instance, '--sys-id', FLOW)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /the flow changed on the instance since you pulled it \(description\)/)
    assert.equal(loads(instance).length, 0)
  }))

test('pull removes the snapshot XML the SDK transform leaves in metadata/ (and a built copy), and only that flow\'s', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    const other = 'abcdefabcdefabcdefabcdefabcdef12'
    const otherFile = join(project, 'metadata', 'update', `sys_hub_flow_snapshot_${other}.xml`)
    const builtCopy = join(project, 'dist', 'app', 'update', `sys_hub_flow_snapshot_5a${FLOW.slice(2)}.xml`)
    mkdirSync(join(project, 'metadata', 'update'), { recursive: true })
    writeFileSync(otherFile, `<record_update><sys_hub_flow_snapshot><parent_flow>${'f'.repeat(32)}</parent_flow></sys_hub_flow_snapshot></record_update>`)
    writeFileSync(builtCopy, `<record_update><sys_hub_flow_snapshot><parent_flow>${FLOW}</parent_flow></sys_hub_flow_snapshot></record_update>`)

    const pulled = await pull(instance, '--table', 'sys_hub_flow', '--sys-id', FLOW)
    assert.equal(pulled.status, 0, pulled.output)
    assert.match(pulled.output, /removed the snapshot XML the SDK left for the build/)
    assert.ok(!existsSync(join(project, 'metadata', 'update', `sys_hub_flow_snapshot_5a${FLOW.slice(2)}.xml`)), 'the transform\'s copy is gone')
    assert.ok(!existsSync(builtCopy), 'and the copy an earlier build made')
    assert.ok(existsSync(otherFile), 'another flow\'s snapshot is not touched')
  }))
