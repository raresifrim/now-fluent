// Gap 1: `import` and `import-update-set` adopt records from other scopes, as pull does.
// Gap 2: update-set-package moves api_name along with sys_scope when packaging for a
//        scope other than the project's own.
//
// Before these fixes, an update set imported from Global into a scoped project either
// failed TS11 (records with an apiName) or built silently as the project's own records
// with nothing recording where they live — and update-set-package then packaged them
// as a MOVE into the project's scope. And packaging an authored record "for Global"
// produced sys_scope=global with api_name=x_push_demo.X, a combination nothing could call.
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
const PROJECT_SCOPE_ID = 'e5d61884beaf441ebd67932b798cb00b'
const SI_ID = 'aa11cd34ef56ab12cd34ef56ab12cd34'   // a Global script include (has an api_name)
const BR_ID = 'bb22cd34ef56ab12cd34ef56ab12cd34'   // a Global business rule (no api_name)
const run = promisify(execFile)

let instance
let project

before(async () => { instance = await startMockInstance() })
after(async () => { await instance.stop() })

beforeEach(() => {
  instance.store.clear()
  instance.log.length = 0
  project = mkdtempSync(join(tmpdir(), 'now-fluent-import-adopt-'))
  writeFileSync(join(project, 'now.config.json'),
    JSON.stringify({ scope: 'x_push_demo', scopeId: PROJECT_SCOPE_ID, name: 'Push Demo' }))
})

async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args, '--project', project], {
      encoding: 'utf8',
      env: { ...process.env, NOW_FLUENT_SDK: `${process.execPath} ${FAKE_SDK}`, FAKE_SDK_HOST: instance.origin }
    })
    return { status: 0, output: stdout + stderr }
  } catch (error) {
    return { status: error.code ?? 1, output: (error.stdout ?? '') + (error.stderr ?? '') }
  }
}

const adoptions = () => {
  const file = join(project, '.now-fluent', 'adopted.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// A real-shaped update set export: an <unload> whose <payload>s are HTML-escaped.
function writeUpdateSet({ scopeId = 'global', scopeName = 'Global', apiPrefix = 'global' } = {}) {
  const si = `<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE">`
    + `<sys_id>${SI_ID}</sys_id><sys_scope display_value="${scopeName}">${scopeId}</sys_scope>`
    + `<api_name>${apiPrefix}.PriceUtils</api_name><name>PriceUtils</name>`
    + '<script>var PriceUtils = Class.create();</script></sys_script_include></record_update>'
  const br = `<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE">`
    + `<sys_id>${BR_ID}</sys_id><sys_scope display_value="${scopeName}">${scopeId}</sys_scope>`
    + '<name>Stamp</name><collection>incident</collection></sys_script></record_update>'
  const file = join(project, 'us.xml')
  writeFileSync(file, ['<?xml version="1.0" encoding="UTF-8"?>', '<unload unload_date="2026-01-01 00:00:00">',
    ...[si, br].map((payload) => `<sys_update_xml action="INSERT_OR_UPDATE"><payload>${escapeXml(payload)}</payload></sys_update_xml>`),
    '</unload>'].join('\n'))
  return file
}

function extracted(out, table, id) {
  return readFileSync(join(out, `${table}_${id}.xml`), 'utf8')
}

// What `now-sdk build` would emit for a record in this project: the PROJECT's scope.
function writeBuilt(table, id, extra = '') {
  mkdirSync(join(project, 'dist', 'app', 'update'), { recursive: true })
  writeFileSync(join(project, 'dist', 'app', 'update', `${table}_${id}.xml`),
    `<record_update table="${table}"><${table} action="INSERT_OR_UPDATE"><sys_id>${id}</sys_id>`
    + `<sys_scope display_value="x_push_demo">${PROJECT_SCOPE_ID}</sys_scope>${extra}<name>N${id.slice(0, 4)}</name>`
    + `</${table}></record_update>`)
}

function updateSetXml(name) {
  const dir = join(project, 'exports', name)
  return readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith('update-set-') && f.endsWith('.xml'))), 'utf8')
}

