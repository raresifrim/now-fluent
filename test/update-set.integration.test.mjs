// --update-set, reproduced from live findings.
//
// The preference half of the mechanism works (it repoints and restores exactly), but a
// REST transaction resolves its OWN update set: a record written while the session was
// pointed at a named set was captured into Default. So the flag cannot promise capture
// — its job is to check where the writes really landed and say so.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { startMockInstance } from './helpers/mock-instance.mjs'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'now-fluent.mjs')
const FAKE_SDK = resolve(import.meta.dirname, 'helpers', 'fake-sdk.mjs')
const SYS_ID = 'dd12cd34ef56ab12cd34ef56ab12cd34'
const TARGET_SET = 'target00000000000000000000000001'
const run = promisify(execFile)

let project

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'now-fluent-us-'))
  mkdirSync(join(dir, 'dist', 'app', 'update'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'app', 'update', `sys_script_include_${SYS_ID}.xml`),
    ['<record_update table="sys_script_include">',
      '  <sys_script_include action="INSERT_OR_UPDATE">',
      '    <name>CaptureProbe</name>',
      '    <script><![CDATA[var CaptureProbe = Class.create();]]></script>',
      `    <sys_id>${SYS_ID}</sys_id>`,
      '    <sys_scope display_value="Global">global</sys_scope>',
      '  </sys_script_include>',
      '</record_update>'].join('\n'))
  return dir
}

function seedSets(instance) {
  instance.store.set(`sys_update_set/${TARGET_SET}`,
    { sys_id: TARGET_SET, name: 'NowFluent Push Test Set', state: 'in progress' })
  instance.store.set('sys_update_set/default-set',
    { sys_id: 'default-set', name: 'Default', state: 'in progress' })
  instance.store.set('sys_user_preference/pref1',
    { sys_id: 'pref1', name: 'sys_update_set', user: 'user0000000000000000000000000001', value: 'default-set' })
}

async function push(instance, ...args) {
  try {
    const { stdout, stderr } = await run(process.execPath,
      [CLI, 'push', '--project', project, '--auth', 'test', '--sys-id', SYS_ID, ...args], {
        encoding: 'utf8',
        env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
      })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

beforeEach(() => { project = makeProject() })

test('reports the mismatch and fails when capture ignores the preference', async () => {
  const instance = await startMockInstance()   // capture always goes to Default
  try {
    seedSets(instance)
    const result = await push(instance, '--update-set', 'NowFluent Push Test Set')

    assert.notEqual(result.status, 0, 'a wrong-set capture must not pass as success')
    const output = result.stdout + result.stderr
    assert.match(output, /did NOT land in "NowFluent Push Test Set"/)
    assert.match(output, /-> Default/, 'should name where it actually went')
    // ...and the record itself was still written.
    assert.ok(instance.store.has(`sys_script_include/${SYS_ID}`))
  } finally { await instance.stop() }
})

test('restores the previous update set preference even so', async () => {
  const instance = await startMockInstance()
  try {
    seedSets(instance)
    await push(instance, '--update-set', 'NowFluent Push Test Set')
    assert.equal(instance.store.get('sys_user_preference/pref1').value, 'default-set',
      'the account preference must be put back')
  } finally { await instance.stop() }
})

test('the restore still happens when the capture check itself fails', async () => {
  // A check that throws must not cost the user their update set preference — that was
  // a real bug: one shared try block meant a failed verification skipped the restore.
  const instance = await startMockInstance()
  try {
    seedSets(instance)
    const realQuery = instance.store.get.bind(instance.store)
    // Make the sys_update_xml lookup blow up by removing the sets it needs to name.
    instance.store.delete('sys_update_set/default-set')
    void realQuery
    const result = await push(instance, '--update-set', 'NowFluent Push Test Set')
    assert.notEqual(result.status, 0)
    assert.equal(instance.store.get('sys_user_preference/pref1').value, 'default-set',
      'preference restored regardless')
  } finally { await instance.stop() }
})

test('confirms success when capture DOES follow the preference', async () => {
  // Guards must not cry wolf on an instance that behaves as originally assumed.
  const instance = await startMockInstance({ captureFollowsPreference: true })
  try {
    seedSets(instance)
    const result = await push(instance, '--update-set', 'NowFluent Push Test Set')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /landed in "NowFluent Push Test Set" as asked/)
    assert.equal(instance.store.get('sys_user_preference/pref1').value, 'default-set')
  } finally { await instance.stop() }
})

test('refuses an update set that is not in progress', async () => {
  const instance = await startMockInstance()
  try {
    seedSets(instance)
    instance.store.set(`sys_update_set/${TARGET_SET}`,
      { sys_id: TARGET_SET, name: 'NowFluent Push Test Set', state: 'complete' })
    const result = await push(instance, '--update-set', 'NowFluent Push Test Set')
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /is complete, not "in progress"/)
    assert.ok(!instance.store.has(`sys_script_include/${SYS_ID}`), 'nothing should be written')
  } finally { await instance.stop() }
})
