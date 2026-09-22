// Offline tests for the pure parsing layer push depends on. Everything here runs
// without an instance: these are the parts that turn a built <record_update> artifact
// back into the JSON body of a Table API write.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseRecordUpdateRecords, recordFieldsToPayload, recordJsonToXml,
  parseAuthHosts, parseHeaderLines, PUSH_READONLY_FIELDS
} from '../bin/now-fluent.mjs'

test('round-trips a record through recordJsonToXml and back', () => {
  const row = {
    sys_id: 'a'.repeat(32),
    name: 'MyScript',
    active: 'true',
    description: 'Tom & Jerry <best> "friends"',
    script: 'var a = 1 < 2 && 3 > 2;\nfunction f() { return "<x>" }',
    sys_scope: 'b'.repeat(32),
    empty_field: ''
  }
  const xml = recordJsonToXml('sys_script_include', row)
  const [record] = parseRecordUpdateRecords(xml)

  assert.equal(record.table, 'sys_script_include')
  assert.equal(record.action, 'INSERT_OR_UPDATE')
  assert.equal(record.sysId, row.sys_id)
  for (const [key, value] of Object.entries(row)) {
    assert.equal(record.fields[key], value, `field ${key} did not round-trip`)
  }
})

test('CDATA containing "]]>" survives the split-and-rejoin', () => {
  const script = 'var s = "]]>"; // and more ]]> here'
  const xml = recordJsonToXml('sys_script', { sys_id: 'c'.repeat(32), script })
  const [record] = parseRecordUpdateRecords(xml)
  assert.equal(record.fields.script, script)
})

test('CDATA content is NOT entity-decoded, plain text IS', () => {
  // A script in CDATA holds "&amp;" literally; a short plain value is entity-encoded
  // by the writer and must decode back to "&".
  const xml = [
    '<record_update table="sys_script_include">',
    '  <sys_script_include action="INSERT_OR_UPDATE">',
    '    <script><![CDATA[var x = "&amp;" + "<b>";]]></script>',
    '    <name>A &amp; B</name>',
    `    <sys_id>${'d'.repeat(32)}</sys_id>`,
    '  </sys_script_include>',
    '</record_update>'
  ].join('\n')
  const [record] = parseRecordUpdateRecords(xml)
  assert.equal(record.fields.script, 'var x = "&amp;" + "<b>";')
  assert.equal(record.fields.name, 'A & B')
})

test('a script field containing a closing record tag does not break parsing', () => {
  const script = 'var evil = "</sys_script_include><field>gotcha</field>";'
  const xml = recordJsonToXml('sys_script_include', { sys_id: 'e'.repeat(32), name: 'Evil', script })
  const records = parseRecordUpdateRecords(xml)
  assert.equal(records.length, 1)
  assert.equal(records[0].fields.script, script)
  assert.equal(records[0].fields.name, 'Evil')
})

test('empty fields parse as empty strings, with or without attributes', () => {
  const xml = [
    '<record_update table="sys_ui_policy">',
    '  <sys_ui_policy action="INSERT_OR_UPDATE">',
    '    <script_true/>',
    '    <sys_scope display_value="Global">global</sys_scope>',
    '    <sys_domain display_value="global"/>',
    `    <sys_id>${'f'.repeat(32)}</sys_id>`,
    '  </sys_ui_policy>',
    '</record_update>'
  ].join('\n')
  const [record] = parseRecordUpdateRecords(xml)
  assert.equal(record.fields.script_true, '')
  assert.equal(record.fields.sys_domain, '')
  // The value is the sys_id, never the display_value — a push writes references, not labels.
  assert.equal(record.fields.sys_scope, 'global')
})

test('a payload carrying several sibling records yields all of them', () => {
  const parent = 'a'.repeat(32)
  const child = 'b'.repeat(32)
  const xml = [
    '<record_update table="sys_ui_list">',
    `  <sys_ui_list action="INSERT_OR_UPDATE"><sys_id>${parent}</sys_id><name>incident</name></sys_ui_list>`,
    `  <sys_ui_list_element action="INSERT_OR_UPDATE"><sys_id>${child}</sys_id><element>number</element></sys_ui_list_element>`,
    '</record_update>'
  ].join('\n')
  const records = parseRecordUpdateRecords(xml)
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((r) => r.table), ['sys_ui_list', 'sys_ui_list_element'])
  assert.deepEqual(records.map((r) => r.sysId), [parent, child])
})

