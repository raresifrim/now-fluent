// The scope story, reproduced from live findings on a real instance.
//
// sys_scope is INERT on a Table API write: the platform puts the record in the scope
// the REST transaction runs in (Global) and rewrites api_name to match. Before these
// guards existed, push reported "created (13 field(s))" while the record silently
// landed in the wrong scope with a rewritten api_name — project and instance
// disagreeing, with no warning. These tests pin the guards that make that loud.
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
const SYS_ID = 'cc12cd34ef56ab12cd34ef56ab12cd34'
const APP_SCOPE = 'e5d61884beaf441ebd67932b798cb00b'
const run = promisify(execFile)

let instance
let project

before(async () => { instance = await startMockInstance() })
after(async () => { await instance.stop() })

beforeEach(() => {
  instance.store.clear()
  instance.log.length = 0
  project = mkdtempSync(join(tmpdir(), 'now-fluent-scope-'))
  mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
  writeScoped(APP_SCOPE)
})

function writeScoped(scope) {
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_script_include_${SYS_ID}.xml`),
    ['<record_update table="sys_script_include">',
      '  <sys_script_include action="INSERT_OR_UPDATE" apply_defaults="true">',
      '    <active>true</active>',
      '    <api_name>x_push_demo.NowFluentBrandNew</api_name>',
      '    <name>NowFluentBrandNew</name>',
      '    <script><![CDATA[var NowFluentBrandNew = Class.create();]]></script>',
      `    <sys_id>${SYS_ID}</sys_id>`,
      `    <sys_scope display_value="x_push_demo">${scope}</sys_scope>`,
      '  </sys_script_include>'].join('\n') + '\n</record_update>')
}

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

test('refuses to CREATE a record in a scope that is neither Global nor the project\'s own', async () => {
  // This project has no now.config.json, so its artifact's scope is not "its own".
  const result = await push('--sys-id', SYS_ID)
  assert.notEqual(result.status, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /neither Global nor this project's own/)
  assert.match(output, /--target-scope global/, 'should name the explicit opt-in')
  assert.deepEqual(instance.writes(), [], 'nothing may be written')
})

test('--target-scope global creates it and says plainly where it landed', async () => {
  const result = await push('--sys-id', SYS_ID, '--target-scope', 'global')
  assert.equal(result.status, 0, result.stderr)
  const output = result.stdout + result.stderr
  assert.match(output, /landed in GLOBAL/)
  assert.match(output, /api_name is now "global\.NowFluentBrandNew"/, 'the rewrite must be surfaced')

  const live = instance.store.get(`sys_script_include/${SYS_ID}`)
  assert.equal(live.sys_scope, 'global')
  assert.equal(live.sys_id, SYS_ID, 'the sys_id is still preserved')
})

test('--target-scope of any other scope is refused before anything is written', async () => {
  const result = await push('--sys-id', SYS_ID, '--target-scope', 'x_other_app')
  assert.notEqual(result.status, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /not possible through the Table API/)
  assert.match(output, /update-set-package/, 'should point at the path that does work')
  assert.deepEqual(instance.log, [], 'must not even contact the instance')
})

test('a Global-scoped artifact creates normally, with no ceremony', async () => {
  writeScoped('global')
  const result = await push('--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /created/)
  assert.ok(!/WRONG SCOPE|landed in GLOBAL/.test(result.stdout + result.stderr))
})

test('an UPDATE whose source scope disagrees with the instance is refused before writing', async () => {
  // The record exists in Global; the project still believes it is scoped. Even --force
  // must not send it: the body would carry a project-scoped api_name to a Global record.
  instance.store.set(`sys_script_include/${SYS_ID}`, {
    sys_id: SYS_ID, name: 'NowFluentBrandNew', api_name: 'global.NowFluentBrandNew',
    script: 'var NowFluentBrandNew = Class.create();', active: 'true',
    sys_scope: 'global', sys_updated_on: '2026-01-01 00:00:01', sys_mod_count: '1'
  })
  const result = await push('--sys-id', SYS_ID, '--force')
  assert.notEqual(result.status, 0, 'a scope mismatch must not pass as success')
  const output = result.stdout + result.stderr
  assert.match(output, /REFUSED before writing/)
  // No now.config.json in this project, so its scope has no name to show — the id is
  // all there is. Global always reads as "Global".
  assert.match(output, /scope e5d61884.*lives in Global/s)
  assert.deepEqual(instance.writes(), [], '--force does not override a scope mismatch')
  assert.equal(instance.store.get(`sys_script_include/${SYS_ID}`).api_name, 'global.NowFluentBrandNew')
})

test('when the platform DOES honour sys_scope, push just works', async () => {
  // Guards must not fire on an instance that behaves as originally assumed.
  const honouring = await startMockInstance({ honoursScope: true })
  try {
    const { stdout } = await run(process.execPath,
      [CLI, 'push', '--project', project, '--auth', 'test', '--sys-id', SYS_ID, '--target-scope', 'global'], {
        encoding: 'utf8',
        env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: honouring.origin }
      })
    assert.match(stdout, /created/)
    assert.ok(!/WRONG SCOPE/.test(stdout))
    // --target-scope global says Global in the body too, so an honouring platform puts it there.
    assert.equal(honouring.store.get(`sys_script_include/${SYS_ID}`).sys_scope, 'global')
  } finally {
    await honouring.stop()
  }
})


test('after a --target-scope global create, later pushes of that record still work', async () => {
  // The create lands in Global while the source still says x_push_demo. Without an
  // adoption recorded, the pre-write scope guard would refuse every later update.
  assert.equal((await push('--sys-id', SYS_ID, '--target-scope', 'global')).status, 0)
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_script_include_${SYS_ID}.xml`),
    ['<record_update table="sys_script_include">',
      '  <sys_script_include action="INSERT_OR_UPDATE" apply_defaults="true">',
      '    <active>true</active>',
      '    <api_name>x_push_demo.NowFluentBrandNew</api_name>',
      '    <name>NowFluentBrandNew</name>',
      '    <script><![CDATA[var NowFluentBrandNew = Class.create(); // v2]]></script>',
      `    <sys_id>${SYS_ID}</sys_id>`,
      `    <sys_scope display_value="x_push_demo">${APP_SCOPE}</sys_scope>`,
      '  </sys_script_include>'].join('\n') + '\n</record_update>')
  instance.log.length = 0

  const second = await push('--sys-id', SYS_ID)
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /pushing it back there/)
  const writes = instance.writes()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'PUT')
  assert.deepEqual(Object.keys(writes[0].body), ['script'])
  assert.equal(instance.store.get(`sys_script_include/${SYS_ID}`).api_name, 'global.NowFluentBrandNew')
})
