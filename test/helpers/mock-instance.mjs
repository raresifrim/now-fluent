// A minimal stand-in for the ServiceNow Table API.
//
// NOTE ON FIDELITY: PUT here MERGES (fields absent from the body keep their values),
// and POST honours a supplied sys_id. Those are exactly the two platform behaviours
// push is built on, and they are what scripts/verify-push.mjs proves live. So these
// tests verify that now-fluent's CLIENT is correct GIVEN those semantics — they
// cannot themselves prove the platform provides them.
import { createServer } from 'node:http'

// captureInto: where the platform files sys_update_xml rows for metadata writes.
// Default 'default-set', deliberately NOT whatever the sys_update_set preference says —
// that is the live-verified behaviour --update-set has to cope with. Set
// captureFollowsPreference:true to model an instance where the preference IS honoured.
// putReplaces:true models the one platform behaviour that would make push UNSAFE — a
// PUT that replaces the record rather than merging into it — so the spike can be shown
// to catch it.
// honoursTransactionScope:true models an instance that runs a REST write as the
// application named by ?sysparm_transaction_scope=<app sys_id> — the create then lands
// in that scope. Default false: the param is ignored like the body's sys_scope, and the
// create lands in Global. An ARRAY of table names honours it for those tables only (a
// table-specific difference, which push's post-create check must still catch).
// noScopeTables: tables whose rows are stored without a sys_scope, so a read-back
// cannot tell where a record landed.
// protectedFromGlobal:true models what was seen live in sn_sow: a record inside an
// application refuses a DELETE run from any other scope (HTTP 403) and accepts one run
// AS that application (?sysparm_transaction_scope). (Live, only the DELETE was seen; the
// mock refuses a PUT the same way, which the spike's update lines check on a real instance.) undeletableScopes: rows in these
// scopes refuse every DELETE.
// currentApp: the account's current application (the app picker), as a sys_scope sys_id.
// Seen live: with the picker on sn_sow, a plain REST create landed in sn_sow. A write
// with no honoured ?sysparm_transaction_scope runs there; default 'global'. Stored as the
// apps.current_app preference so a caller can read it.
// flowActivation: how POST /api/now/wfa_fluent/activate_flows (the call install makes
// after writing a flow) answers — 'ok' (activates: active=true, status=published),
// 'missing' (the 400 an instance without the ServiceNow IDE returns), or 'fail' (422).
// fluentLoad: how POST /api/fluent/load/<scope> (the loader install uses for a
// configuration project) answers — 'ok' applies every <record_update> in the uploaded
// files (records merged, delete_multiple directives run, sys_scope taken from the payload)
// and returns the update set it captured into; 'missing' is the 400 of an instance
// without the ServiceNow IDE. The mock cannot model what the platform ADDS when it loads
// a flow (the part a Table API write misses) — only live runs can show that.
export async function startMockInstance({
  records = {}, honoursScope = false, captureInto = null, captureFollowsPreference = false, putReplaces = false,
  honoursTransactionScope = false, noScopeTables = [], protectedFromGlobal = false, undeletableScopes = [],
  currentApp = 'global', flowActivation = 'ok', fluentLoad = 'ok'
} = {}) {
  const store = new Map(Object.entries(records))
  const USER_ID = 'user0000000000000000000000000001'
  if (currentApp !== 'global') {
    store.set('sys_user_preference/pref00000000000000000000currentapp',
      { sys_id: 'pref00000000000000000000currentapp', name: 'apps.current_app', user: USER_ID, value: currentApp })
  }
  // The scope a write runs in: the honoured transaction scope, else the current app.
  const runsIn = (url, table) => {
    const asked = url.searchParams.get('sysparm_transaction_scope')
    const honoured = Array.isArray(honoursTransactionScope) ? honoursTransactionScope.includes(table) : honoursTransactionScope
    return (honoured && asked) || currentApp
  }
  const log = []
  let clock = 0
  const stamp = () => `2026-01-01 00:00:${String(++clock).padStart(2, '0')}`

  const CAPTURED = new Set(['sys_script_include', 'sys_script', 'sys_ui_policy', 'sys_properties'])
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/api/now/ui/user/current_user') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ result: { user_sys_id: USER_ID, user_name: 'admin' } }))
    }

    const [, , , , table, sysId] = url.pathname.split('/') // /api/now/table/<t>/<id>
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (url.pathname.startsWith('/api/fluent/load/')) {
      const scope = decodeURIComponent(url.pathname.split('/')[4] || '')
      log.push({ method: req.method, table: 'fluent_load', sysId: scope, body: raw, params: Object.fromEntries(url.searchParams) })
      res.writeHead(fluentLoad === 'missing' ? 400 : 200, { 'Content-Type': 'application/json' })
      if (fluentLoad === 'missing') {
        return res.end(JSON.stringify({ error: { message: `Requested URI does not represent any resource: ${url.pathname}` } }))
      }
      const target = url.searchParams.get('targetUpdateSetId') || 'loadset0000000000000000000000001'
      for (const file of raw.match(/<record_update\b[\s\S]*?<\/record_update>/g) || []) {
        const updateName = loadRecordUpdate(file, scope)
        // The loader captures the whole file as one update, named after its first record.
        const rowId = `cap${String(++clock).padStart(29, '0')}`
        if (updateName) store.set(`sys_update_xml/${rowId}`, { sys_id: rowId, name: updateName, update_set: target, sys_created_on: stamp() })
      }
      return res.end(JSON.stringify({ result: { targetUpdateSetId: target } }))
    }
    const parsed = raw ? JSON.parse(raw) : undefined
    log.push({ method: req.method, table, sysId, body: parsed, params: Object.fromEntries(url.searchParams) })

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/api/now/wfa_fluent/activate_flows') {
      if (flowActivation === 'missing') {
        return send(400, { error: { message: 'Requested URI does not represent any resource: /api/now/wfa_fluent/activate_flows' } })
      }
      const entries = [...(parsed.flows || []).map((f) => ['sys_hub_flow', f]), ...(parsed.actions || []).map((a) => ['sys_hub_action_type_definition', a])]
      const results = entries.map(([t, entry]) => {
        const row = store.get(`${t}/${entry.sys_id}`)
        if (!row) return { sys_id: entry.sys_id, status: 'error', message: 'No such flow' }
        // Seen live: an activation attempt writes the flow record even when publishing fails.
        row.sys_mod_count = String(Number(row.sys_mod_count || 0) + 1)
        row.sys_updated_on = stamp()
        if (flowActivation === 'fail') {
          return { sys_id: entry.sys_id, status: 'error', error_code: 'PUBLISH_FAILED',
            message: `Error publishing flow sys id ${entry.sys_id}: No Trigger instance found in the flow definition` }
        }
        row.active = 'true'
        row.status = 'published'
        return { sys_id: entry.sys_id, flow_name: row.name, status: 'success' }
      })
      const failed = results.filter((r) => r.status !== 'success').length
      return send(failed === results.length && results.length ? 422 : 200,
        { result: { summary: { total: results.length, succeeded: results.length - failed, failed }, results } })
    }
    const key = `${table}/${sysId}`
    const project = (row) => {
      const fields = url.searchParams.get('sysparm_fields')
      if (!fields || !row) return row
      return Object.fromEntries(fields.split(',').map((f) => [f, row[f] ?? '']))
    }

    if (req.method === 'GET' && sysId) {
      const row = store.get(key)
      return row ? send(200, { result: project(row) }) : send(404, { error: { message: 'No record found' } })
    }
    if (req.method === 'GET') {
      const rows = [...store.entries()]
        .filter(([k]) => k.startsWith(`${table}/`))
        .map(([, v]) => v)
        .filter((row) => matchesQuery(row, url.searchParams.get('sysparm_query') || ''))
      applyOrder(rows, url.searchParams.get('sysparm_query') || '')
      const limit = Number(url.searchParams.get('sysparm_limit') || rows.length)
      return send(200, { result: rows.slice(0, limit).map(project) })
    }
    if (req.method === 'POST') {
      // Like the platform: honour a supplied sys_id, generate one otherwise.
      const id = (parsed && parsed.sys_id) || `gen${String(++clock).padStart(29, '0')}`
      if (store.has(`${table}/${id}`)) return send(403, { error: { message: 'already exists' } })
      // VERIFIED LIVE: the Table API IGNORES sys_scope and puts the record in the scope
      // the REST transaction runs in — Global — rewriting api_name to match. The mock
      // reproduces that by default; honoursScope:true models the world we wrongly
      // assumed, so a test can prove push behaves correctly in both.
      const row = { ...parsed, sys_id: id, sys_updated_on: stamp(), sys_mod_count: '0' }
      // The record lands in the scope the transaction runs in, and api_name follows it.
      if (!(honoursScope && row.sys_scope)) {
        const scope = runsIn(url, table)
        if (row.api_name) {
          const name = scope === 'global' ? 'global' : (store.get(`sys_scope/${scope}`) || {}).scope || scope
          row.api_name = String(row.api_name).replace(/^[^.]+\./, `${name}.`)
        }
        row.sys_scope = scope
      }
      if (noScopeTables.includes(table)) delete row.sys_scope
      store.set(`${table}/${id}`, row)
      noteCapture(table, id)
      return send(201, { result: { sys_id: id } })
    }
    if (req.method === 'PUT') {
      const row = store.get(key)
      if (!row) return send(404, { error: { message: 'No record found' } })
      if (protectedFromGlobal && row.sys_scope && row.sys_scope !== 'global' && row.sys_scope !== runsIn(url, table)) {
        return send(403, { error: { message: 'Operation Failed', detail: 'write not permitted from this scope' } })
      }
      const base = putReplaces ? { sys_id: row.sys_id, sys_scope: row.sys_scope } : row
      const next = { ...base, ...parsed, sys_updated_on: stamp(), sys_mod_count: String(Number(row.sys_mod_count || 0) + 1) }
      if (!honoursScope) next.sys_scope = row.sys_scope // inert on update too
      store.set(key, next)
      noteCapture(table, sysId)
      return send(200, { result: { sys_id: sysId } })
    }
    if (req.method === 'DELETE') {
      const row = store.get(key)
      const rowScope = row && row.sys_scope
      if (rowScope && (undeletableScopes.includes(rowScope)
        || (protectedFromGlobal && rowScope !== 'global' && rowScope !== runsIn(url, table)))) {
        return send(403, { error: { message: 'Operation Failed', detail: 'delete not permitted from this scope' } })
      }
      store.delete(key)
      return send(204, {})
    }
    return send(405, { error: { message: 'method not allowed' } })
  })

  // A small encoded-query evaluator: enough of ServiceNow's syntax for the shapes
  // now-fluent actually sends (field=value, fieldINa,b, and ORDERBY clauses), so the
  // mock filters like the real Table API instead of returning everything.
  function matchesQuery(row, query) {
    if (!query) return true
    for (const clause of query.split('^')) {
      if (!clause || /^ORDERBY/i.test(clause)) continue
      const notIn = clause.match(/^(\w+?)NOT IN(.*)$/)
      if (notIn) {
        if (notIn[2].split(',').includes(String(row[notIn[1]] ?? ''))) return false
        continue
      }
      // Before IN: a STARTSWITH value may itself contain "IN".
      const starts = clause.match(/^(\w+?)STARTSWITH(.*)$/)
      if (starts) {
        if (!String(row[starts[1]] ?? '').startsWith(starts[2])) return false
        continue
      }
      const inMatch = clause.match(/^(\w+)IN(.*)$/)
      if (inMatch) {
        const [, field, list] = inMatch
        if (!list.split(',').includes(String(row[field] ?? ''))) return false
        continue
      }
      const eq = clause.match(/^(\w+)=(.*)$/)
      if (eq) {
        const [, field, value] = eq
        if (String(row[field] ?? '') !== value) return false
        continue
      }
      const ne = clause.match(/^(\w+)!=(.*)$/)
      if (ne && String(row[ne[1]] ?? '') === ne[2]) return false
    }
    return true
  }

  // Apply one <record_update> like the loader: records in document order, merged onto any
  // existing row; delete_multiple directives remove what their query matches.
  function loadRecordUpdate(xml, scope) {
    const decode = (v) => v.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    const body = xml.replace(/^<record_update\b[^>]*>/, '').replace(/<\/record_update>$/, '')
    const re = /<([A-Za-z0-9_]+)\s+action="([A-Za-z_]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g
    let match
    let updateName = ''
    while ((match = re.exec(body)) !== null) {
      const [, t, action, attrs, inner] = match
      if (action === 'delete_multiple') {
        const query = decode((attrs.match(/query="([^"]*)"/) || [])[1] || '')
        for (const [k, row] of [...store.entries()]) {
          if (k.startsWith(`${t}/`) && matchesQuery(row, query)) store.delete(k)
        }
        continue
      }
      const fields = {}
      const fieldRe = /<([A-Za-z0-9_]+)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1>)/g
      let field
      while ((field = fieldRe.exec(inner || '')) !== null) fields[field[1]] = decode(field[2] || '')
      const id = fields.sys_id
      if (!id) continue
      if (!updateName) updateName = `${t}_${id}`
      const existing = store.get(`${t}/${id}`)
      store.set(`${t}/${id}`, {
        ...(existing || {}), ...fields, sys_scope: fields.sys_scope || scope, sys_updated_on: stamp(),
        sys_mod_count: existing ? String(Number(existing.sys_mod_count || 0) + 1) : '0'
      })
    }
    return updateName
  }

  function applyOrder(rows, query) {
    const desc = query.match(/ORDERBYDESC(\w+)/i)
    const asc = query.match(/(?:^|\^)ORDERBY(?!DESC)(\w+)/i)
    const field = desc ? desc[1] : asc ? asc[1] : null
    if (!field) return
    rows.sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')))
    if (desc) rows.reverse()
  }

  function noteCapture(table, id) {
    if (!CAPTURED.has(table)) return
    const pref = [...store.entries()].find(([k, v]) => k.startsWith('sys_user_preference/') && v.name === 'sys_update_set')
    const destination = captureFollowsPreference && pref && pref[1].value
      ? pref[1].value
      : (captureInto || 'default-set')
    const rowId = `cap${String(++clock).padStart(29, '0')}`
    store.set(`sys_update_xml/${rowId}`, {
      sys_id: rowId, name: `${table}_${id}`, update_set: destination, sys_created_on: stamp()
    })
  }

  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    store,
    log,
    writes: () => log.filter((entry) => entry.method !== 'GET'),
    stop: () => new Promise((done) => server.close(done))
  }
}
