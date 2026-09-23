// The cross-scope edit loop, as the user wants it:
//   a Fluent project bound to x_push_demo pulls a record that lives in GLOBAL;
//   the record appears in the project AS IF it were x_push_demo's (so it compiles —
//   the SDK rejects apiName 'global.X' in a scoped project with TS11);
//   push sends it back to Global: same sys_id, same record, still Global.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { startMockInstance } from './helpers/mock-instance.mjs'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'now-fluent.mjs')
const FAKE_SDK = resolve(import.meta.dirname, 'helpers', 'fake-sdk.mjs')
const SYS_ID = 'aa12cd34ef56ab12cd34ef56ab12cd34'
const PROJECT_SCOPE_ID = 'e5d61884beaf441ebd67932b798cb00b'
const run = promisify(execFile)

let instance
let project

before(async () => { instance = await startMockInstance() })
after(async () => { await instance.stop() })

beforeEach(() => {
  instance.store.clear()
  instance.log.length = 0
  project = mkdtempSync(join(tmpdir(), 'now-fluent-adopt-'))
  writeFileSync(join(project, 'now.config.json'),
    JSON.stringify({ scope: 'x_push_demo', scopeId: PROJECT_SCOPE_ID, name: 'Push Demo' }))

  // A GLOBAL script include on the instance, plus its sys_metadata row (pull resolves
  // table and scope from there).
  instance.store.set(`sys_script_include/${SYS_ID}`, {
    sys_id: SYS_ID, name: 'PriceUtils', api_name: 'global.PriceUtils',
    script: 'var PriceUtils = Class.create();', description: 'global helper', active: 'true',
    sys_scope: 'global', sys_updated_on: '2026-05-05 05:05:05', sys_mod_count: '4'
  })
  instance.store.set(`sys_metadata/${SYS_ID}`, {
    sys_id: SYS_ID, sys_class_name: 'sys_script_include', sys_name: 'PriceUtils', sys_scope: 'global'
  })
})

async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args, '--project', project, '--auth', 'test'], {
      encoding: 'utf8',
      env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
    })
    return { status: 0, output: stdout + stderr }
  } catch (error) {
    return { status: error.code ?? 1, output: (error.stdout ?? '') + (error.stderr ?? '') }
  }
}

// What `now-sdk build` emits for the adopted record: the PROJECT's scope and api_name.
function writeBuiltArtifact(script = 'var PriceUtils = Class.create();') {
  mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
  writeFileSync(join(project, 'dist', 'app', 'update', `sys_script_include_${SYS_ID}.xml`),
    ['<record_update table="sys_script_include">',
      '  <sys_script_include action="INSERT_OR_UPDATE" apply_defaults="true">',
      `    <sys_id>${SYS_ID}</sys_id>`,
      `    <sys_scope display_value="x_push_demo">${PROJECT_SCOPE_ID}</sys_scope>`,
      '    <active>true</active>',
      '    <api_name>x_push_demo.PriceUtils</api_name>',
      '    <description>global helper</description>',
      '    <name>PriceUtils</name>',
      `    <script><![CDATA[${script}]]></script>`,
      '  </sys_script_include>',
      '</record_update>'].join('\n'))
}