// --- gap 1: import-update-set ------------------------------------------------

test('import-update-set adopts Global records: rewritten, and their origin recorded', async () => {
  const out = join(project, 'extracted')
  const result = await cli('import-update-set', '--from', writeUpdateSet(), '--out', out)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /2 record\(s\) live outside x_push_demo \(Global: 2\) and are ADOPTED/)

  // The XML handed to the transform is in the project's scope — no TS11.
  const si = extracted(out, 'sys_script_include', SI_ID)
  assert.match(si, /<api_name>x_push_demo\.PriceUtils<\/api_name>/)
  assert.ok(si.includes(PROJECT_SCOPE_ID))
  assert.ok(extracted(out, 'sys_script', BR_ID).includes(PROJECT_SCOPE_ID), 'a record without an api_name too')

  const recorded = adoptions()
  assert.deepEqual(recorded[SI_ID].from, { scopeId: 'global', name: 'Global', apiPrefix: 'global' })
  assert.equal(recorded[BR_ID].from.scopeId, 'global')
  assert.equal(recorded[BR_ID].from.apiPrefix, '', 'no api_name, no prefix')
  assert.match(result.output, /Recorded 2 adopted record\(s\)/)
})

test('imported-from-Global records are no longer packaged as a silent MOVE', async () => {
  await cli('import-update-set', '--from', writeUpdateSet())
  writeBuilt('sys_script_include', SI_ID, '<api_name>x_push_demo.PriceUtils</api_name>')

  const refused = await cli('update-set-package', '--update-set-name', 'into project')
  assert.notEqual(refused.status, 0)
  assert.match(refused.output, /pulled from another scope and ADOPTED/)

  const inPlace = await cli('update-set-package', '--update-set-name', 'in place',
    '--scope', 'global', '--scope-id', 'global', '--include', SI_ID)
  assert.equal(inPlace.status, 0, inPlace.output)
  assert.ok(updateSetXml('in-place').includes('global.PriceUtils'))
  assert.ok(!updateSetXml('in-place').includes('x_push_demo.PriceUtils'))
})

test('import-update-set --no-adopt-scope skips the rewrite but still records the origin', async () => {
  const out = join(project, 'extracted')
  const result = await cli('import-update-set', '--from', writeUpdateSet(), '--out', out, '--no-adopt-scope')
  assert.equal(result.status, 0, result.output)
  assert.match(extracted(out, 'sys_script_include', SI_ID), /<api_name>global\.PriceUtils<\/api_name>/)
  assert.ok(adoptions()[SI_ID], 'the build stamps the project scope regardless, so the origin must be known')
})

test('records already in the project scope are not adopted, and a stale entry is cleared', async () => {
  mkdirSync(join(project, '.now-fluent'), { recursive: true })
  writeFileSync(join(project, '.now-fluent', 'adopted.json'), JSON.stringify({
    [SI_ID]: { table: 'sys_script_include', from: { scopeId: 'global', name: 'Global', apiPrefix: 'global' },
      to: { scopeId: PROJECT_SCOPE_ID, name: 'x_push_demo', apiPrefix: 'x_push_demo' } }
  }))
  const result = await cli('import-update-set', '--from',
    writeUpdateSet({ scopeId: PROJECT_SCOPE_ID, scopeName: 'x_push_demo', apiPrefix: 'x_push_demo' }))
  assert.equal(result.status, 0, result.output)
  assert.ok(!/ADOPTED/.test(result.output))
  assert.deepEqual(adoptions(), {})
})

test('import-update-set --dry-run records nothing', async () => {
  const result = await cli('import-update-set', '--from', writeUpdateSet(), '--dry-run')
  assert.equal(result.status, 0, result.output)
  assert.deepEqual(adoptions(), {})
})

test('a record that fails to land is not recorded as adopted', async () => {
  // Only the business rule is imported (the include is filtered out), so only it lands.
  const result = await cli('import-update-set', '--from', writeUpdateSet(), '--include', BR_ID)
  assert.equal(result.status, 0, result.output)
  assert.ok(adoptions()[BR_ID])
  assert.ok(!adoptions()[SI_ID], 'never imported, so nothing to record')
})

