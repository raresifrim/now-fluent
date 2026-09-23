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
// AS that application (?sysparm_transaction_scope). undeletableScopes: rows in these
// scopes refuse every DELETE.
export async function startMockInstance({
  records = {}, honoursScope = false, captureInto = null, captureFollowsPreference = false, putReplaces = false,
  honoursTransactionScope = false, noScopeTables = [], protectedFromGlobal = false, undeletableScopes = []
} = {}) {
  const store = new Map(Object.entries(records))
  const log = []
  let clock = 0
  const stamp = () => `2026-01-01 00:00:${String(++clock).padStart(2, '0')}`

  const CAPTURED = new Set(['sys_script_include', 'sys_script', 'sys_ui_policy', 'sys_properties'])
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/api/now/ui/user/current_user') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ result: { user_sys_id: 'user0000000000000000000000000001', user_name: 'admin' } }))
    }

    const [, , , , table, sysId] = url.pathname.split('/') // /api/now/table/<t>/<id>
    let raw = ''
    for await (const chunk of req) raw += chunk
    const parsed = raw ? JSON.parse(raw) : undefined
    log.push({ method: req.method, table, sysId, body: parsed, params: Object.fromEntries(url.searchParams) })

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
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
      const transactionScope = url.searchParams.get('sysparm_transaction_scope')
      const honoured = Array.isArray(honoursTransactionScope)
        ? honoursTransactionScope.includes(table) : honoursTransactionScope
      if (honoured && transactionScope) {
        row.sys_scope = transactionScope
      } else if (!honoursScope && row.sys_scope && row.sys_scope !== 'global') {
        row.sys_scope = 'global'
        if (row.api_name) row.api_name = String(row.api_name).replace(/^[^.]+\./, 'global.')
      }
      // Like the platform: a record created without a scope gets the transaction's —
      // Global, unless the create ran as an application.
      if (!row.sys_scope) row.sys_scope = (honoured && transactionScope) || 'global'
      if (noScopeTables.includes(table)) delete row.sys_scope
      store.set(`${table}/${id}`, row)
      noteCapture(table, id)
      return send(201, { result: { sys_id: id } })
    }
    if (req.method === 'PUT') {
      const row = store.get(key)
      if (!row) return send(404, { error: { message: 'No record found' } })
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
      const runAs = url.searchParams.get('sysparm_transaction_scope') || 'global'
      if (rowScope && (undeletableScopes.includes(rowScope)
        || (protectedFromGlobal && rowScope !== 'global' && rowScope !== runAs))) {
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