const baseline = () => JSON.parse(readFileSync(join(project, '.now-fluent', 'state', `sys_script_include_${SYS_ID}.json`), 'utf8'))
const adoptions = () => {
  const file = join(project, '.now-fluent', 'adopted.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

test('pull adopts a Global record into the project scope, so the source compiles', async () => {
  const out = join(project, 'rebuilt')
  const result = await cli('pull', '--sys-id', SYS_ID, '--out', out)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /were ADOPTED/)
  assert.match(result.output, /adopting sys_script_include .* from global into x_push_demo/)

  // The XML handed to the offline transform is in the PROJECT's scope.
  const dir = join(out, `sys_script_include_${SYS_ID}`)
  const xml = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
  assert.match(xml, new RegExp(`<sys_scope display_value="x_push_demo">${PROJECT_SCOPE_ID}</sys_scope>`))
  assert.match(xml, /<api_name>x_push_demo\.PriceUtils<\/api_name>/, 'no TS11: apiName now starts with the project scope')

  // The baseline holds the LIVE record; the adoption lives in its own durable file.
  assert.equal(baseline().fields.sys_scope, 'global', 'the baseline holds the LIVE record, untouched')
  const adopted = adoptions()[SYS_ID]
  assert.deepEqual(adopted.from, { scopeId: 'global', name: 'global', apiPrefix: 'global' })
  assert.equal(adopted.to.scopeId, PROJECT_SCOPE_ID)
  assert.equal(adopted.table, 'sys_script_include')
})

test('push sends an adopted record back to Global — same sys_id, still Global', async () => {
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact('var PriceUtils = Class.create(); // edited in the scoped project')
  instance.log.length = 0

  const result = await cli('push', '--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /adopted from global: pushing it back there \(api_name x_push_demo\.PriceUtils -> global\.PriceUtils\)/)
  assert.match(result.output, /updated \(1 field\(s\)\)/, 'only the edit is sent — scope and api_name diff out')

  const writes = instance.writes()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'PUT', 'an update of the original record, never a create')
  assert.deepEqual(Object.keys(writes[0].body), ['script'])

  const live = instance.store.get(`sys_script_include/${SYS_ID}`)
  assert.equal(live.sys_scope, 'global')
  assert.equal(live.api_name, 'global.PriceUtils')
  assert.match(live.script, /edited in the scoped project/)
})

test('the adoption survives the post-push baseline refresh', async () => {
  // Losing it would make the SECOND push compare x_push_demo against Global and
  // report the record as mis-scoped.
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact('var PriceUtils = Class.create(); // one')
  assert.equal((await cli('push', '--sys-id', SYS_ID)).status, 0)
  assert.ok(adoptions()[SYS_ID], 'still recorded after the refresh')

  writeBuiltArtifact('var PriceUtils = Class.create(); // two')
  const second = await cli('push', '--sys-id', SYS_ID)
  assert.equal(second.status, 0, second.output)
  assert.match(second.output, /updated \(1 field\(s\)\)/)
  assert.ok(!/WRONG SCOPE/.test(second.output))
})

test('an unedited adopted record pushes as unchanged', async () => {
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact()
  instance.log.length = 0
  const result = await cli('push', '--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /unchanged/)
  assert.deepEqual(instance.writes(), [])
})

test('--full on an adopted record still writes the ORIGIN scope and api_name', async () => {
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact()
  instance.log.length = 0
  const result = await cli('push', '--sys-id', SYS_ID, '--full')
  assert.equal(result.status, 0, result.output)
  const body = instance.writes()[0].body
  assert.equal(body.sys_scope, 'global')
  assert.equal(body.api_name, 'global.PriceUtils', 'never the project-scoped api_name')
})

// Simulate a project that has lost track of where a record lives — e.g. a clone in
// which .now-fluent/adopted.json was never committed.
async function forgetAdoptions() {
  const { rmSync } = await import('node:fs')
  rmSync(join(project, '.now-fluent', 'adopted.json'), { force: true })
}

test('with the origin unknown, the same push is refused BEFORE anything is written', async () => {
  // The source says x_push_demo while the record is Global, and nothing records that.
  // Sending it would carry api_name x_push_demo.PriceUtils to the Global record — a
  // rename that breaks every caller. It must be stopped before the write.
  await cli('pull', '--sys-id', SYS_ID)
  await forgetAdoptions()
  writeBuiltArtifact('var PriceUtils = Class.create(); // edited')
  instance.log.length = 0

  const result = await cli('push', '--sys-id', SYS_ID)
  assert.notEqual(result.status, 0)
  assert.match(result.output, /REFUSED before writing/)
  assert.match(result.output, /pull it again/, 'should say how to get the adoption')
  assert.deepEqual(instance.writes(), [], 'nothing may reach the instance')
  assert.equal(instance.store.get(`sys_script_include/${SYS_ID}`).api_name, 'global.PriceUtils')
})

test('a record already in the project scope is not adopted', async () => {
  instance.store.set(`sys_script_include/${SYS_ID}`, {
    ...instance.store.get(`sys_script_include/${SYS_ID}`), sys_scope: PROJECT_SCOPE_ID, api_name: 'x_push_demo.PriceUtils'
  })
  instance.store.set(`sys_metadata/${SYS_ID}`, { ...instance.store.get(`sys_metadata/${SYS_ID}`), sys_scope: PROJECT_SCOPE_ID })
  const result = await cli('pull', '--sys-id', SYS_ID)
  assert.equal(result.status, 0, result.output)
  assert.ok(!/ADOPTED|adopting/.test(result.output))
  assert.ok(!adoptions()[SYS_ID])
})

test('pull --dry-run contacts nothing, even to check scopes', async () => {
  const result = await cli('pull', '--sys-id', SYS_ID, '--dry-run')
  assert.equal(result.status, 0, result.output)
  assert.deepEqual(instance.log, [])
  assert.ok(!existsSync(join(project, '.now-fluent')))
})

// --- update-set-package must not silently MOVE an adopted record -------------

async function packageIt(...args) {
  // update-set-package reads the project's built artifacts; no build, no instance.
  return cli('update-set-package', '--update-set-name', 'adopt test', ...args)
}

function updateSetXml() {
  const dir = join(project, 'exports', 'adopt-test')
  const file = readdirSync(dir).find((f) => f.startsWith('update-set-') && f.endsWith('.xml'))
  return readFileSync(join(dir, file), 'utf8')
}

test('update-set-package refuses to package an adopted record into the project scope', async () => {
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact()
  const result = await packageIt()
  assert.notEqual(result.status, 0)
  assert.match(result.output, /pulled from another scope and ADOPTED/)
  assert.match(result.output, /would MOVE them into x_push_demo/)
  assert.match(result.output, /--scope global --scope-id global/, 'should give the in-place command')
  assert.match(result.output, /--move-adopted/)
})

test('packaging an adopted record for its origin scope edits it IN PLACE', async () => {
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact('var PriceUtils = Class.create(); // edited')
  const result = await packageIt('--scope', 'global', '--scope-id', 'global', '--include', SYS_ID)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /IN-PLACE edits in their origin scope/)

  const xml = updateSetXml()
  assert.ok(xml.includes('global.PriceUtils'), 'api_name must be the ORIGIN one')
  assert.ok(!xml.includes('x_push_demo.PriceUtils'), 'the project-scoped api_name must not reach the update set')
  assert.ok(!xml.includes(PROJECT_SCOPE_ID), 'nothing may point at the project scope')
})

test('--move-adopted packages it as built, and says what that will do', async () => {
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact()
  const result = await packageIt('--move-adopted')
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /will be MOVED into x_push_demo on commit/)
  assert.match(result.output, /old api_name will break/)
  assert.ok(updateSetXml().includes('x_push_demo.PriceUtils'))
})