test('a DELETE payload keeps its action', () => {
  const xml = `<record_update table="sys_script"><sys_script action="DELETE"><sys_id>${'9'.repeat(32)}</sys_id></sys_script></record_update>`
  const [record] = parseRecordUpdateRecords(xml)
  assert.equal(record.action, 'DELETE')
})

test('recordFieldsToPayload drops sys_id and instance-owned bookkeeping', () => {
  const fields = {
    sys_id: 'a'.repeat(32),
    name: 'Keep me',
    sys_scope: 'global',
    sys_created_on: '2024-01-01 00:00:00',
    sys_updated_on: '2024-02-02 00:00:00',
    sys_mod_count: '7',
    sys_class_name: 'sys_script_include',
    sys_update_name: 'sys_script_include_aaa',
    sys_package: 'global',
    sys_policy: ''
  }
  const payload = recordFieldsToPayload(fields)
  assert.deepEqual(Object.keys(payload).sort(), ['name', 'sys_scope'])
  for (const readonly of PUSH_READONLY_FIELDS) {
    assert.ok(!(readonly in payload), `${readonly} must not be written`)
  }
})

test('recordFieldsToPayload can omit sys_scope for --no-scope', () => {
  const payload = recordFieldsToPayload({ sys_id: 'a'.repeat(32), name: 'x', sys_scope: 'global' }, { keepScope: false })
  assert.deepEqual(Object.keys(payload), ['name'])
})

test('parseAuthHosts reads aliases and hosts out of "auth --list" output', () => {
  const output = [
    'Listing all credentials: ',
    '*[dev]',
    '      host = https://dev12345.service-now.com/',
    '      type = basic',
    '      username = admin',
    '      default = Yes',
    '[prod]',
    '      host = https://acme.service-now.com/',
    '      type = oauth',
    '      default = No'
  ].join('\n')
  const hosts = parseAuthHosts(output)
  assert.equal(hosts.get('dev'), 'https://dev12345.service-now.com/')
  assert.equal(hosts.get('prod'), 'https://acme.service-now.com/')
})

test('parseHeaderLines takes header lines and ignores anything else', () => {
  const headers = parseHeaderLines('Authorization: Basic YWRtaW46eA==\nX-UserToken: abc123\n\nnot a header line\n')
  assert.deepEqual(headers, { Authorization: 'Basic YWRtaW46eA==', 'X-UserToken': 'abc123' })
})

// --- regressions for bugs caught in review --------------------------------

test('an attribute value containing ">" does not corrupt the field value', () => {
  // Legal XML, and a display_value the platform really does emit. A naive [^>]*
  // attribute run cuts the tag in the wrong place and silently corrupts the value
  // that push would then write to the live record.
  const xml = [
    '<record_update table="sys_ui_policy">',
    '  <sys_ui_policy action="INSERT_OR_UPDATE">',
    '    <table display_value="Task &gt; Incident">incident</table>',
    '    <parent display_value="A > B">something</parent>',
    '    <short_description display_value="x > y"/>',
    `    <sys_id>${'7'.repeat(32)}</sys_id>`,
    '  </sys_ui_policy>',
    '</record_update>'
  ].join('\n')
  const [record] = parseRecordUpdateRecords(xml)
  assert.equal(record.fields.table, 'incident')
  assert.equal(record.fields.parent, 'something')
  assert.equal(record.fields.short_description, '')
  assert.equal(record.sysId, '7'.repeat(32))
})

test('action= does not have to be the first attribute', () => {
  const xml = `<record_update table="sys_script"><sys_script sys_domain="global" action="DELETE">`
    + `<sys_id>${'8'.repeat(32)}</sys_id></sys_script></record_update>`
  const [record] = parseRecordUpdateRecords(xml)
  assert.equal(record.action, 'DELETE')
  assert.equal(record.table, 'sys_script')
})

test('single-quoted attributes parse too', () => {
  const xml = `<record_update table='sys_script'><sys_script action='INSERT_OR_UPDATE'>`
    + `<name display_value='A > B'>x</name><sys_id>${'6'.repeat(32)}</sys_id></sys_script></record_update>`
  const [record] = parseRecordUpdateRecords(xml)
  assert.equal(record.action, 'INSERT_OR_UPDATE')
  assert.equal(record.fields.name, 'x')
})
