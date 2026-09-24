#!/usr/bin/env node
// A stand-in for now-sdk, just enough for push's code paths. NOW_FLUENT_SDK points
// now-fluent at this file, so the tests never need a real SDK or a real instance.
//   auth --list                        -> the alias/host block push parses for the URL
//   auth --print <a> --format headers  -> the header lines push authenticates with
//   build                              -> a no-op (the test writes the artifacts itself)
// FAKE_SDK_EMULATE_DELETES=1 models how the real SDK tracks deletions, for the live
// runbook's delete phase: transform also writes a source file per record, and build emits
// an action="DELETE" artifact in dist/app/author_elective_update for every record keys.ts
// registers whose source no longer mentions it. Opt-in, so tests that write their own
// artifacts are unaffected.
const argv = process.argv.slice(2)
const host = process.env.FAKE_SDK_HOST || 'http://127.0.0.1:1'

if (argv[0] === 'auth' && argv.includes('--list')) {
  console.log('Listing all credentials: ')
  console.log('*[test]')
  console.log(`      host = ${host}`)
  console.log('      type = basic')
  console.log('      username = admin')
  console.log('      default = Yes')
  process.exit(0)
}
if (argv[0] === 'auth' && argv.includes('--print')) {
  // The real SDK sends logging to stderr and only the headers to stdout.
  console.error('[now-sdk] chatter that must not be parsed as a header')
  console.log('Authorization: Basic ZmFrZTpmYWtl')
  process.exit(0)
}
if (argv[0] === 'build') {
  if (process.env.FAKE_SDK_EMULATE_DELETES === '1') {
    const { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const keysFile = join('src', 'fluent', 'generated', 'keys.ts')
    const sources = []
    const walk = (dir) => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        const file = join(dir, name)
        if (statSync(file).isDirectory()) walk(file)
        else if (file.endsWith('.ts') && name !== 'keys.ts') sources.push(readFileSync(file, 'utf8'))
      }
    }
    walk(join('src', 'fluent'))
    const out = join('dist', 'app', 'author_elective_update')
    rmSync(out, { recursive: true, force: true })
    const keys = existsSync(keysFile) ? readFileSync(keysFile, 'utf8') : ''
    for (const [, id, table] of keys.matchAll(/'([0-9a-f]{32})': \{ table: '([^']+)' \}/g)) {
      if (sources.some((text) => text.includes(id))) continue
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, `${table}_${id}.xml`),
        `<record_update table="${table}"><${table} action="DELETE"><sys_id>${id}</sys_id></${table}></record_update>`)
    }
  }
  console.log('[now-sdk] build ok (fake)')
  process.exit(0)
}
if (argv[0] === 'query' && argv.includes('--help')) {
  console.log('--query Encoded query string (sysparm_query)')
  process.exit(0)
}

const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// `query <table>` reads the mock instance for real, and prints the one-line envelope
// the SDK prints, so queryRecords' paging and parsing are genuinely exercised.
if (argv[0] === 'query') {
  const table = argv[1]
  const url = new URL(`${host}/api/now/table/${table}`)
  url.searchParams.set('sysparm_query', valueOf('--query') || valueOf('-q') || '')
  url.searchParams.set('sysparm_limit', valueOf('--limit') || '100')
  url.searchParams.set('sysparm_offset', valueOf('--offset') || '0')
  const fields = valueOf('--fields') || valueOf('-f')
  if (fields) url.searchParams.set('sysparm_fields', fields)
  const response = await fetch(url)
  const payload = await response.json()
  const records = Array.isArray(payload.result) ? payload.result : []
  console.log(JSON.stringify({ ok: true, hasMore: false, nextOffset: null, records }))
  process.exit(0)
}

// `transform --from <dir>` stands in for the real code generation: it registers each
// record in keys.ts the way now-sdk does, which is what pull's resume logic reads.
if (argv[0] === 'transform' && argv.includes('--from')) {
  const { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const from = valueOf('--from')
  const directory = valueOf('--directory') || process.cwd()
  const files = statSync(from).isDirectory() ? readdirSync(from).map((f) => join(from, f)) : [from]
  const keysFile = join(directory, 'src', 'fluent', 'generated', 'keys.ts')
  mkdirSync(dirname(keysFile), { recursive: true })
  let keys = existsSync(keysFile) ? readFileSync(keysFile, 'utf8') : 'export const keys = {\n}\n'
  for (const file of files) {
    const xml = readFileSync(file, 'utf8')
    const id = (xml.match(/<sys_id>([0-9a-f]{32})<\/sys_id>/) || [])[1]
    const table = (xml.match(/<record_update table="([^"]+)"/) || [])[1]
    if (!id) continue
    if (process.env.FAKE_SDK_EMULATE_DELETES === '1') {
      const src = join(directory, 'src', 'fluent', 'generated', `${table}_${id}.now.ts`)
      mkdirSync(dirname(src), { recursive: true })
      writeFileSync(src, `// fake Fluent source\nRecord({ $id: Now.ID['${id}'], table: '${table}' })\n`)
    }
    if (keys.includes(`'${id}': {`)) continue
    keys = keys.replace(/\n\}\n?$/, `\n  '${id}': { table: '${table}' },\n}\n`)
  }
  writeFileSync(keysFile, keys)
  console.log('Transform completed successfully')
  process.exit(0)
}

// The ONLINE transform (`transform --table <t> --id <id>`): the real SDK reads the record —
// for a flow, its whole graph — from the instance. The fake registers the id in keys.ts.
if (argv[0] === 'transform' && argv.includes('--id')) {
  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const id = valueOf('--id')
  const table = valueOf('--table')
  const keysFile = join(valueOf('--directory') || process.cwd(), 'src', 'fluent', 'generated', 'keys.ts')
  mkdirSync(dirname(keysFile), { recursive: true })
  let keys = existsSync(keysFile) ? readFileSync(keysFile, 'utf8') : 'export const keys = {\n}\n'
  if (!keys.includes(`'${id}': {`)) keys = keys.replace(/\n\}\n?$/, `\n  '${id}': { table: '${table}' },\n}\n`)
  writeFileSync(keysFile, keys)
  console.log(`Transform completed successfully (online, ${table} ${id})`)
  process.exit(0)
}

console.error(`fake-sdk: unhandled command: ${argv.join(' ')}`)
process.exit(1)
