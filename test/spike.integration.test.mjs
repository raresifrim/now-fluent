// The Phase 0 spike's VERDICT is itself load-bearing: people act on its exit code.
//
// It asks two kinds of question. A LOAD-BEARING one failing means push is unsafe; a
// CAPABILITY "no" is a platform fact push adapts to. Live runs showed why the split
// matters: sys_scope is ignored and capture cannot be steered on a stock instance, and
// when those counted as failures every run exited 1 — on facts push already handles.
// A permanent false red teaches you to ignore the exit code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

import { startMockInstance } from './helpers/mock-instance.mjs'

const SPIKE = resolve(import.meta.dirname, '..', 'scripts', 'verify-push.mjs')
const FAKE_SDK = resolve(import.meta.dirname, 'helpers', 'fake-sdk.mjs')
const run = promisify(execFile)

async function spike(options, ...args) {
  const instance = await startMockInstance(options)
  instance.store.set('sys_scope/5ca1bcb3733320103e366238edf6a706',
    { sys_id: '5ca1bcb3733320103e366238edf6a706', scope: 'sn_sow', name: 'Service Operations Workspace Core' })
  try {
    const { stdout, stderr } = await run(process.execPath, [SPIKE, '--auth', 'test', ...args], {
      encoding: 'utf8',
      env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
    })
    return { status: 0, output: stdout + stderr, instance }
  } catch (error) {
    return { status: error.code ?? 1, output: (error.stdout ?? '') + (error.stderr ?? ''), instance }
  } finally {
    await instance.stop()
  }
}

test('an instance like the live one passes, reporting its capabilities as answers', async () => {
  // Inert sys_scope and unsteerable capture — exactly what live testing found.
  const { status, output } = await spike({}, '--scope', 'sn_sow')
  assert.equal(status, 0, 'capability "no"s must not fail the run')
  assert.match(output, /LOAD-BEARING — push is unsafe if any fail: (\d+)\/\1 hold/)
  assert.match(output, /NO {3}\[scope:sn_sow\] sys_scope on a write is honoured/)
  // Like the live instance: the body's sys_scope AND the transaction scope are ignored —
  // and the scope line must not contradict the transaction-scope line.
  assert.match(output, /running the create AS the application does not help either/,
    'each "no" should say what push does about it, consistently')
  assert.match(output, /NO {3}the session update set preference steers capture/)
  assert.match(output, /push is safe against this instance/)
})

test('a PUT that REPLACES instead of merging fails the run', async () => {
  // The one platform behaviour that would make push's partial updates destroy data.
  const { status, output } = await spike({ putReplaces: true })
  assert.equal(status, 1, 'a broken load-bearing assumption must exit non-zero')
  assert.match(output, /FAILED: \[global\] PUT merges/)
  assert.match(output, /push is NOT safe against this instance/)
})

test('an instance that honours everything reports yes across the board', async () => {
  const { status, output } = await spike({ honoursScope: true, captureFollowsPreference: true }, '--scope', 'sn_sow')
  assert.equal(status, 0)
  assert.match(output, /yes {2}\[scope:sn_sow\] sys_scope on a write is honoured/)
  assert.match(output, /yes {2}the session update set preference steers capture/)
})

test('the spike cleans up every record it created', async () => {
  const { instance } = await spike({}, '--scope', 'sn_sow')
  const leftovers = [...instance.store.keys()].filter((key) =>
    key.startsWith('sys_script_include/') || key.startsWith('sys_update_set/'))
  assert.deepEqual(leftovers, [], 'throwaway records must be deleted')
})

test('the spike reports whether a create can run AS the scope, and cleans that record up', async () => {
  const honoured = await spike({ honoursTransactionScope: true }, '--scope', 'sn_sow')
  assert.equal(honoured.status, 0)
  assert.match(honoured.output, /yes {2}\[scope:sn_sow\] a create run AS sn_sow \(sysparm_transaction_scope\) lands in it/)
  assert.match(honoured.output, /running the create AS the application works/, 'and the scope line agrees')

  const ignored = await spike({}, '--scope', 'sn_sow')
  assert.equal(ignored.status, 0, 'a capability "no", not a failure')
  assert.match(ignored.output, /NO {3}\[scope:sn_sow\] a create run AS sn_sow/)
  assert.match(ignored.output, /push cannot create records in a project's own scope here/)
  const leftovers = [...ignored.instance.store.keys()].filter((key) => key.startsWith('sys_script_include/'))
  assert.deepEqual(leftovers, [], 'the probe record is deleted too')
})

test('an app that refuses deletes from Global (seen live in sn_sow): the record is deleted AS the app', async () => {
  const { status, output, instance } = await spike({ honoursTransactionScope: true, protectedFromGlobal: true }, '--scope', 'sn_sow')
  assert.equal(status, 0, output)
  assert.match(output, /yes {2}\[scope:sn_sow\] a record created AS sn_sow can be deleted again/)
  assert.doesNotMatch(output, /COULD NOT DELETE/)
  const leftovers = [...instance.store.keys()].filter((key) => key.startsWith('sys_script_include/'))
  assert.deepEqual(leftovers, [])
})

test('a record created AS the app that cannot be deleted at all is reported, with what push does about it', async () => {
  const { status, output } = await spike({ honoursTransactionScope: true, undeletableScopes: ['5ca1bcb3733320103e366238edf6a706'] },
    '--scope', 'sn_sow')
  assert.equal(status, 0, 'a capability "no", not a failure')
  assert.match(output, /NO {3}\[scope:sn_sow\] a record created AS sn_sow can be deleted again/)
  assert.match(output, /push could not clean up its own scope probe here/)
  assert.match(output, /COULD NOT DELETE [\s\S]*? sys_script_include [0-9a-f]{32}/, 'and cleanup names the leftover')
})