// --- gap 1: plain import -----------------------------------------------------

test('import --via query adopts a Global record like pull does', async () => {
  instance.store.set(`sys_script_include/${SI_ID}`, {
    sys_id: SI_ID, name: 'PriceUtils', api_name: 'global.PriceUtils', script: 'var PriceUtils = Class.create();',
    sys_scope: 'global', sys_updated_on: '2026-01-01 00:00:01', sys_mod_count: '1'
  })
  const out = join(project, 'rebuilt')
  const result = await cli('import', '--auth', 'test', '--via', 'query', '--table', 'sys_script_include',
    '--sys-id', SI_ID, '--out', out)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /adopting sys_script_include .* from global into x_push_demo/)
  const dir = join(out, `sys_script_include_${SI_ID}`)
  assert.match(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'), /<api_name>x_push_demo\.PriceUtils<\/api_name>/)
  assert.equal(adoptions()[SI_ID].from.scopeId, 'global')
})

// --- gap 2: update-set-package for another scope -----------------------------

test('packaging an AUTHORED record for Global moves api_name along with sys_scope', async () => {
  const id = 'cc33cd34ef56ab12cd34ef56ab12cd34'
  writeBuilt('sys_script_include', id, '<api_name>x_push_demo.Helper</api_name>')
  const result = await cli('update-set-package', '--update-set-name', 'to global',
    '--scope', 'global', '--scope-id', 'global', '--include', id)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /1 record\(s\) built in x_push_demo are packaged for global/)
  assert.match(result.output, /MOVES them there, if they already exist in x_push_demo/)
  assert.match(result.output, /api_name rewritten x_push_demo\.\* -> global\.\* on 1 of them/)

  const xml = updateSetXml('to-global')
  assert.ok(xml.includes('global.Helper'), 'api_name matches the scope it lands in')
  assert.ok(!xml.includes('x_push_demo.Helper'))
  assert.ok(!xml.includes(PROJECT_SCOPE_ID), 'sys_scope is Global too')
})

test('packaging for the project\'s own scope leaves api_name alone and says nothing', async () => {
  const id = 'cc33cd34ef56ab12cd34ef56ab12cd34'
  writeBuilt('sys_script_include', id, '<api_name>x_push_demo.Helper</api_name>')
  const result = await cli('update-set-package', '--update-set-name', 'own', '--include', id)
  assert.equal(result.status, 0, result.output)
  assert.ok(!/are packaged for/.test(result.output))
  assert.ok(updateSetXml('own').includes('x_push_demo.Helper'))
})

test('--keep-payload-scope leaves both sys_scope and api_name as built', async () => {
  const id = 'cc33cd34ef56ab12cd34ef56ab12cd34'
  writeBuilt('sys_script_include', id, '<api_name>x_push_demo.Helper</api_name>')
  const result = await cli('update-set-package', '--update-set-name', 'kept',
    '--scope', 'global', '--scope-id', 'global', '--include', id, '--keep-payload-scope')
  assert.equal(result.status, 0, result.output)
  assert.ok(!/are packaged for/.test(result.output))
  assert.ok(updateSetXml('kept').includes('x_push_demo.Helper'))
})

test('--move-adopted into a THIRD scope renames api_name for that scope', async () => {
  // Adopted from Global, moved deliberately into y_scope: it must arrive as y_scope.X,
  // not with the project's prefix.
  await cli('import-update-set', '--from', writeUpdateSet(), '--include', SI_ID)
  writeBuilt('sys_script_include', SI_ID, '<api_name>x_push_demo.PriceUtils</api_name>')
  const result = await cli('update-set-package', '--update-set-name', 'to y', '--scope', 'y_scope',
    '--scope-id', 'dd44cd34ef56ab12cd34ef56ab12cd34', '--include', SI_ID, '--move-adopted')
  assert.equal(result.status, 0, result.output)
  assert.ok(updateSetXml('to-y').includes('y_scope.PriceUtils'))
  assert.ok(!updateSetXml('to-y').includes('x_push_demo.PriceUtils'))
})
