// Pushing a Workflow Automation flow. Uses REAL SDK 4.12.2 build output (see
// test/fixtures/real-sdk-build/flow): one artifact per flow holding the flow, its trigger
// and step instances and delete_multiple directives, with active=false / status=draft —
// install activates flows afterwards through api/now/wfa_fluent/activate_flows.
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

test('a new flow is created as ONE unit — flow, trigger and step — in the project scope, then activated', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /flow "NowFluent Flow Demo": 3 record\(s\), 3 delete_multiple directive\(s\), pushed as one unit/)
    assert.match(result.output, /created in x_push_demo: 3 record\(s\) written, 0 removed, activated \(active=true, status=published\)/)

    const posts = flowWrites(instance).filter((w) => w.method === 'POST')
    assert.deepEqual(posts.map((w) => w.table), ['sys_hub_flow', 'sys_hub_trigger_instance_v2', 'sys_hub_action_instance_v2'],
      'flow first, then its parts, in document order')
    for (const w of posts) assert.equal(w.params.sysparm_transaction_scope, APP, `${w.table} runs as the app`)
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
    assert.equal(flowWrites(instance).filter((w) => w.method === 'POST').length, 3)

    const again = await push(instance, '--sys-id', STEP)
    assert.equal(again.status, 0, again.output)
    assert.match(again.output, /pushed as one unit/)
    assert.match(again.output, /unchanged/, 'nothing changed since the last push')
  }))

test('--dry-run lists every write and the activation, and sends nothing', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW, '--dry-run')
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /would POST sys_hub_flow 21d91be4/)
    assert.match(result.output, /would POST sys_hub_action_instance_v2 a37ab71e/)
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
    assert.ok(flowWrites(instance).some((w) => w.method === 'POST' && w.sysId === undefined && w.body.sys_id === STEP2))
    const rootPut = flowWrites(instance).find((w) => w.method === 'PUT' && w.table === 'sys_hub_flow')
    if (rootPut) {
      assert.ok(!('active' in rootPut.body) && !('status' in rootPut.body),
        "the build's active=false/status=draft is never sent to a live flow")
    }
    assert.equal(activations(instance).length, 1, 're-activated so the change takes effect')
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'true')

    build('one-step')
    instance.log.length = 0
    const removed = await push(instance, '--sys-id', FLOW)
    assert.equal(removed.status, 0, removed.output)
    assert.match(removed.output, /1 removed/)
    assert.ok(!instance.store.has(`sys_hub_action_instance_v2/${STEP2}`), 'the removed step is gone')
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP}`), 'the remaining step is untouched')
    const del = instance.writes().find((w) => w.method === 'DELETE')
    assert.equal(del.params.sysparm_transaction_scope, APP)
  }))

test('a flow changed on the instance since the pull is refused before anything is written', () =>
  withInstance({}, async (instance) => {
    assert.equal((await push(instance, '--sys-id', FLOW)).status, 0)
    instance.store.get(`sys_hub_flow/${FLOW}`).sys_mod_count = '42'
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
    assert.match(kept.output, /inactive \(--activate to activate it\)/)
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
    assert.match(result.output, /3 record\(s\) written and 0 removed, but NOT activated: this instance has no flow activation endpoint/)
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

test('a flow in a Global project is created as Global, with no probe', () =>
  withInstance({}, async (instance) => {
    writeFileSync(join(project, 'now.config.json'), JSON.stringify({ scope: 'global', scopeId: 'global', name: 'G' }))
    const file = join(project, 'dist', 'app', 'update', `sys_hub_flow_${FLOW}.xml`)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/<sys_scope display_value="x_push_demo">[0-9a-f]{32}<\/sys_scope>/g,
      '<sys_scope display_value="Global">global</sys_scope>'))
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    assert.ok(!/Checking once/.test(result.output), 'no probe')
    assert.ok(flowWrites(instance).every((w) => w.params.sysparm_transaction_scope === 'global'))
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

    build('two-steps')
    instance.log.length = 0
    const pushed = await push(instance, '--sys-id', FLOW)
    assert.equal(pushed.status, 0, pushed.output)
    assert.ok(instance.store.has(`sys_hub_action_instance_v2/${STEP2}`))
    assert.equal(instance.store.get(`sys_hub_flow/${FLOW}`).active, 'true')
  }))

test('compressed flow fields are sent decompressed — the Table API takes the value, not the stored gzip', () =>
  withInstance({}, async (instance) => {
    const result = await push(instance, '--sys-id', FLOW)
    assert.equal(result.status, 0, result.output)
    const trigger = flowWrites(instance).find((w) => w.table === 'sys_hub_trigger_instance_v2' && w.method === 'POST')
    const step = flowWrites(instance).find((w) => w.table === 'sys_hub_action_instance_v2' && w.method === 'POST')
    assert.ok(!trigger.body.trigger_inputs.startsWith('H4sI'), 'trigger_inputs is not the gzip form')
    assert.ok(Array.isArray(JSON.parse(trigger.body.trigger_inputs)), 'it is the JSON the build compressed')
    assert.ok(!step.body.values.startsWith('H4sI'))
    assert.match(step.body.values, /NowFluent flow demo saw/)
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