test('pull resolves each record\'s table once, not twice', async () => {
  // pull resolves tables up front for the scope check; import used to query again.
  await cli('pull', '--sys-id', SYS_ID)
  const metadataQueries = instance.log.filter((entry) => entry.method === 'GET' && entry.table === 'sys_metadata')
  assert.equal(metadataQueries.length, 1)
})


// --- regressions: adoption must be durable, and every path must honour it ----

test('the adoption survives the baseline being deleted', async () => {
  // Baselines are disposable (a failed read-back removes one; a fresh clone has none).
  // If adoption lived there, update-set-package would then package the record as a MOVE.
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact()
  const { rmSync } = await import('node:fs')
  rmSync(join(project, '.now-fluent', 'state'), { recursive: true, force: true })

  const result = await packageIt()
  assert.notEqual(result.status, 0, 'must still refuse to move it')
  assert.match(result.output, /pulled from another scope and ADOPTED/)
})

test('pull --no-state still records the adoption', async () => {
  const result = await cli('pull', '--sys-id', SYS_ID, '--no-state')
  assert.equal(result.status, 0, result.output)
  assert.ok(adoptions()[SYS_ID], 'no baseline, but the adoption is still known')
  assert.ok(!existsSync(join(project, '.now-fluent', 'state')))
})

