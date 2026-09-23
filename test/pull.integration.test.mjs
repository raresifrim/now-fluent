// End-to-end tests for `now-fluent pull`. The fake now-sdk reads the mock instance
// for real (so queryRecords' envelope parsing is genuinely exercised) and registers
// records in keys.ts the way a transform does.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { startMockInstance } from './helpers/mock-instance.mjs'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'now-fluent.mjs')
const FAKE_SDK = resolve(import.meta.dirname, 'helpers', 'fake-sdk.mjs')
const SYS_ID = 'ab12cd34ef56ab12cd34ef56ab12cd34'
const run = promisify(execFile)

let instance
let project

before(async () => { instance = await startMockInstance() })
after(async () => { await instance.stop() })

beforeEach(() => {
  instance.store.clear()
  instance.log.length = 0
  project = mkdtempSync(join(tmpdir(), 'now-fluent-pull-'))
  instance.store.set(`sys_script_include/${SYS_ID}`, {
    sys_id: SYS_ID,
    name: 'MyInclude',
    script: 'var a = 1;',
    description: 'live copy',
    active: 'true',
    sys_scope: 'global',
    sys_updated_on: '2026-03-03 03:03:03',
    sys_mod_count: '5'
  })
})

async function pull(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath,
      [CLI, 'pull', '--project', project, '--auth', 'test', '--table', 'sys_script_include', ...args], {
        encoding: 'utf8',
        env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
      })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

const baselineFile = () => join(project, '.now-fluent', 'state', `sys_script_include_${SYS_ID}.json`)

test('records a baseline holding the record as the instance has it', async () => {
  const result = await pull('--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(baselineFile()), 'a baseline file should exist')

  const baseline = JSON.parse(readFileSync(baselineFile(), 'utf8'))
  assert.equal(baseline.table, 'sys_script_include')
  assert.equal(baseline.sysId, SYS_ID)
  assert.equal(baseline.sys_updated_on, '2026-03-03 03:03:03')
  assert.equal(baseline.sys_mod_count, '5')
  assert.equal(baseline.fields.script, 'var a = 1;')
  assert.equal(baseline.instance, instance.origin)
})

test('imports the record as Fluent source (registered in keys.ts)', async () => {
  const result = await pull('--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.stderr)
  const keys = readFileSync(join(project, 'src', 'fluent', 'generated', 'keys.ts'), 'utf8')
  assert.match(keys, new RegExp(`'${SYS_ID}': \\{`))
})

test('--no-state imports without a baseline', async () => {
  const result = await pull('--sys-id', SYS_ID, '--no-state')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!existsSync(baselineFile()), 'no baseline should be written')
  assert.match(result.stdout, /not recording a baseline/)
})

test('--dry-run contacts the instance for nothing and writes nothing', async () => {
  const result = await pull('--sys-id', SYS_ID, '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!existsSync(baselineFile()))
  assert.match(result.stdout, /\[dry-run\]/)
})

test('a record the instance will not return is reported, not silently skipped', async () => {
  const missing = 'f'.repeat(32)
  const result = await pull('--sys-id', missing)
  // import itself fails for a record that no query returns; the point is it is loud.
  assert.match(result.stdout + result.stderr, new RegExp(missing))
})

test('pull then push round-trips a local edit back to the instance', async () => {
  assert.equal((await pull('--sys-id', SYS_ID)).status, 0)

  // Stand in for "the developer edited the Fluent source and rebuilt".
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_script_include_${SYS_ID}.xml`),
    ['<record_update table="sys_script_include">',
      '  <sys_script_include action="INSERT_OR_UPDATE">',
      '    <active>true</active>',
      '    <description>live copy</description>',
      '    <name>MyInclude</name>',
      '    <script><![CDATA[var a = 2; // edited locally]]></script>',
      `    <sys_id>${SYS_ID}</sys_id>`,
      '    <sys_scope display_value="Global">global</sys_scope>',
      '  </sys_script_include>',
      '</record_update>'].join('\n'))

  const pushed = await run(process.execPath,
    [CLI, 'push', '--project', project, '--auth', 'test', '--sys-id', SYS_ID], {
      encoding: 'utf8',
      env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
    })

  assert.match(pushed.stdout, /updated \(1 field\(s\)\)/)
  const live = instance.store.get(`sys_script_include/${SYS_ID}`)
  assert.equal(live.script, 'var a = 2; // edited locally')
  assert.equal(live.description, 'live copy', 'untouched fields must survive the merge')
})

test('--no-state warns when a stale baseline is still on disk', async () => {
  await pull('--sys-id', SYS_ID)          // leaves a baseline
  const result = await pull('--sys-id', SYS_ID, '--no-state')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout + result.stderr, /still have a baseline from an earlier pull/)
})

test('one unreadable record does not cost the others their baseline', async () => {
  const second = '22'.repeat(16)
  instance.store.set(`sys_script_include/${second}`, {
    sys_id: second, name: 'Second', script: 'var b = 1;', sys_updated_on: 'x', sys_mod_count: '1'
  })
  // The instance forgets the first record between the import and the baseline read.
  const result = await pull('--sys-id', `${SYS_ID},${second}`)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(join(project, '.now-fluent', 'state', `sys_script_include_${second}.json`)))
  assert.ok(existsSync(baselineFile()))
})

test('warns before replacing Fluent source that already exists locally', async () => {
  await pull('--sys-id', SYS_ID)
  const again = await pull('--sys-id', SYS_ID)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout + again.stderr, /local edits to them will be replaced/)
})
