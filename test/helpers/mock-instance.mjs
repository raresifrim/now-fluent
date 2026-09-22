// A minimal stand-in for the ServiceNow Table API.
//
// NOTE ON FIDELITY: PUT here MERGES (fields absent from the body keep their values),
// and POST honours a supplied sys_id. Those are exactly the two platform behaviours
// push is built on, and they are what scripts/verify-push.mjs proves live. So these
// tests verify that now-fluent's CLIENT is correct GIVEN those semantics — they
// cannot themselves prove the platform provides them.
import { createServer } from 'node:http'

export async function startMockInstance({ records = {}, honoursScope = false } = {}) {
  const store = new Map(Object.entries(records))
  const log = []
  let clock = 0
  const stamp = () => `2026-01-01 00:00:${String(++clock).padStart(2, '0')}`

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const [, , , , table, sysId] = url.pathname.split('/') // /api/now/table/<t>/<id>
    let raw = ''
    for await (const chunk of req) raw += chunk
    const parsed = raw ? JSON.parse(raw) : undefined
    log.push({ method: req.method, table, sysId, body: parsed })

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
      // Just enough sysparm_query to serve the shapes now-fluent actually sends.
      const q = url.searchParams.get('sysparm_query') || ''
      const wanted = q.startsWith('sys_idIN') ? q.slice('sys_idIN'.length).split(/[,^]/)
        : q.startsWith('sys_id=') ? [q.slice('sys_id='.length).split('^')[0]]
          : null
      const rows = [...store.entries()]
        .filter(([k]) => k.startsWith(`${table}/`))
        .map(([, v]) => v)
        .filter((row) => !wanted || wanted.includes(row.sys_id))
      return send(200, { result: rows.map(project) })
    }
    if (req.method === 'POST') {
      const id = parsed && parsed.sys_id
      if (!id) return send(400, { error: { message: 'insert without sys_id' } })
      if (store.has(`${table}/${id}`)) return send(403, { error: { message: 'already exists' } })
      // VERIFIED LIVE: the Table API IGNORES sys_scope and puts the record in the scope
      // the REST transaction runs in — Global — rewriting api_name to match. The mock
      // reproduces that by default; honoursScope:true models the world we wrongly
      // assumed, so a test can prove push behaves correctly in both.
      const row = { ...parsed, sys_updated_on: stamp(), sys_mod_count: '0' }
      if (!honoursScope && row.sys_scope && row.sys_scope !== 'global') {
        row.sys_scope = 'global'
        if (row.api_name) row.api_name = String(row.api_name).replace(/^[^.]+\./, 'global.')
      }
      store.set(`${table}/${id}`, row)
      return send(201, { result: { sys_id: id } })
    }
    if (req.method === 'PUT') {
      const row = store.get(key)
      if (!row) return send(404, { error: { message: 'No record found' } })
      const next = { ...row, ...parsed, sys_updated_on: stamp(), sys_mod_count: String(Number(row.sys_mod_count || 0) + 1) }
      if (!honoursScope) next.sys_scope = row.sys_scope // inert on update too
      store.set(key, next)
      return send(200, { result: { sys_id: sysId } })
    }
    if (req.method === 'DELETE') {
      store.delete(key)
      return send(204, {})
    }
    return send(405, { error: { message: 'method not allowed' } })
  })

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
