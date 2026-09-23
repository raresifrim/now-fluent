// End-to-end tests for `now-fluent pull`. The fake now-sdk reads the mock instance
// for real (so queryRecords' envelope parsing is genuinely exercised) and registers
// records in keys.ts the way a transform does.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
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

// --- selecting by query ------------------------------------------------------
const SECOND = 'cd34ef56ab12cd34ef56ab12cd34ef56'
function seedSecond() {
  instance.store.set(`sys_script_include/${SECOND}`, {
    sys_id: SECOND, name: 'OtherInclude', script: 'var b = 2;', description: 'second',
    active: 'false', sys_scope: 'global', sys_updated_on: '2026-03-04 04:04:04', sys_mod_count: '1'
  })
}

test('--query pulls every matching record and records a baseline for each', async () => {
  seedSecond()
  const result = await pull('--query', 'active=true')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /1 record\(s\) matched/)
  assert.ok(existsSync(baselineFile()), 'the matched record has a baseline')
  assert.ok(!existsSync(join(project, '.now-fluent', 'state', `sys_script_include_${SECOND}.json`)),
    'the record the query did not match was not pulled')
})

test('--query re-takes records already in the project (pull always takes the instance version)', async () => {
  assert.equal((await pull('--sys-id', SYS_ID)).status, 0)
  instance.store.get(`sys_script_include/${SYS_ID}`).sys_mod_count = '6'
  const result = await pull('--query', `sys_id=${SYS_ID}`)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /already exist as Fluent source/, 'warns before replacing local source')
  assert.equal(JSON.parse(readFileSync(baselineFile(), 'utf8')).sys_mod_count, '6', 'baseline refreshed, not skipped')
})

test('--query and --sys-id together are refused; --query without --table is refused', async () => {
  const both = await pull('--query', 'active=true', '--sys-id', SYS_ID)
  assert.notEqual(both.status, 0)
  assert.match(both.stderr, /EITHER --sys-id .* OR --query/)

  const { stderr } = await run(process.execPath,
    [CLI, 'pull', '--project', project, '--auth', 'test', '--query', 'active=true'], {
      encoding: 'utf8',
      env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
    }).catch((error) => error)
  assert.match(stderr, /--query needs --table/)
})

test('--query --dry-run selects nothing and writes nothing', async () => {
  const result = await pull('--query', 'active=true', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[dry-run\] would select records/)
  assert.ok(!existsSync(baselineFile()))
  assert.ok(!instance.log.some((entry) => entry.method !== 'GET'), 'nothing written')
})

test('a query in the config file never turns "pull these ids" into "pull that query"', async () => {
  seedSecond()
  const config = join(project, 'cfg.json')
  writeFileSync(config, JSON.stringify({ query: 'active=false' })) // would match SECOND only
  const result = await pull('--sys-id', SYS_ID, '--config', config)
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /Selecting records/, "the config file's query was not run")
  // Seen before the fix: the query's record was IMPORTED instead, and the named one got a
  // baseline without ever being imported.
  const keys = readFileSync(join(project, 'src', 'fluent', 'generated', 'keys.ts'), 'utf8')
  assert.ok(keys.includes(SYS_ID), 'the named record was imported')
  assert.ok(!keys.includes(SECOND), "the config query's record was not")
})