test('re-pulling without adoption forgets the old adoption', async () => {
  // Otherwise a stale entry would make update-set-package refuse a record whose source
  // is no longer written in the project's terms.
  await cli('pull', '--sys-id', SYS_ID)
  assert.ok(adoptions()[SYS_ID])
  instance.store.set(`sys_script_include/${SYS_ID}`, {
    ...instance.store.get(`sys_script_include/${SYS_ID}`), sys_scope: PROJECT_SCOPE_ID, api_name: 'x_push_demo.PriceUtils'
  })
  await cli('pull', '--sys-id', SYS_ID)
  assert.ok(!adoptions()[SYS_ID])
})

test('--move-adopted still edits IN PLACE a record whose origin is the target scope', async () => {
  // It is not moving anywhere; skipping the translation would carry x_push_demo.PriceUtils
  // into Global and rename the record in place.
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact()
  const result = await packageIt('--scope', 'global', '--scope-id', 'global', '--include', SYS_ID, '--move-adopted')
  assert.equal(result.status, 0, result.output)
  assert.ok(updateSetXml().includes('global.PriceUtils'))
  assert.ok(!updateSetXml().includes('x_push_demo.PriceUtils'))
  assert.ok(!/will be MOVED/.test(result.output), 'nothing is moving, so nothing should say so')
})

test('push --dry-run refuses exactly what the real push would refuse', async () => {
  // A dry run that previewed a PUT the real run then refused would be approved on a
  // false premise.
  await cli('pull', '--sys-id', SYS_ID)
  await forgetAdoptions()
  writeBuiltArtifact('var PriceUtils = Class.create(); // edited')
  instance.log.length = 0
  const result = await cli('push', '--sys-id', SYS_ID, '--dry-run')
  assert.notEqual(result.status, 0)
  assert.match(result.output, /REFUSED before writing/)
  assert.deepEqual(instance.writes(), [])
})

test('push --dry-run previews only the real diff', async () => {
  await cli('pull', '--sys-id', SYS_ID)
  writeBuiltArtifact('var PriceUtils = Class.create(); // edited')
  instance.log.length = 0
  const result = await cli('push', '--sys-id', SYS_ID, '--dry-run')
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /would PUT .*\(1 field\(s\)\)/)
  assert.match(result.output, /\[dry-run, nothing written\]: 1 would update/, 'no past tense for things not done')
  assert.deepEqual(instance.writes(), [], 'reads only')
})

test('--no-adopt-scope skips the rewrite but never forgets where the record lives', async () => {
  // The SDK build stamps the PROJECT's scope on every artifact, rewritten or not, so a
  // record living elsewhere must stay recorded — or update-set-package would package it
  // as a move into the project's scope.
  await cli('pull', '--sys-id', SYS_ID)
  assert.ok(adoptions()[SYS_ID])
  const out = join(project, 'rebuilt')
  const result = await cli('pull', '--sys-id', SYS_ID, '--no-adopt-scope', '--out', out)
  assert.equal(result.status, 0, result.output)
  assert.ok(adoptions()[SYS_ID], 'still recorded')

  const dir = join(out, `sys_script_include_${SYS_ID}`)
  const xml = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
  assert.match(xml, /<api_name>global\.PriceUtils<\/api_name>/, 'not rewritten')

  writeBuiltArtifact()
  const packaged = await packageIt()
  assert.notEqual(packaged.status, 0, 'update-set-package must still refuse to move it')
})
