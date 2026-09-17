#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, basename, dirname, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

const VERSION = '1.1.0'

// The ServiceNow SDK executable. Override with NOW_FLUENT_SDK, e.g.
//   NOW_FLUENT_SDK="npx @servicenow/sdk"
const SDK_BIN = process.env.NOW_FLUENT_SDK || 'now-sdk'

// Commands handled by now-fluent itself. EVERY other command (and its exact
// arguments) is forwarded verbatim to now-sdk, so any current or future now-sdk
// command works unchanged.
const ENHANCED = new Set(['help', '--help', '-h', '--version', '-v', 'doctor', 'import', 'import-update-set', 'export-xml', 'update-set-package'])

const BOOLEAN_FLAGS = new Set(['build-local', 'zip', 'no-bundle', 'dry-run', 'keep', 'no-flows', 'bulk', 'keep-failed', 'force', 'no-related'])

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`
now-fluent v${VERSION}

A thin wrapper around the ServiceNow SDK ("now-sdk") that adds Fluent-focused
helpers. Any now-sdk command you pass is forwarded verbatim, so you can use
now-fluent as a drop-in for now-sdk:

  now-fluent <now-sdk-command> [...exact now-sdk args]

Examples (forwarded unchanged to now-sdk):
  now-fluent auth --add https://dev12345.service-now.com
  now-fluent init --appName "My App" --scopeName x_my_app --template base
  now-fluent build
  now-fluent transform --auth dev --table sys_script_include --id <sysid>
  now-fluent install --auth dev
  now-fluent explain BusinessRule

The SDK executable defaults to "now-sdk" on PATH. Override it with the
NOW_FLUENT_SDK environment variable (e.g. NOW_FLUENT_SDK="npx @servicenow/sdk").

Enhanced commands (handled by now-fluent):

  doctor
      Report now-fluent, Node, and now-sdk versions.

  import [--project <path>] --auth <alias>
         [--sys-id <32hex>[,<32hex>...] | --query <encoded query> --table <table>]
         [--table <table>] [--via auto|move|transform|query] [--limit <n>]
         [--no-related] [--out <dir>] [--keep] [--keep-failed] [--force]
         [--dry-run] [-- <extra now-sdk args>]
      Import records into a local project. Three strategies, tried in this order
      unless --via names one:
        move       one call, but needs the target app to exist on the instance
        transform  online per record ("transform --table <t> --id <id>"); resolves
                   relationships itself, but the SDK's scope checks refuse records
                   outside the project's app
        query      read the row with "now-sdk query" (plain Table REST API),
                   rebuild its <record_update> XML locally and transform that
                   OFFLINE — no scope-gated endpoint in the path, so it still
                   works when move and transform are refused
      --table is now optional: the table of any sys_id is resolved from
      sys_metadata.sys_class_name with one query, so the old "cannot fall back to
      transform without a table" dead end is gone. Pass --table anyway for records
      that do not extend sys_metadata (plain data tables).
      --query <encoded query> imports every record matching a query instead of a
      sys_id list (needs --table), e.g.
        --table sys_script_include --query "sys_scope.scope=x_my_app^active=true"
      It defaults to --via query and skips records already registered in the
      project's keys.ts, so an interrupted bulk import can just be re-run (--force
      re-imports everything). --limit <n> caps how many records it takes.
      The query path fetches each record's family children (a UI policy's actions,
      an ACL's roles, an import map's entries — the TRANSFORM_TOGETHER families)
      and transforms them in the SAME call, so now-sdk cannot define a child twice;
      --no-related imports the record alone. Its child columns are discovered from
      sys_dictionary, not hard-coded.
      Failures heal like import-update-set: files named in a build ERROR are removed
      (or auto-fixed) and the unit retried, with a verification build at the end;
      --keep-failed leaves them on disk. --out <dir>/--keep preserve the rebuilt XML.
      sys_ids may be given via repeated --sys-id, --ids, comma-separated lists, or
      as positional arguments.

  import-update-set (--from <path> | --sys-id <32hex> | --name "<name>")
                    [--project <path>] [--auth <alias>] [--out <dir>]
                    [--keep] [--no-flows] [--bulk] [--keep-failed] [--force]
                    [--include <substr>...] [--exclude <substr>...] [--dry-run]
                    [-- <extra now-sdk args>]
      Import a ServiceNow update set into a project as Fluent source, from either:
        --from <path>   an update set XML you exported/published manually
        --sys-id <id>   the update set ON THE INSTANCE (needs --auth): its
        --name "<n>"    sys_update_xml rows are read with "now-sdk query", which
                        returns the very same <payload> blobs the export wraps
      Reading it from the instance needs no export step at all, works on an update
      set that is still IN PROGRESS, and is a plain Table API read — so it also
      works where the SDK's own gated update-set download is refused. Both
      sys_update_set (local) and sys_remote_update_set (retrieved) are searched.
      Everything after the source is identical for both: each <payload> is unwrapped
      into an individual <record_update> file and fed to "now-sdk transform --from".
      Progress: by default each record is transformed individually so you see
      "[i/N] importing <table> <sysid>" as it goes (a bad record is reported and
      skipped, not fatal). --bulk runs one transform over the whole folder instead:
      faster and atomic for huge sets, but silent for minutes with no progress.
      Order: family group batches first, then flows (online), then the standalone
      records — the heavy chunks run first so an interrupted run keeps the most
      value and a resume has the least left to do.
      Resume: standalone records whose sys_id is already registered in the
      project's keys.ts are skipped, so re-running after an interruption only
      imports what's missing; --force re-imports/overwrites everything. A family
      group is skipped only when EVERY record its payloads define (all <sys_id>
      tags, incl. children embedded in parent DSLs) is already registered —
      otherwise the family imports in full. A flow is skipped only when its
      sys_hub_flow id AND all update-set sys_hub_* records referencing it are
      registered. --bulk always imports everything.
      Self-healing: now-sdk builds the whole project after each record, and a record
      can even "succeed" (exit 0) while writing a Fluent object that breaks every
      later build. Per-record mode captures each transform's log; when a build ERROR
      names a file, that file is removed and the record retried, and a final
      verification build cleans up anything the last records left broken. Duplicate
      definition conflicts ('Record ... is defined 2 times') are healed by removing
      the standalone Record() file, keeping the parent that embeds it. Every removed
      file is listed at the end so you can handle those records manually.
      --keep-failed disables the removal and leaves offending files on disk.
      Family grouping: parent/child tables that must be transformed together to avoid
      duplicate definitions are collected into one batch and transformed in a single
      --from call, so children embed into their parent's DSL. Current families:
      sys_transform_map + sys_transform_entry + sys_transform_script (ImportSet),
      sys_ui_list + sys_ui_list_element + sys_ui_list_control (List),
      sys_security_acl + sys_security_acl_role (Acl roles),
      sys_ui_policy + sys_ui_policy_action + sys_ui_policy_rl_action (UiPolicy),
      catalog_ui_policy + catalog_ui_policy_action (CatalogUiPolicy), and
      sys_ui_form(+_sections/_section) + sys_ui_section + sys_ui_element (Form).
      Flows & actions: flow-graph records (sys_hub_*) cannot be transformed offline
      (their action/trigger shapes aren't in the update set), so each custom action
      definition (sys_hub_action_type_definition, imported first) and each flow
      (sys_hub_flow) is routed to the ONLINE per-record transform instead — this
      needs --auth <alias> and contacts the instance. Without --auth they are
      skipped with a notice; --no-flows skips them silently. Everything else stays
      fully local.
      The update set may be given via --from/--sys-id/--name or positionally (a
      32-hex positional is read as a sys_id, anything else as a path). Extracted
      record XML goes to a temp folder (or --out <dir>); --keep preserves it.
      Selecting records (matched against <table>_<sysid>, same as
      update-set-package): --include keeps only matching records, --exclude drops
      matching ones (repeatable AND comma-separated). A good large-export filter:
      --exclude sys_documentation,sys_translated,sys_ui_message,sys_atf_test,sys_atf_step

  export-xml --project <path> [--out <path>] [--build-local] [--zip]
             [--include <substr>...] [--exclude <substr>...]
      Export the project's built record XML to an export folder (with a
      manifest). With --build-local, runs "now-sdk build" first. Local only.
      Exports every built record by default; use --include/--exclude (same
      repeatable, comma-separated, substring matching as update-set-package) to
      export only selected records.

  update-set-package --project <path> [--build-local] [--zip] [--no-bundle]
                     [--update-set-name <name>] [--scope <scope>] [--scope-id <32hex>]
                     [--app-name <name>] [--description <text>] [--owner <user>]
                     [--include <substr>...] [--exclude <substr>...] [--out <path>]
      Build a REAL, directly-importable ServiceNow update set XML from the
      project's built record XML (an <unload> with one sys_remote_update_set and
      one sys_update_xml per selected record), plus a review bundle. Load it via:
      System Update Sets > Retrieved Update Sets > Import Update Set from XML >
      Preview > Commit. Writes files locally only; never touches an instance.

      Identity (defaults read from the project's now.config.json):
        --update-set-name   name shown in ServiceNow (default: generated)
        --scope / --scope-id  application scope + sys_id
        --app-name          application display name
        --description       update set description
        --owner             sys_created_by to stamp (default: admin)

      Selecting records (matched against <table>_<sysid>.xml filenames):
        --include <substr[,substr...]>   keep only matching files
        --exclude <substr[,substr...]>   drop matching files
      Both are repeatable AND accept comma-separated lists. A sys_id selects one
      exact record; a table name selects a type. The SDK emits sys_module records
      for bom.json/package.json — exclude them (e.g. --exclude sys_module) unless
      wanted.

      Output goes to exports/<update-set-name>/ (named after --update-set-name),
      so re-running with the same name overwrites it in place. Use --out for an
      explicit folder.

Common options:
  --dry-run            Print now-sdk commands instead of running them (enhanced
                       commands only).
  --config <path>      JSON config (default: .now-fluent.json if present).

  help, --help         Show this help.

To see now-sdk's own help for a command, just forward it:
  now-fluent <command> --help
`)
}

// ---------------------------------------------------------------------------
// Arg parsing (enhanced commands only)
// ---------------------------------------------------------------------------
function parseFlags(argv) {
  const flags = {}
  const positional = []
  const passthrough = []
  let afterDashDash = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (afterDashDash) { passthrough.push(arg); continue }
    if (arg === '--') { afterDashDash = true; continue }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
      } else {
        const value = argv[++i]
        if (value == null || value.startsWith('--')) fail(`Missing value for --${key}`)
        if (flags[key] == null) flags[key] = value
        else if (Array.isArray(flags[key])) flags[key].push(value)
        else flags[key] = [flags[key], value]
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional, passthrough }
}

function fail(message, code = 1) {
  console.error(`Error: ${message}`)
  process.exit(code)
}

function loadConfig(flags) {
  const configPath = flags.config ? resolve(flags.config) : resolve('.now-fluent.json')
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    fail(`Could not parse config at ${configPath}: ${error.message}`)
  }
}

function splitShellLike(value) {
  if (!value) return []
  const matches = value.match(/(?:[^\s"]+|"[^"]*")+/g) || []
  return matches.map((part) => part.replace(/^"|"$/g, ''))
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (!value) fail(`Missing required --${name}`)
  return value
}

function projectPath(flags, config) {
  const raw = flags.project || config.project
  if (!raw) fail('Missing required --project')
  return resolve(raw)
}

function sysIdsFrom(flags, config, positional = []) {
  const raw = flags['sys-id'] ?? flags.sysId ?? flags.ids ?? config.sysIds
  const flagValues = Array.isArray(raw) ? raw : raw ? [raw] : []
  const values = [...flagValues, ...positional]
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length === 0) fail('Missing at least one --sys-id')
  for (const id of values) {
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      console.warn(`Warning: ${id} does not look like a 32-character ServiceNow sys_id.`)
    }
  }
  return values
}

// ---------------------------------------------------------------------------
// now-sdk invocation
// ---------------------------------------------------------------------------
function runSdk(args, { cwd, dryRun, capture, allowFailure, quiet } = {}) {
  const [cmd, ...base] = splitShellLike(SDK_BIN)
  const fullArgs = [...base, ...args]
  const printable = [cmd, ...fullArgs].map(shellQuote).join(' ')

  if (dryRun) {
    console.log(`[dry-run] ${printable}`)
    return { status: 0, stdout: '', stderr: '' }
  }

  if (!quiet) console.log(`> ${printable}`)
  const result = spawnSync(cmd, fullArgs, {
    cwd: cwd || process.cwd(),
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: process.env,
    // spawnSync buffers captured output in memory and defaults to 1MB, which one page
    // of sys_update_xml payloads (whole records, scripts included) blows through with
    // ENOBUFS. Give captured output room.
    maxBuffer: 512 * 1024 * 1024
  })
  if (result.error) {
    if (result.error.code === 'ENOBUFS') {
      fail(`Output of "${printable}" exceeded the capture buffer. Re-run with a smaller `
        + '--limit, or narrow the query with --include/--exclude.')
    }
    fail(`Failed to run ${cmd}: ${result.error.message}`)
  }
  if (result.status !== 0 && !allowFailure) {
    fail(`Command failed with exit code ${result.status}: ${printable}`, result.status || 1)
  }
  return result
}

// The exact command line runSdk would run, for dry-run plans.
function sdkPrintable(args) {
  const [cmd, ...base] = splitShellLike(SDK_BIN)
  return [cmd, ...base, ...args].map(shellQuote).join(' ')
}

// Forward an arbitrary now-sdk command (and its exact args) verbatim.
function passthrough(argv) {
  const [cmd, ...base] = splitShellLike(SDK_BIN)
  const fullArgs = [...base, ...argv]
  const result = spawnSync(cmd, fullArgs, { stdio: 'inherit', env: process.env })
  if (result.error) {
    fail(`Failed to run ${cmd}: ${result.error.message}. Is the ServiceNow SDK installed? (npm i -g @servicenow/sdk, or set NOW_FLUENT_SDK)`)
  }
  process.exit(result.status ?? 0)
}

// ---------------------------------------------------------------------------
// Instance queries (now-sdk query)
// ---------------------------------------------------------------------------
// `now-sdk query <table> -q <encoded query> --output json` silences its logger and
// prints exactly ONE line:
//   {"ok":true,"hasMore":<bool>,"nextOffset":<number|null>,"records":[...]}
//   {"ok":false,"error":{"message":"...","status":<http>,"table":"..."}}
// It is a plain Table REST API read, so it succeeds where the SDK's scope-gated
// paths are refused (download's company-key/maint check, move's "app must exist on
// the instance", fluent_update_set_export.do's sysparm_ck + app scope) — which is
// exactly the failure mode that blocks import/transform in ServiceNow-owned scopes.
// One invocation returns one page; hasMore/nextOffset drive the paging loop.

let queryCommandSupported = null
function sdkSupportsQuery() {
  if (queryCommandSupported === null) {
    const r = runSdk(['query', '--help'], { capture: true, allowFailure: true, quiet: true })
    queryCommandSupported = r.status === 0 && /sysparm_query/.test(`${r.stdout || ''}${r.stderr || ''}`)
  }
  return queryCommandSupported
}

function parseQueryEnvelope(output) {
  const line = String(output).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (!line) return null
  try { return JSON.parse(line) } catch { return null }
}

// The Table API returns a field either as a plain string (--display-value false) or
// as { value, display_value } (--display-value all). Normalize both.
function fieldParts(raw) {
  if (raw && typeof raw === 'object') {
    const value = raw.value ?? raw.display_value ?? ''
    return { value: value == null ? '' : String(value), display: raw.display_value == null ? '' : String(raw.display_value) }
  }
  return { value: raw == null ? '' : String(raw), display: '' }
}

function fieldValue(raw) {
  return fieldParts(raw).value
}

// Fetch EVERY record matching an encoded query, following the SDK's paging.
function queryRecords({ table, query, fields, auth, displayValue, pageSize = 100, timeout, max = Infinity, label, quiet = true }) {
  if (!auth) fail(`Missing --auth <alias>: reading ${table} from the instance needs credentials.`)
  if (!sdkSupportsQuery()) {
    fail('This now-sdk build has no "query" command (added in SDK 4.10). Upgrade the SDK '
      + '(npm i -g @servicenow/sdk) or use the offline paths (--from <xml>, --table/--id).')
  }
  // Offset paging is only stable when the sort is TOTAL. ServiceNow leaves the order
  // of rows tied on the sort column undefined, and ties are the norm — an update set's
  // sys_update_xml rows can share one sys_created_on by the dozen — so paging without a
  // unique tiebreaker silently skips a row on one page and repeats another on the next.
  // sys_id is unique on every table, so it makes each page deterministic.
  const pagedQuery = /ORDERBY(DESC)?sys_id\b/.test(query) ? query : `${query}^ORDERBYsys_id`

  const rows = []
  let offset = 0
  let pages = 0
  while (rows.length < max) {
    const args = ['query', table, '--query', pagedQuery, '--output', 'json', '--auth', auth,
      '--limit', String(Math.min(pageSize, max - rows.length)), '--offset', String(offset)]
    if (fields) args.push('--fields', fields)
    if (displayValue) args.push('--display-value', displayValue)
    if (timeout) args.push('--timeout', String(timeout))
    const r = runSdk(args, { capture: true, allowFailure: true, quiet })
    const output = `${r.stdout || ''}${r.stderr || ''}`
    const envelope = parseQueryEnvelope(output)
    if (!envelope) {
      fail(`Could not read the response of "now-sdk query ${table}" (exit ${r.status}):\n`
        + stripAnsi(output).trim().slice(0, 800))
    }
    if (envelope.ok === false) {
      const err = envelope.error || {}
      fail(`query ${table} failed: ${err.message || 'unknown error'}${err.status ? ` (HTTP ${err.status})` : ''}`)
    }
    const batch = Array.isArray(envelope.records) ? envelope.records : []
    rows.push(...batch)
    pages++
    if (label && pages > 1) console.log(`  ${label}: ${rows.length} record(s) fetched...`)
    if (!envelope.hasMore || envelope.nextOffset == null || batch.length === 0) break
    offset = envelope.nextOffset
  }
  return rows
}

// ---------------------------------------------------------------------------
// Table API JSON -> <record_update> XML
// ---------------------------------------------------------------------------
// Rebuild the XML that `now-sdk transform --from` reads from a queried JSON row,
// mirroring the shape ServiceNow itself writes into an update set payload:
//   <record_update table="T"><T action="INSERT_OR_UPDATE"><field>v</field>...</T></record_update>
// The SDK's parser drops empty elements and the sys_package/sys_mod_count/
// sys_class_name/sys_update_name bookkeeping fields, and falls back to the raw
// sys_id whenever a reference carries no usable attribute — so a row fetched with
// --display-value all reproduces an export faithfully enough to transform.
const SYS_ID_RE = /^[0-9a-f]{32}$/i

function looksLikeReference(value) {
  // Plain sys_id, a variable pointer (IO:<sysid>), or a glide_list of sys_ids.
  return SYS_ID_RE.test(value) || /^IO:[0-9a-f]{32}$/i.test(value)
    || /^[0-9a-f]{32}(,[0-9a-f]{32})+$/i.test(value)
}

function xmlElement(name, value, attrs = '') {
  if (value === '' || value == null) return `<${name}${attrs}/>`
  const text = String(value)
  if (/[<>&]/.test(text) || text.includes('\n')) {
    // Script/HTML fields go in CDATA, as the platform does. CDATA cannot contain
    // "]]>", so split it across two sections.
    return `<${name}${attrs}><![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]></${name}>`
  }
  return `<${name}${attrs}>${xmlEscape(text)}</${name}>`
}

function recordJsonToXml(table, row) {
  const sysId = fieldValue(row.sys_id)
  const fields = []
  for (const name of Object.keys(row).sort()) {
    if (name.startsWith('@')) continue
    const { value, display } = fieldParts(row[name])
    // display_value only where the platform puts it: on references, so the SDK's
    // coalesce lookups have something to match (it falls back to the sys_id if not).
    const attrs = display && display !== value && looksLikeReference(value)
      ? ` display_value="${xmlEscape(display)}"` : ''
    fields.push(xmlElement(name, value, attrs))
  }
  // Not a real column — the platform's exporter adds it, and now-fluent's own
  // parseRecordUpdate reads it; the SDK parser ignores it.
  if (!('sys_update_name' in row) && sysId) fields.push(`<sys_update_name>${table}_${sysId}</sys_update_name>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<record_update table="${xmlEscape(table)}">\n`
    + `  <${table} action="INSERT_OR_UPDATE">\n    ${fields.join('\n    ')}\n  </${table}>\n</record_update>\n`
}

// ---------------------------------------------------------------------------
// Record discovery via query
// ---------------------------------------------------------------------------
// Every Fluent-transformable record is a sys_metadata descendant, and
// sys_metadata.sys_class_name names the concrete table — so ONE query resolves
// --table for any number of sys_ids. That removes import's old dead end
// ("cannot fall back to transform without a table").
function discoverTables(sysIds, auth) {
  const found = new Map()
  // sys_idIN<list> in one shot, chunked so the encoded query stays a sane length.
  for (let i = 0; i < sysIds.length; i += 50) {
    const chunk = sysIds.slice(i, i + 50)
    const rows = queryRecords({
      table: 'sys_metadata',
      query: `sys_idIN${chunk.join(',')}`,
      fields: 'sys_id,sys_class_name,sys_name,sys_scope',
      displayValue: 'all',
      auth
    })
    for (const row of rows) {
      const id = fieldValue(row.sys_id)
      const table = fieldValue(row.sys_class_name)
      if (id && table) {
        found.set(id, { table, name: fieldValue(row.sys_name), scope: fieldParts(row.sys_scope).display || fieldValue(row.sys_scope) })
      }
    }
  }
  return found
}

// A record's children (a UI policy's actions, an ACL's roles, an import map's entries)
// must be transformed in the SAME call as their parent or now-sdk defines them twice —
// the very families import-update-set batches together. The online
// `transform --table --id` pulls them itself; the query path has to fetch them.
//
// Finding the column that links child to parent is not as simple as asking the
// dictionary for `reference=<parent>^name=<child>`: table inheritance breaks that on
// both sides. catalog_ui_policy_action INHERITS its `ui_policy` column from
// sys_ui_policy_action, and that column references sys_ui_policy — not
// catalog_ui_policy. Matching only the concrete tables finds nothing and the children
// are silently dropped, leaving a policy with no actions. So resolve both tables'
// ancestries and match a column defined ANYWHERE in the child's chain that points at
// ANYTHING in the parent's chain.

// Ancestry stops here: every metadata table extends sys_metadata, so including it
// would make any column referencing sys_metadata look like a link to the parent.
const GENERIC_BASE_TABLES = new Set(['sys_metadata', 'sys_metadata_delete'])

const ancestryCache = new Map()
function tableAncestries(tables, auth) {
  const missing = tables.filter((t) => !ancestryCache.has(t))
  if (missing.length) {
    const superOf = new Map() // table name -> super_class sys_id
    const nameOf = new Map()  // sys_db_object sys_id -> table name
    const absorb = (rows) => {
      const unresolved = []
      for (const row of rows) {
        const name = fieldValue(row.name)
        if (!name) continue
        const superId = fieldValue(row.super_class)
        nameOf.set(fieldValue(row.sys_id), name)
        superOf.set(name, superId || null)
        if (superId && !nameOf.has(superId)) unresolved.push(superId)
      }
      return unresolved
    }
    let pending = absorb(queryRecords({
      table: 'sys_db_object', query: `nameIN${missing.join(',')}`, fields: 'sys_id,name,super_class', auth
    }))
    // Each round climbs one level of the hierarchy; the guard just bounds a cycle.
    for (let level = 0; pending.length && level < 12; level++) {
      pending = absorb(queryRecords({
        table: 'sys_db_object', query: `sys_idIN${pending.join(',')}`, fields: 'sys_id,name,super_class', auth
      }))
    }
    for (const table of missing) {
      const chain = []
      const seen = new Set()
      let current = table
      while (current && !seen.has(current) && !GENERIC_BASE_TABLES.has(current)) {
        seen.add(current)
        chain.push(current)
        const superId = superOf.get(current)
        current = superId ? nameOf.get(superId) : null
      }
      ancestryCache.set(table, chain.length ? chain : [table])
    }
  }
  return new Map(tables.map((t) => [t, ancestryCache.get(t) ?? [t]]))
}

// Every reference column defined anywhere in a family's table chains, fetched in one
// dictionary query and cached per family.
const familyColumnsCache = new Map()
function familyReferenceColumns(groupKey, chains, auth) {
  if (!familyColumnsCache.has(groupKey)) {
    const tables = new Set()
    for (const chain of chains.values()) for (const t of chain) tables.add(t)
    const rows = queryRecords({
      table: 'sys_dictionary',
      query: `nameIN${[...tables].join(',')}^reference!=NULL`,
      fields: 'name,element,reference',
      auth
    })
    familyColumnsCache.set(groupKey, rows
      .map((r) => ({ defining: fieldValue(r.name), column: fieldValue(r.element), target: fieldValue(r.reference) }))
      .filter((c) => c.defining && c.column && c.target))
  }
  return familyColumnsCache.get(groupKey)
}

// Collect the family members of one parent record, walking the family's reference
// graph outward from the parent. Not every member points AT the parent: a Form's
// sections hang off the sys_ui_form_section m2m and its elements off those sections,
// so the walk follows references in BOTH directions and repeats until nothing new
// turns up (form -> form_section -> section -> element).
function relatedChildRows(table, sysId, auth, parentRow) {
  const group = fetchFamilyFor(table)
  if (!group) return []
  const children = group.tables.filter((t) => t !== table)
  const chains = tableAncestries(group.tables, auth)
  const columns = familyReferenceColumns(group.key, chains, auth)
  const inChain = (t, target) => (chains.get(t) ?? [t]).includes(target)
  const idsIn = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f]{32}$/i.test(s))

  const fetched = new Map([[table, new Map([[sysId, parentRow ?? null]])]])
  const pending = new Set(children)
  const out = []

  // Explicit joins first, for members matched against a field VALUE of the parent
  // instead of a sys_id reference. A table declared here is removed from the walk
  // whether or not it returned rows — the walk's view of it would be wrong.
  for (const link of group.links ?? []) {
    pending.delete(link.table)
    const value = parentRow ? fieldValue(parentRow[link.parentField]) : ''
    if (!value) continue
    const found = new Map()
    for (const row of queryRecords({
      table: link.table,
      query: `${link.column}=${value}${link.filter ? `^${link.filter(auth)}` : ''}`,
      displayValue: 'all', auth, pageSize: 200
    })) {
      const id = fieldValue(row.sys_id)
      if (id) found.set(id, row)
    }
    if (!found.size) continue
    fetched.set(link.table, found)
    for (const row of found.values()) out.push({ table: link.table, row })
  }

  for (let round = 0; pending.size && round <= group.tables.length; round++) {
    let progressed = false
    for (const child of [...pending]) {
      const found = new Map()

      // Backward: a column on the child (or a table it extends) pointing at something
      // we already hold — the common parent/child shape.
      for (const col of columns) {
        if (!inChain(child, col.defining)) continue
        for (const [holder, rows] of fetched) {
          if (!rows.size || holder === child || !inChain(holder, col.target)) continue
          for (const row of queryRecords({
            table: child, query: `${col.column}IN${[...rows.keys()].join(',')}`,
            displayValue: 'all', auth, pageSize: 100
          })) {
            const id = fieldValue(row.sys_id)
            if (id) found.set(id, row)
          }
        }
      }

      // Forward: a column on something we hold pointing AT the child — how an m2m row
      // reaches the record it links to.
      const targets = new Set()
      for (const [holder, rows] of fetched) {
        if (holder === child) continue
        for (const col of columns) {
          if (!inChain(holder, col.defining) || !inChain(child, col.target)) continue
          for (const row of rows.values()) {
            if (row) for (const id of idsIn(fieldValue(row[col.column]))) targets.add(id)
          }
        }
      }
      if (targets.size) {
        for (const row of queryRecords({
          table: child, query: `sys_idIN${[...targets].join(',')}`,
          displayValue: 'all', auth, pageSize: 100
        })) {
          const id = fieldValue(row.sys_id)
          if (id) found.set(id, row)
        }
      }

      if (found.size) {
        fetched.set(child, found)
        pending.delete(child)
        progressed = true
        for (const row of found.values()) out.push({ table: child, row })
      }
    }
    if (!progressed) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Self-healing transform runner (shared by import-update-set and import --via query)
// ---------------------------------------------------------------------------
// now-sdk builds the whole project after writing each record, and a record can even
// exit 0 ("Transform completed successfully") while leaving a Fluent object that
// breaks every LATER build. The reliable signal is the build diagnostics, so capture
// each transform's log, remove (or auto-fix) whatever its ERROR lines name, and
// report every removal at the end for manual handling.
function createHealer({ project, keepFailed }) {
  const removedForErrors = []
  // Known now-sdk codegen bug: generated Action() files copy EMPTY instance fields as
  // `prop: ''`, but some props are typed as enums (e.g. mid_selection_type:
  // 'use_connection_alias' | 'define_connection_inline' | 'any'), failing the build
  // with TS2769. Empty means "unset" on the record, so dropping the property is
  // faithful — try that once before giving up and removing the file.
  const autofixTried = new Set()
  const tryAutofix = (p) => {
    if (!basename(p).startsWith('sys_hub_action_type_definition_')) return false
    if (autofixTried.has(p)) return false
    autofixTried.add(p)
    try {
      const src = readFileSync(p, 'utf8')
      const next = src.replace(/^[ \t]*\w+: '',?\n/gm, '')
      if (next !== src) { writeFileSync(p, next); return true }
    } catch { /* fall through to removal */ }
    return false
  }
  const removeNamed = (out, indent = '    ') => {
    const bad = keepFailed ? [] : extractErrorFilePaths(out, project)
    let handled = 0
    for (const p of bad) {
      const rel = relative(project, p)
      if (tryAutofix(p)) {
        handled++
        console.warn(`${indent}auto-fixed ${rel} (dropped empty-string properties the DSL types reject)`)
        continue
      }
      const scripts = []
      try {
        const src = readFileSync(p, 'utf8')
        // Now.include('./scripts/x.js') companions would be orphaned — remove them too.
        for (const s of src.matchAll(/Now\.include\('([^']+)'\)/g)) scripts.push(resolve(dirname(p), s[1]))
      } catch { /* already gone */ }
      rmSync(p, { force: true })
      for (const s of scripts) rmSync(s, { force: true })
      removedForErrors.push(rel)
      handled++
      console.warn(`${indent}removed ${rel} (named in a build ERROR)`)
    }
    return handled
  }
  // A broken file can be left by a transform that exited 0 (the damage only surfaces
  // on the next build), so verify with a real build and clean up anything it names.
  const verifyProjectBuild = () => {
    console.log('\nVerifying the project still builds...')
    for (let attempt = 0; attempt < 5; attempt++) {
      const b = runSdk(['build'], { cwd: project, allowFailure: true, capture: true })
      if (b.status === 0) { console.log('  build OK'); return }
      const out = `${b.stdout || ''}${b.stderr || ''}`
      if (!removeNamed(out, '  ')) {
        process.stdout.write(out)
        console.error('  ! the build is failing but no file path could be extracted from its errors — fix manually')
        return
      }
    }
  }
  const report = () => {
    if (!removedForErrors.length) return
    const unique = [...new Set(removedForErrors)]
    console.warn(`\n! ${unique.length} file(s) were removed because they broke the project build — `
      + 'handle these records manually:')
    for (const f of unique) console.warn(`  - ${f}`)
  }
  return { removedForErrors, removeNamed, verifyProjectBuild, report }
}

// Run ONE `transform --from <path>` unit: a single record file, or a folder that must
// be transformed as one batch (a parent + the children that embed into its DSL).
function transformFromUnit({ path, label, project, extra = [], dryRun, healer, indent = '    ' }) {
  let res
  let attempts = 0
  while (true) {
    res = runSdk(['transform', '--from', path, '--directory', project, ...extra],
      { cwd: project, dryRun, allowFailure: true, capture: !dryRun })
    if (dryRun) return { ok: true, status: 0 }
    const out = `${res.stdout || ''}${res.stderr || ''}`
    process.stdout.write(out)
    if (res.status === 0) break
    const removed = healer.removeNamed(out, indent)
    // Duplicate-definition-only failures: the transform already wrote ALL its output
    // (the build runs after the writes), so removing the standalone Record() resolves
    // the conflict — re-running would only recreate it (some batches emit the
    // standalone even when the family is transformed together). Verify with a build
    // and treat green as success: the record stays embedded in its parent DSL.
    const clean = stripAnsi(out)
    if (removed && /is defined \d+ times/.test(clean) && !/:\d+:\d+\s*-\s*error/.test(clean)) {
      const b = runSdk(['build'], { cwd: project, allowFailure: true, capture: true })
      if (b.status === 0) {
        console.log(`${indent}duplicate(s) resolved by removal — build OK`)
        return { ok: true, status: 0 }
      }
      healer.removeNamed(`${b.stdout || ''}${b.stderr || ''}`, indent)
    }
    if (!removed || attempts >= 2) break
    attempts++
    console.warn(`${indent}retrying ${label}...`)
  }
  return { ok: res.status === 0, status: res.status }
}

// ---------------------------------------------------------------------------
// import: move -> online transform -> offline transform of queried JSON
// ---------------------------------------------------------------------------
// Three ways into a project, tried in that order (--via picks one explicitly):
//   move       one call, but needs the target app to already exist on the instance
//   transform  online per record; resolves relationships itself, but the SDK's
//              scope checks refuse it for records outside the project's app
//   query      read the row through the Table REST API, rebuild its <record_update>
//              XML locally and transform that offline — no scope-gated endpoint in
//              the path, so it works where the other two are refused
const IMPORT_STRATEGIES = ['auto', 'move', 'transform', 'query']

function commandImport(flags, config, positional) {
  const project = projectPath(flags, config)
  const auth = flags.auth || config.auth
  if (!auth) fail('Missing required --auth for import')
  const table = flags.table || config.table
  const encodedQuery = flags.query || config.query
  const dryRun = Boolean(flags['dry-run'])
  const extra = flags.__passthrough || []
  const keepFailed = Boolean(flags['keep-failed'])
  const related = !flags['no-related']
  const force = Boolean(flags.force)
  const max = flags.limit ? Number(flags.limit) : Infinity
  // An encoded query is a bulk selection, so it defaults to the query strategy —
  // that is the one that already has every row in hand after a single call.
  const via = String(flags.via || config.via || (encodedQuery ? 'query' : 'auto')).toLowerCase()
  if (!IMPORT_STRATEGIES.includes(via)) fail(`Unknown --via ${via} (expected: ${IMPORT_STRATEGIES.join(', ')})`)

  if (!existsSync(project)) {
    console.warn(`Project directory does not exist yet: ${project}`)
    console.warn('Initialize it first with: now-fluent init ... (or now-sdk init ...)')
  }

  // ---- 1. Decide WHICH records to import -----------------------------------
  let sysIds
  const prefetched = new Map() // table -> already-fetched full rows (from --query)
  if (encodedQuery) {
    if (!table) fail('--query needs --table <table> (the table to run the encoded query against).')
    if (dryRun) {
      console.log(`[dry-run] would select records with: now-sdk query ${table} --query ${shellQuote(encodedQuery)} --auth ${auth}`)
      return
    }
    console.log(`Selecting records: ${table} where ${encodedQuery}`)
    const rows = queryRecords({ table, query: encodedQuery, auth, displayValue: 'all', pageSize: 50, timeout: 120000, max, label: table })
    if (!rows.length) fail(`No ${table} records matched: ${encodedQuery}`)
    prefetched.set(table, rows)
    sysIds = rows.map((r) => fieldValue(r.sys_id)).filter(Boolean)
    console.log(`  ${sysIds.length} record(s) matched.`)
  } else {
    sysIds = sysIdsFrom(flags, config, positional)
  }

  // A dry run cannot exercise the ladder (nothing actually fails), so print the plan
  // for whichever strategies --via selects instead of pretending the first one landed.
  if (dryRun) {
    const t = table || '<table resolved from sys_metadata>'
    const wants = (s) => via === 'auto' || via === s
    console.log(via === 'auto'
      ? '\n[dry-run] import tries these in order, stopping at the first that lands:'
      : `\n[dry-run] import --via ${via} would run:`)
    if (wants('move')) {
      console.log(`  move       ${sdkPrintable(['move', '--ids', ...sysIds, '--auth', auth, '--source', project, ...extra])}`)
    }
    if (!table && (wants('transform') || wants('query'))) {
      console.log(`  resolve    ${sdkPrintable(['query', 'sys_metadata', '--query', `sys_idIN${sysIds.join(',')}`, '--fields', 'sys_id,sys_class_name,sys_name,sys_scope', '--display-value', 'all', '--output', 'json', '--auth', auth])}`)
    }
    if (wants('transform')) {
      for (const id of sysIds) {
        console.log(`  transform  ${sdkPrintable(['transform', '--auth', auth, '--table', t, '--id', id, '--directory', project, ...extra])}`)
      }
    }
    if (wants('query')) {
      for (const id of sysIds) {
        console.log(`  query      ${sdkPrintable(['query', t, '--query', `sys_id=${id}`, '--display-value', 'all', '--output', 'json', '--auth', auth])}`)
      }
      console.log(`             then ${sdkPrintable(['transform', '--from', '<rebuilt record XML>', '--directory', project, ...extra])}`)
    }
    if (via === 'auto') console.log('  (--via move|transform|query pins one strategy instead)')
    return
  }

  // Resume support for bulk selections: an explicit sys_id list is always imported
  // (you asked for those records by name), but a --query re-run skips what is
  // already registered in the project's keys.ts unless --force.
  if (encodedQuery && !force) {
    const present = loadProjectRecordIds(project)
    const remaining = sysIds.filter((id) => !present.has(id))
    if (remaining.length !== sysIds.length) {
      console.log(`Skipping ${sysIds.length - remaining.length} record(s) already present in the project `
        + '(registered in keys.ts) — pass --force to re-import them.')
    }
    if (!remaining.length) { console.log('Nothing left to import.'); return }
    sysIds = remaining
  }

  let pending = [...sysIds]
  const importedBy = { move: [], transform: [], query: [] }

  // ---- 2. move -------------------------------------------------------------
  if (via === 'auto' || via === 'move') {
    console.log(`\nImporting ${pending.length} record(s) into ${project} via now-sdk move...`)
    const moveResult = runSdk(['move', '--ids', ...pending, '--auth', auth, '--source', project, ...extra],
      { cwd: project, allowFailure: true })
    if (moveResult.status === 0) {
      importedBy.move = pending
      pending = []
    } else {
      console.warn(`\nmove failed (exit code ${moveResult.status}).`)
      if (via === 'move') fail(`import --via move failed for: ${pending.join(', ')}`)
    }
  }

  // ---- 3. resolve each record's table (query makes --table optional) -------
  const tableFor = new Map()
  if (pending.length && via !== 'move') {
    for (const id of pending) if (table) tableFor.set(id, table)
    const unknown = pending.filter((id) => !tableFor.has(id))
    if (unknown.length) {
      console.log(`\nResolving the table of ${unknown.length} record(s) from sys_metadata.sys_class_name...`)
      const found = discoverTables(unknown, auth)
      for (const [id, info] of found) {
        tableFor.set(id, info.table)
        console.log(`  ${id} -> ${info.table}${info.name ? ` (${info.name}${info.scope ? `, ${info.scope}` : ''})` : ''}`)
      }
      const unresolved = unknown.filter((id) => !tableFor.has(id))
      if (unresolved.length) {
        console.warn(`  ! could not resolve ${unresolved.length} sys_id(s) from sys_metadata: ${unresolved.join(', ')}`)
        console.warn('    They may live in a non-metadata (data) table, or be invisible to this account. '
          + 'Pass --table <table> to import them anyway.')
      }
    }
  }

  // ---- 4. online transform -------------------------------------------------
  if (pending.length && (via === 'auto' || via === 'transform')) {
    const doable = pending.filter((id) => tableFor.has(id))
    if (doable.length) {
      console.log(`\nTransforming ${doable.length} record(s) online via "now-sdk transform --table <table> --id <id>"...`)
      const attempting = new Set(doable)
      const stillPending = pending.filter((id) => !attempting.has(id))
      for (const id of doable) {
        const t = tableFor.get(id)
        const result = runSdk(['transform', '--auth', auth, '--table', t, '--id', id, '--directory', project, ...extra],
          { cwd: project, allowFailure: true })
        if (result.status === 0) {
          console.log(`  ${t} ${id} ok`)
          importedBy.transform.push(id)
        } else {
          console.error(`  ${t} ${id} FAILED (exit ${result.status})`)
          stillPending.push(id)
        }
      }
      pending = stillPending
    }
    if (via === 'transform') {
      if (pending.length) fail(`import --via transform failed for: ${pending.join(', ')}`)
      console.log(`\nimport: ${importedBy.transform.length} record(s) into ${project}`)
      return
    }
    if (pending.length) {
      console.log(`\n${pending.length} record(s) left — falling back to the query path `
        + '(Table API read + offline transform, which no scope check gates).')
    }
  }

  // ---- 5. query -> XML -> offline transform --------------------------------
  if (pending.length) {
    const targets = []
    const noTable = []
    for (const id of pending) {
      const t = tableFor.get(id)
      if (!t) {
        console.error(`  ! skipping ${id}: no table known (pass --table <table>)`)
        noTable.push(id)
        continue
      }
      targets.push({ sysId: id, table: t })
    }
    if (targets.length) {
      const result = importViaQuery({
        targets, auth, project, extra, related, keepFailed, prefetched,
        outDir: flags.out, keep: Boolean(flags.keep)
      })
      importedBy.query = result.imported
      // Records with no resolvable table never reached the query path — they are
      // still failures and must not vanish from the summary.
      pending = [...result.failed, ...noTable]
    }
  }

  const total = importedBy.move.length + importedBy.transform.length + importedBy.query.length
  const by = Object.entries(importedBy).filter(([, v]) => v.length).map(([k, v]) => `${v.length} via ${k}`).join(', ')
  console.log(`\nimport: ${total} record(s) into ${project}${by ? ` (${by})` : ''}`)
  if (pending.length) fail(`import failed for: ${pending.join(', ')}`)
}

// Pull records off the instance as JSON, rebuild their <record_update> XML locally
// and transform that offline. Each record gets its OWN folder holding the record plus
// the children that embed into its Fluent DSL, and the folder is transformed in a
// single `transform --from` call — the same family batching import-update-set does,
// so now-sdk cannot define a child twice.
function importViaQuery({ targets, auth, project, extra, related, keepFailed, prefetched, outDir, keep }) {
  const workDir = outDir ? resolve(outDir) : join(tmpdir(), `now-fluent-query-${randomUUID()}`)
  mkdirSync(workDir, { recursive: true })

  // One query per table (sys_idIN<list>) rather than one per record.
  const rowFor = new Map()
  const byTable = new Map()
  for (const t of targets) {
    if (!byTable.has(t.table)) byTable.set(t.table, [])
    byTable.get(t.table).push(t.sysId)
  }
  for (const [tbl, ids] of byTable) {
    const cached = prefetched?.get(tbl)
    const rows = cached || queryRecords({
      table: tbl, query: `sys_idIN${ids.join(',')}`, auth,
      displayValue: 'all', pageSize: 50, timeout: 120000, label: tbl
    })
    for (const row of rows) {
      const id = fieldValue(row.sys_id)
      if (id) rowFor.set(id, row)
    }
  }

  const units = []
  const failed = []
  for (const t of targets) {
    const row = rowFor.get(t.sysId)
    if (!row) {
      console.error(`  ! ${t.table} ${t.sysId}: not returned by the query (wrong table, or no read access)`)
      failed.push(t.sysId)
      continue
    }
    const dir = join(workDir, `${t.table}_${t.sysId}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${t.table}_${t.sysId}.xml`), recordJsonToXml(t.table, row))
    let children = 0
    if (related) {
      for (const child of relatedChildRows(t.table, t.sysId, auth, row)) {
        writeFileSync(join(dir, `${child.table}_${fieldValue(child.row.sys_id)}.xml`), recordJsonToXml(child.table, child.row))
        children++
      }
    }
    units.push({ sysId: t.sysId, dir, label: `${t.table} ${t.sysId}${children ? ` (+${children} child record(s))` : ''}` })
  }

  console.log(`\nTransforming ${units.length} rebuilt record(s) offline via now-sdk transform --from...`)
  const healer = createHealer({ project, keepFailed })
  const imported = []
  let i = 0
  for (const unit of units) {
    i++
    console.log(`\n[${i}/${units.length}] importing ${unit.label}`)
    const { ok, status } = transformFromUnit({ path: unit.dir, label: unit.label, project, extra, healer })
    if (ok) imported.push(unit.sysId)
    else { failed.push(unit.sysId); console.error(`  x ${unit.label} FAILED (exit ${status})`) }
  }
  // A transform can exit 0 and still leave the project unbuildable; the damage only
  // shows on the next build. If verification had to remove a record's own file, that
  // record did NOT land, however green its transform looked.
  if (units.length && !keepFailed) {
    const before = healer.removedForErrors.length
    healer.verifyProjectBuild()
    for (const removed of healer.removedForErrors.slice(before)) {
      const at = imported.findIndex((id) => removed.includes(id))
      if (at >= 0) {
        console.error(`  x ${imported[at]}: its generated file failed the build and was removed`)
        failed.push(imported[at])
        imported.splice(at, 1)
      }
    }
  }

  if (keep || outDir) console.log(`\nKept rebuilt record XML at: ${workDir}`)
  else rmSync(workDir, { recursive: true, force: true })
  healer.report()
  return { imported, failed }
}

// ---------------------------------------------------------------------------
// import-update-set: explode a ServiceNow update set XML into individual record
// files and transform them into Fluent source via `now-sdk transform --from`.
// `now-sdk transform --from` cannot read an update set export directly because
// each record is HTML-escaped (or CDATA-wrapped) inside <sys_update_xml><payload>;
// this unwraps them into the <record_update> layout transform understands.
// Flow records (sys_hub_*) can't be resolved offline (shapes/action defs missing),
// so flows are routed to the online per-flow transform (`--table sys_hub_flow --id`,
// needs --auth). Non-flow records stay fully local.
// ---------------------------------------------------------------------------
function decodeXmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&') // must be last so escaped entities are not double-decoded
}

// A <payload> comes in three encodings depending on where it was read from:
// HTML-escaped (&lt;record_update&gt;...) or CDATA-wrapped in an XML export, and
// as the plain record XML when read as JSON off the Table API. Handle all three.
function normalizeUpdatePayload(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return null
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)
  if (cdata) text = cdata[1].trim()
  if (!text.includes('<record_update')) text = decodeXmlEntities(text).trim()
  return text.includes('<record_update') ? text : null
}

function extractUpdateSetPayloads(xml) {
  // A ServiceNow update set export is an <unload> with one <sys_update_xml> per
  // captured record; each holds the record inside <payload>.
  const payloads = []
  const re = /<payload>([\s\S]*?)<\/payload>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const recordXml = normalizeUpdatePayload(m[1])
    if (recordXml) payloads.push(recordXml)
  }
  return payloads
}

// now-sdk transform builds the whole project after writing each record, and a record
// can even exit 0 ("Transform completed successfully") while leaving a Fluent object
// that breaks every LATER build (e.g. a sys_declarative_action_assignment missing
// mandatory fields). The reliable signal is the build diagnostics in the output: a
// failing build always prints "ERROR: <path>:<line>:<col> - error TS...". So capture
// each transform's full log, extract the file paths named in ERROR lines, remove those
// files and retry; everything removed is reported at the end for manual handling.
function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '')
}

// Some record families must be transformed TOGETHER in one transform call: transformed
// separately, now-sdk embeds the children inside the parent's DSL (e.g.
// sys_transform_entry fields inside the sys_transform_map's ImportSet()) while a
// standalone transform of a child also emits its own Record() file — so the project
// defines the record twice ("Record ... is defined 2 times"). Batching the family into
// a single --from call makes now-sdk emit only the parent with embedded children.
const TRANSFORM_TOGETHER = [
  { key: 'sys_transform', tables: ['sys_transform_map', 'sys_transform_entry', 'sys_transform_script'] },
  // sys_ui_list payloads carry their sys_ui_list_element children inline; separate
  // per-record transforms can claim the same element twice (List DSL vs standalone).
  { key: 'sys_ui_list', tables: ['sys_ui_list', 'sys_ui_list_element', 'sys_ui_list_control'] },
  // ACL role assignments embed into the ACL's DSL; standalone role transforms conflict.
  { key: 'sys_security_acl', tables: ['sys_security_acl', 'sys_security_acl_role'] },
  // UI policy actions embed into the policy's DSL (same for the catalog variant).
  { key: 'sys_ui_policy', tables: ['sys_ui_policy', 'sys_ui_policy_action', 'sys_ui_policy_rl_action'] },
  { key: 'catalog_ui_policy', tables: ['catalog_ui_policy', 'catalog_ui_policy_action'] },
  // Form payloads: a Form() DSL claims its sys_ui_section records IMPLICITLY (derived
  // from table+view, not listed by sys_id), while sys_ui_section payloads also produce
  // standalone Record() files for the same sections. (sys_ui_formatter is NOT family.)
  { key: 'sys_ui_form', tables: ['sys_ui_form', 'sys_ui_form_sections', 'sys_ui_form_section', 'sys_ui_section', 'sys_ui_element'] },
]
function transformGroupFor(table) {
  return TRANSFORM_TOGETHER.find((g) => g.tables.includes(table))
}

// The instance's base language, for family members that exist once per language.
let baseLanguageValue = null
function baseLanguage(auth) {
  if (baseLanguageValue === null) {
    const [row] = queryRecords({ table: 'sys_properties', query: 'name=glide.sys.language', fields: 'value', auth })
    baseLanguageValue = (row && fieldValue(row.value)) || 'en'
  }
  return baseLanguageValue
}

// Families that `import --via query` FETCHES together for one record, but that must NOT
// be batched into a single transform call by import-update-set. The distinction matters:
// TRANSFORM_TOGETHER also drives how a whole update set is chunked, so putting every
// catalog table in one group there would collapse a large export into one huge,
// slow, all-or-nothing step. Fetching is per record, so it has no such cost.
//
// `tables` are walked through the reference graph. `links` declare joins the reference
// walk cannot make — a child matched against a FIELD VALUE of the parent rather than by
// a sys_id reference — and a table named in `links` is deliberately kept out of the
// reference walk entirely.
const FETCH_TOGETHER = [
  // A catalog item is nearly useless on its own: its variables, UI policies (and their
  // actions) and client scripts are all separate records referencing it, and they all
  // hang directly off sc_cat_item, so the ordinary walk finds them.
  {
    key: 'sc_cat_item',
    tables: ['sc_cat_item', 'item_option_new', 'catalog_ui_policy', 'catalog_ui_policy_action', 'catalog_script_client']
  },
  // A table and all its fields. Both joins MUST be explicit: sys_dictionary and
  // sys_choice identify their table by NAME, not by a sys_id reference. Worse, letting
  // the reference walk near sys_dictionary would be actively wrong —
  // sys_dictionary.reference DOES point at sys_db_object, but it means "this field
  // points TO that table", so the walk would drag in every field on the instance that
  // references it.
  {
    key: 'sys_db_object',
    tables: ['sys_db_object', 'sys_dictionary', 'sys_choice'],
    links: [
      { table: 'sys_dictionary', column: 'name', parentField: 'name' },
      // Choices exist once per language. Only the base language embeds into the Table
      // schema; the translations cannot, and would land as dozens of standalone
      // Record() files (36 of them for a 16-choice table on a 12-language instance).
      { table: 'sys_choice', column: 'name', parentField: 'name', filter: (auth) => `language=${baseLanguage(auth)}` },
    ],
  },
]

// The family to pull in for a record being imported on its own. Only a group's FIRST
// table is a parent — importing a catalog_ui_policy must fetch its own actions (the
// catalog_ui_policy family), not climb back up to the catalog item that owns it.
function fetchFamilyFor(table) {
  return FETCH_TOGETHER.find((g) => g.tables[0] === table)
    || TRANSFORM_TOGETHER.find((g) => g.tables[0] === table)
    || null
}


// Resume support: src/fluent/generated/keys.ts registers every record the project
// already claims (explicit entries keyed by sys_id, including children embedded in a
// parent DSL). Records whose sys_id is already registered are skipped unless --force,
// so an interrupted import can be re-run without re-transforming the finished half.
function loadProjectRecordIds(project) {
  const keysFile = join(project, 'src', 'fluent', 'generated', 'keys.ts')
  const ids = new Set()
  if (!existsSync(keysFile)) return ids
  const src = readFileSync(keysFile, 'utf8')
  // Two shapes register a record as present:
  //   1. the entry KEY is the sys_id:           '<sysid>': { table: ... id: ... }
  //   2. a DIRECT id property of an entry:      { table: 'x' id: '<sysid>' }
  // An `id:` nested inside a composite `key: { ... }` block is a key COMPONENT that
  // references ANOTHER record (e.g. a child keyed by its parent's id) — counting those
  // as present caused records to be skipped that were never actually imported.
  let depth = 0
  let keyBlockDepth = -1 // brace depth at which a nested `key: {` block started
  for (const line of src.split('\n')) {
    const t = line.trim()
    const km = t.match(/^'([0-9a-f]{32})': \{/)
    if (km) ids.add(km[1])
    if (keyBlockDepth < 0 && /^key: \{/.test(t)) keyBlockDepth = depth
    if (keyBlockDepth < 0) {
      const im = t.match(/^id: '([0-9a-f]{32})',?$/)
      if (im) ids.add(im[1])
    }
    for (const ch of t) {
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (keyBlockDepth >= 0 && depth <= keyBlockDepth) keyBlockDepth = -1 }
    }
  }
  return ids
}

function extractErrorFilePaths(output, project) {
  const clean = stripAnsi(output)
  const paths = new Set()
  // e.g. "[now-sdk] ERROR: src/fluent/generated/.../file.now.ts:6:5 - error TS2739: ..."
  const re = /ERROR:\s*(\S+?):\d+:\d+\s*-\s*error/g
  let m
  while ((m = re.exec(clean)) !== null) {
    const p = resolve(project, m[1])
    if (existsSync(p)) paths.add(p)
  }
  // Duplicate-definition conflicts: 'Record "table.sysid" is defined 2 times in the
  // project:' followed by a numbered file list. Remove only the STANDALONE Record()
  // file, keeping the parent DSL that embeds the record. Rules, strongest first:
  //  1. content — the standalone is a generic `Record(` with `Now.ID['<sysid>']`, while
  //     a parent DSL may not mention the sys_id at all (e.g. Form() claims its
  //     sys_ui_section records implicitly via table+view). File NAMES can lie: the
  //     standalone is sometimes named after another record in the same payload.
  //  2. directory — the generic fallback usually lands under other/<table-with-dashes>/.
  //  3. basename — a file named exactly <table>_<sysid>.
  const dupRe = /Record "(\w+)\.([0-9a-f]{32})" is defined \d+ times/g
  while ((m = dupRe.exec(clean)) !== null) {
    const [, table, sysId] = m
    const listed = []
    const listRe = /^\s*\d+\.\s+(\S+?):\d+\s*$/gm
    let f
    while ((f = listRe.exec(clean)) !== null) {
      const p = resolve(project, f[1])
      if (existsSync(p)) listed.push(p)
    }
    const byContent = listed.filter((p) => {
      try {
        const src = readFileSync(p, 'utf8')
        return /\bRecord\(/.test(src) && src.includes(`'${sysId}'`)
      } catch { return false }
    })
    const tableDir = `/other/${table.replace(/_/g, '-')}/`
    const byDir = listed.filter((p) => `/${p.replace(/\\/g, '/')}/`.includes(tableDir))
    const byBase = listed.filter((p) => basename(p).startsWith(`${table}_${sysId}`))
    for (const p of (byContent.length ? byContent : byDir.length ? byDir : byBase)) paths.add(p)
  }
  return [...paths]
}

// Read the update set straight off the instance instead of from an exported file.
// sys_update_xml.payload holds exactly the same <record_update> blob the XML export
// wraps, so both sources feed the identical pipeline — and because this is a plain
// Table API read it also works for an update set that is still IN PROGRESS (nothing
// has to be marked complete and exported first), and for scopes where the SDK's own
// gated update-set download (fluent_update_set_export.do) is refused.
function fetchUpdateSetPayloads(ref, auth) {
  const isSysId = /^[0-9a-f]{32}$/i.test(ref)
  // Update sets live in two tables: sys_update_set (built on this instance) and
  // sys_remote_update_set (retrieved from elsewhere). Their sys_update_xml rows point
  // back through update_set / remote_update_set respectively — look in both so any
  // update set sys_id can simply be pasted in.
  const candidates = []
  for (const table of ['sys_update_set', 'sys_remote_update_set']) {
    const rows = queryRecords({
      table,
      query: isSysId ? `sys_id=${ref}` : `name=${ref}`,
      fields: 'sys_id,name,state,application,sys_updated_on',
      displayValue: 'all',
      auth
    })
    for (const row of rows) {
      candidates.push({
        table,
        sysId: fieldValue(row.sys_id),
        name: fieldValue(row.name),
        state: fieldValue(row.state),
        scope: fieldParts(row.application).display || fieldValue(row.application),
        updated: fieldValue(row.sys_updated_on)
      })
    }
  }
  if (!candidates.length) {
    fail(`No update set found for ${isSysId ? `sys_id ${ref}` : `name "${ref}"`} in sys_update_set or sys_remote_update_set.`)
  }
  if (candidates.length > 1) {
    console.error(`Ambiguous update set "${ref}" — ${candidates.length} matches:`)
    for (const c of candidates) console.error(`  ${c.sysId}  ${c.table}  ${c.name} (${c.state}, updated ${c.updated})`)
    fail('Re-run with the exact --sys-id of the one you want.')
  }
  const set = candidates[0]
  console.log(`Update set: ${set.name}`)
  console.log(`  ${set.table} ${set.sysId} — state ${set.state}${set.scope ? `, ${set.scope}` : ''}`)

  // Batched update sets: a "batch parent" captures NOTHING itself — its records live
  // in the child sets that point at it through `parent`, and batches can nest. The
  // platform's own export of a parent contains the whole batch, so collect the tree.
  const setIds = [set.sysId]
  let frontier = [set.sysId]
  while (frontier.length) {
    const kids = queryRecords({
      table: set.table,
      query: `parentIN${frontier.join(',')}`,
      fields: 'sys_id,name,state',
      auth
    })
    frontier = []
    for (const kid of kids) {
      const id = fieldValue(kid.sys_id)
      if (!id || setIds.includes(id)) continue
      setIds.push(id)
      frontier.push(id)
      console.log(`  + batch child: ${fieldValue(kid.name)} (${id})`)
    }
  }

  const rows = queryRecords({
    table: 'sys_update_xml',
    // Cover both link fields and the whole batch in one query; ordered so the set
    // imports the way it was recorded.
    query: `update_setIN${setIds.join(',')}^ORremote_update_setIN${setIds.join(',')}^ORDERBYsys_created_on`,
    fields: 'sys_id,name,type,target_name,action,payload,sys_created_on',
    auth,
    // payloads are whole records (scripts included), so keep pages small and allow
    // more than the SDK's 30s default per page.
    pageSize: 50,
    timeout: 120000,
    label: 'sys_update_xml'
  })
  if (!rows.length) {
    fail(`Update set ${set.sysId} has no sys_update_xml records`
      + (setIds.length > 1 ? ` (nor do its ${setIds.length - 1} batch child set(s)).` : ' (nothing was captured in it).'))
  }
  const payloads = []
  let unreadable = 0
  for (const row of rows) {
    const payload = normalizeUpdatePayload(fieldValue(row.payload))
    if (payload) payloads.push(payload)
    else unreadable++
  }
  if (unreadable) console.warn(`  ! ${unreadable} sys_update_xml row(s) had no readable <record_update> payload and were skipped.`)
  return { payloads, sourceName: `${set.name} (${set.sysId})` }
}

function commandImportUpdateSet(flags, config, positional) {
  // The update set can come from a local XML export (--from <path>) or straight off
  // the instance (--sys-id <32hex> / --name "<name>"), which needs --auth. A 32-hex
  // positional is read as a sys_id, anything else as a path.
  const positionalIds = positional.filter((p) => /^[0-9a-f]{32}$/i.test(p))
  const positionalPath = positional.find((p) => !/^[0-9a-f]{32}$/i.test(p))
  const fromRaw = flags.from || config.from || positionalPath
  const setRef = flags['sys-id'] ?? flags.sysId ?? flags.name ?? config.updateSet ?? positionalIds[0]
  if (Array.isArray(setRef)) fail('--sys-id/--name takes ONE update set (repeat the command for others).')
  if (fromRaw && setRef) fail('Pass either --from <xml file> or --sys-id/--name (the update set on the instance), not both.')
  if (!fromRaw && !setRef) {
    fail('Missing an update set: pass --from <path to update set XML>, or --sys-id <update set sys_id> '
      + '(or --name "<update set name>") with --auth <alias> to read it from the instance.')
  }

  const projectRaw = flags.project || config.project
  const project = projectRaw ? resolve(projectRaw) : process.cwd()
  const dryRun = Boolean(flags['dry-run'])
  const keep = Boolean(flags.keep)
  const noFlows = Boolean(flags['no-flows'])
  // By default, transform records one-by-one (transform --from <file>) so progress is
  // visible — you see which record is importing right now. --bulk uses a single
  // `transform --from <dir>` over the whole folder: faster and atomic for huge sets,
  // but silent for minutes with no indication of progress.
  const bulk = Boolean(flags.bulk)
  // When a build fails during/after a per-record transform, its diagnostics name the
  // file(s) breaking the project; those are removed (and reported at the end) so they
  // can't fail every following record. --keep-failed leaves them on disk for inspection.
  const keepFailed = Boolean(flags['keep-failed'])
  // Records already registered in the project's keys.ts are skipped (resume support);
  // --force re-imports them. Family groups and --bulk always import everything.
  const force = Boolean(flags.force)
  const auth = flags.auth || config.auth
  const extra = flags.__passthrough || []
  const includes = toTokenList(flags.include ?? config.include)
  const excludes = toTokenList(flags.exclude ?? config.exclude)

  // Both sources produce the same thing: a list of <record_update> payload strings.
  let payloads
  let sourceName
  if (setRef) {
    if (dryRun) {
      console.log(`[dry-run] would read the update set from the instance: `
        + `now-sdk query sys_update_xml --query update_set=${setRef} --auth ${auth || '<alias>'}`)
      return
    }
    ;({ payloads, sourceName } = fetchUpdateSetPayloads(String(setRef), auth))
    console.log(`Fetched ${payloads.length} record payload(s) from the instance.`)
  } else {
    const from = resolve(fromRaw)
    if (!existsSync(from)) fail(`Update set XML not found: ${from}`)
    sourceName = basename(from)
    payloads = extractUpdateSetPayloads(readFileSync(from, 'utf8'))
    if (payloads.length === 0) {
      fail(`No <sys_update_xml> payloads found in ${sourceName}. `
        + 'Expected a ServiceNow update set export (an <unload> containing '
        + '<sys_update_xml><payload>...</payload></sys_update_xml> entries).')
    }
  }

  // Write each record as its own <record_update> file. now-sdk's own transform
  // pipeline uses exactly this <table>_<sysid>.xml layout and reads the folder.
  const workDir = flags.out ? resolve(flags.out) : join(tmpdir(), `now-fluent-us-${randomUUID()}`)
  mkdirSync(workDir, { recursive: true })

  const records = []         // non-flow records → offline `transform --from`
  const flowSeedSet = new Set()   // sys_hub_flow sys_ids → online per-flow transform
  const actionSeedSet = new Set() // sys_hub_action_type_definition sys_ids → online per-action transform
  const flowGraphPayloads = [] // skipped sys_hub_* records, kept for completeness checks
  let flowRelated = 0        // sys_hub_* records skipped from --from (handled online)
  let filtered = 0
  let n = 0
  for (const payload of payloads) {
    const { table } = parseRecordUpdate(payload, sourceName)
    const sysId = firstMatch(payload, /<sys_id>([0-9a-f]{32})<\/sys_id>/i)
    const base = `${table || 'record'}_${sysId || String(++n)}`
    // --include/--exclude match like update-set-package: a token is a substring of
    // <table>_<sysid> (a table name selects a type, a sys_id selects one record).
    if (includes.length && !includes.some((s) => base.includes(s))) { filtered++; continue }
    if (excludes.length && excludes.some((s) => base.includes(s))) { filtered++; continue }
    // Flow graph records (sys_hub_*) can't be transformed offline from update-set XML:
    // the action/trigger "shapes" (type definitions) aren't in the set, so the offline
    // transform fails to resolve flow instances. Route the flow seeds (sys_hub_flow) to
    // the online per-flow transform, and skip the rest of the graph from --from.
    if (!noFlows && table && table.startsWith('sys_hub_')) {
      flowRelated++
      if (table === 'sys_hub_flow' && sysId) flowSeedSet.add(sysId)
      else if (table === 'sys_hub_action_type_definition' && sysId) actionSeedSet.add(sysId)
      else if (sysId) flowGraphPayloads.push({ sysId, text: payload })
      continue
    }
    // The decoded payload often already carries its own <?xml?> prolog; strip any
    // leading declaration so we emit exactly one (two is invalid XML).
    const body = payload.replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
    // Family tables (TRANSFORM_TOGETHER) go into a per-group subfolder so the whole
    // family is transformed in ONE --from call (separate transforms would define the
    // children twice — embedded in the parent AND as standalone Record() files).
    // In --bulk mode everything is one call anyway, so no grouping is needed.
    const grp = !bulk && table ? transformGroupFor(table) : null
    const dir = grp ? join(workDir, grp.key) : workDir
    if (grp) mkdirSync(dir, { recursive: true })
    const file = join(dir, `${base}.xml`)
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`)
    records.push({ table, sysId, file, group: grp ? grp.key : null })
  }
  const flows = [...flowSeedSet]
  const actions = [...actionSeedSet]

  if (records.length === 0 && flows.length === 0 && actions.length === 0) {
    rmSync(workDir, { recursive: true, force: true })
    fail(`No records matched after filtering (${payloads.length} payload(s) in ${sourceName}).`)
  }

  const filterNote = (includes.length || excludes.length) ? ` (filtered out ${filtered})` : ''
  console.log(`Extracted ${records.length} non-flow record(s) from ${sourceName}${filterNote}.`)
  if (records.length && records.length <= 20) {
    for (const r of records) console.log(`  - ${r.table || 'unknown'} ${r.sysId || ''}`.trimEnd())
  } else if (records.length) {
    // Too many to list individually — summarize by table, busiest first.
    const byTable = {}
    for (const r of records) {
      const t = r.table || 'unknown'
      byTable[t] = (byTable[t] || 0) + 1
    }
    const tables = Object.keys(byTable).sort((a, b) => byTable[b] - byTable[a])
    console.log(`  ${tables.length} table(s):`)
    for (const t of tables.slice(0, 30)) console.log(`  - ${t}: ${byTable[t]}`)
    if (tables.length > 30) console.log(`  ... and ${tables.length - 30} more table(s)`)
  }
  if (flowRelated) {
    console.log(`Detected ${flows.length} flow(s) and ${actions.length} action definition(s) across `
      + `${flowRelated} sys_hub_* record(s) — routed to the online per-record transform `
      + `(offline --from can't resolve flow/action shapes).`)
  }
  console.log(`Extracted record XML: ${workDir}`)

  // Phase 1: offline transform of the non-flow records.
  let importedRecords = 0
  let skippedRecords = 0
  let skippedFlows = 0
  let importedFlows = 0
  const failedRecords = []
  // Resume support: skip standalone records (and flows) already registered in the
  // project's keys.ts. Family groups and --bulk always import everything — their
  // records can be claimed implicitly by a parent, so presence can't be judged per id.
  const existingIds = (!force && !bulk) ? loadProjectRecordIds(project) : new Set()

  // Self-healing, shared by the offline unit transforms AND the online flow/action
  // transforms (both can write files that fail the project build). On failure, the
  // build diagnostics name the file(s) breaking the project; remove them (reported at
  // the end) so they can't fail everything that follows.
  // Note on keys.ts: a transform that exits 0 registers its ids there, but the
  // verification build after a removal prunes entries whose source file is gone, so
  // no manual scrubbing is needed — the presence check just has to read only REAL
  // registrations (see loadProjectRecordIds).
  const healer = createHealer({ project, keepFailed })
  const { removedForErrors, removeNamed, verifyProjectBuild } = healer

  // Online per-flow transform (each flow + its full graph + shapes from the instance).
  // A function because per-record mode runs it BETWEEN the family groups and the
  // standalone records: families + flows are the big/slow chunks, so they go first —
  // an interrupted run then keeps the most value, and the cheap standalones follow.
  let flowPhaseDone = false
  const runFlowPhase = () => {
    if (flowPhaseDone) return
    flowPhaseDone = true
    // Two kinds of online seeds: custom action definitions first (flows may use them),
    // then flows. Resume support: each online transform is slow, so skip seeds already
    // FULLY imported (unless --force). The seed id alone isn't proof — an interrupted
    // transform can leave a partial graph — so a seed is skipped only when its own id
    // AND every sys_hub_* record in the update set that references it (its graph
    // snapshot) are registered in keys.ts. Note the online transform imports the LIVE
    // graph; if the instance changed since the export, the snapshot ids may not all
    // match and the seed re-imports (harmless).
    const fullyImported = (seedId) => {
      if (!existingIds.has(seedId)) return false
      for (const p of flowGraphPayloads) {
        if (p.text.includes(seedId) && !existingIds.has(p.sysId)) return false
      }
      return true
    }
    const seeds = [
      ...actions.map((id) => ({ kind: 'action', table: 'sys_hub_action_type_definition', id })),
      ...flows.map((id) => ({ kind: 'flow', table: 'sys_hub_flow', id })),
    ]
    const pending = seeds.filter((s) => !fullyImported(s.id))
    skippedFlows = seeds.length - pending.length
    if (skippedFlows) {
      console.log(`\nSkipping ${skippedFlows} flow(s)/action(s) already fully imported (seed + its graph `
        + `records registered in keys.ts) — pass --force to re-import.`)
    }
    if (!pending.length) return
    if (!auth) {
      console.warn(`\n! ${pending.length} flow(s)/action(s) detected but no --auth provided. They need the `
        + `online transform (offline --from cannot resolve flow/action shapes). Re-run with --auth <alias> `
        + `to import them, or pass --no-flows to skip them entirely.`)
      return
    }
    console.log(`\nTransforming ${pending.length} flow(s)/action(s) online via "now-sdk transform --table <table> --id <id> --auth ${auth}"...`)
    const failedSeeds = []
    for (const s of pending) {
      const r = runSdk(['transform', '--auth', auth, '--table', s.table, '--id', s.id, '--directory', project, ...extra],
        { cwd: project, dryRun, allowFailure: true, capture: !dryRun })
      if (dryRun) continue
      const out = `${r.stdout || ''}${r.stderr || ''}`
      process.stdout.write(out)
      if (r.status === 0) { importedFlows++; console.log(`  ${s.kind} ${s.id} ok`) }
      else {
        console.error(`  ${s.kind} ${s.id} FAILED (exit ${r.status})`)
        // now-sdk can generate a flow/action file that itself fails to compile
        // (e.g. an Action() with a bad wfa.actionStep call) — auto-fix or remove
        // what the diagnostics name so it can't break everything that follows.
        const handled = removeNamed(out, '    ')
        // If the seed's own file survived (auto-fixed in place), check whether the
        // project now builds — if so the seed actually landed.
        const seedFile = join(project, 'src', 'fluent', 'generated', 'automation', 'flow', `${s.table}_${s.id}.now.ts`)
        if (handled && existsSync(seedFile)
          && runSdk(['build'], { cwd: project, allowFailure: true, capture: true }).status === 0) {
          importedFlows++
          console.log(`  ${s.kind} ${s.id} ok (auto-fixed)`)
        } else {
          failedSeeds.push(`${s.kind} ${s.id}`)
        }
      }
    }
    // A seed transform can exit 0 yet write a file that fails the build (e.g. an
    // Action() with an invalid wfa.actionStep call), so always verify with a build.
    // If verification removes a pending seed's own file, that seed is NOT imported.
    if (!dryRun && !keepFailed) {
      const before = removedForErrors.length
      verifyProjectBuild()
      const removedNow = removedForErrors.slice(before)
      for (const s of pending) {
        if (removedNow.some((f) => f.includes(s.id))) {
          importedFlows = Math.max(0, importedFlows - 1)
          failedSeeds.push(`${s.kind} ${s.id} (its generated file failed the build and was removed)`)
        }
      }
    }
    if (failedSeeds.length) console.warn(`  ${failedSeeds.length} flow(s)/action(s) failed: ${[...new Set(failedSeeds)].join(', ')}`)
  }

  if (records.length) {
    if (bulk) {
      // One bulk transform over the whole folder: fast and atomic, but silent for
      // minutes (no per-record progress) and one fatal record rolls back everything.
      if (!dryRun) {
        console.log(`Transforming ${records.length} non-flow record(s) via a single now-sdk transform --from (bulk)...`)
        console.log('  Note: bulk mode prints nothing during the commit phase and writes files only at '
          + 'the end — a silent period of several minutes is normal, not a hang. Drop --bulk to see '
          + 'per-record progress.')
      }
      runSdk(['transform', '--from', workDir, '--directory', project, ...extra], { cwd: project, dryRun })
      importedRecords = records.length
    } else {
      // One unit per standalone record, plus one unit per family group (its subfolder
      // is transformed in a single --from call so children embed into their parent).
      // Resume support: standalone records already registered in keys.ts are skipped.
      // A family group is skipped only when EVERY record its payloads define is already
      // registered — keys.ts also registers children claimed implicitly by a parent
      // DSL, and a single family payload can define several records (each with its own
      // <sys_id> tag, e.g. a sys_ui_list plus its elements), so all of them must match.
      const recordUnits = []
      const groupUnits = []
      const groupMembers = new Map()
      let skippedStandalone = 0
      for (const r of records) {
        if (!r.group) {
          if (r.sysId && existingIds.has(r.sysId)) { skippedStandalone++; skippedRecords++; continue }
          recordUnits.push({ label: `${r.table || 'record'} ${r.sysId || ''}`.trim(), file: r.file, count: 1 })
        } else {
          if (!groupMembers.has(r.group)) groupMembers.set(r.group, [])
          groupMembers.get(r.group).push(r)
        }
      }
      const groupFullyPresent = (members) => {
        if (!existingIds.size) return false
        let found = false
        for (const r of members) {
          const src = readFileSync(r.file, 'utf8')
          const re = /<sys_id>([0-9a-f]{32})<\/sys_id>/g
          let m
          while ((m = re.exec(src)) !== null) {
            found = true
            if (!existingIds.has(m[1])) return false
          }
        }
        return found // a group with no readable sys_ids can't be verified — import it
      }
      for (const [key, members] of groupMembers) {
        if (groupFullyPresent(members)) {
          skippedRecords += members.length
          console.log(`Skipping ${key}* family (${members.length} record(s)) — every record it defines `
            + `is already present in the project.`)
          continue
        }
        groupUnits.push({ label: `${key}* family (${members.length} records, transformed together)`, file: join(workDir, key), count: members.length })
      }
      const totalUnits = groupUnits.length + recordUnits.length
      const toTransform = groupUnits.concat(recordUnits).reduce((n, u) => n + u.count, 0)
      if (skippedStandalone) {
        console.log(`Skipping ${skippedStandalone} standalone record(s) already present in the project `
          + `(registered in keys.ts) — pass --force to re-import/overwrite them.`)
      }
      if (!dryRun && totalUnits) {
        console.log(`Transforming ${toTransform} non-flow record(s) in ${totalUnits} step(s) via now-sdk transform --from...`)
        console.log('  Order: family groups first, then flows (online), then standalone records — '
          + 'the heavy chunks go first so an interrupted run keeps the most value.')
        console.log('  (per-record progress shown below; pass --bulk for a single faster atomic transform instead)')
        if (!keepFailed) {
          console.log('  If a transform or the final verification build fails, the file(s) named in its '
            + 'build ERRORs are removed and retried, so one broken object cannot fail all later records; '
            + 'removed files are listed at the end (--keep-failed leaves them on disk instead).')
        }
      }
      let i = 0
      const transformUnit = (u) => {
        i++
        console.log(`\n[${i}/${totalUnits}] importing ${u.label}`)
        const { ok, status } = transformFromUnit({ path: u.file, label: u.label, project, extra, dryRun, healer })
        if (dryRun) return
        if (ok) { importedRecords += u.count }
        else { failedRecords.push(u.label); console.error(`  x ${u.label} FAILED (exit ${status})`) }
      }
      // Heavy chunks first: family group batches, then the online flows, then the
      // cheap standalone records.
      for (const u of groupUnits) transformUnit(u)
      runFlowPhase()
      for (const u of recordUnits) transformUnit(u)
      // A broken file written by the LAST record(s) only surfaces on the next build
      // (transform can exit 0 yet leave the project unbuildable).
      if (!dryRun && !keepFailed && totalUnits) verifyProjectBuild()
      if (failedRecords.length) {
        console.warn(`\n! ${failedRecords.length} record(s) failed to transform: ${failedRecords.join(', ')}`)
      }
    }
  }

  // In per-record mode the flow phase already ran between families and standalones;
  // this covers --bulk and the no-records case.
  runFlowPhase()

  if (dryRun) {
    console.log(`[dry-run] left extracted record XML at ${workDir}`)
    return
  }
  if (keep || flags.out) {
    console.log(`\nKept extracted record XML at: ${workDir}`)
  } else {
    rmSync(workDir, { recursive: true, force: true })
  }
  if (removedForErrors.length) {
    const unique = [...new Set(removedForErrors)]
    console.warn(`\n! ${unique.length} file(s) were removed because they broke the project build — `
      + 'handle these records manually:')
    for (const f of unique) console.warn(`  - ${f}`)
  }
  const failNote = failedRecords.length ? ` (${failedRecords.length} record(s) failed)` : ''
  const skipNote = (skippedRecords || skippedFlows)
    ? ` (skipped as already present: ${skippedRecords} record(s), ${skippedFlows} flow(s)/action(s) — --force to re-import)` : ''
  console.log(`\nimport-update-set: ${importedRecords}/${records.length} record(s) + ${importedFlows} flow(s)/action(s) into ${project}${failNote}${skipNote}`)
}

// ---------------------------------------------------------------------------
// export-xml
// ---------------------------------------------------------------------------
function commandExportXml(flags, config) {
  const out = exportXmlArtifacts(flags, config)
  if (flags.zip) zipDirectory(out)
}

function exportXmlArtifacts(flags, config, outOverride) {
  const project = projectPath(flags, config)
  if (!existsSync(project)) fail(`Project path does not exist: ${project}`)

  if (flags['build-local']) {
    runSdk(['build'], { cwd: project, dryRun: flags['dry-run'] })
  } else {
    console.log('Skipping local SDK build. Pass --build-local to compile Fluent to XML before export.')
  }

  // Select records, honoring --include/--exclude. With neither, every built
  // record is exported. (collectArtifactFiles returns all files when unfiltered.)
  const includes = toTokenList(flags.include)
  const excludes = toTokenList(flags.exclude)
  const files = collectArtifactFiles(project, { includes, excludes })
  if (files.length === 0) {
    const filtered = includes.length || excludes.length
    fail(`No XML artifacts found${filtered ? ' matching your --include/--exclude filters' : ''}. `
      + 'Try --build-local, or check dist/app/update, dist/app/author_elective_update and metadata/update.')
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = outOverride || resolve(flags.out || config.out || join(project, 'exports', `xml-${timestamp}`))
  mkdirSync(out, { recursive: true })

  // Copy each selected file into a label folder matching its source directory.
  const sourceDirs = new Set()
  for (const file of files) {
    const dir = dirname(file)
    sourceDirs.add(dir)
    const targetDir = join(out, sourceLabel(dir))
    mkdirSync(targetDir, { recursive: true })
    cpSync(file, join(targetDir, basename(file)))
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    project,
    sourceDirectories: [...sourceDirs],
    recordCount: files.length,
    included: includes.length ? includes : undefined,
    excluded: excludes.length ? excludes : undefined,
    note: 'Raw per-record SDK build artifacts (<record_update> payloads). Not an update set on their own; use update-set-package to assemble an importable update set.'
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`Exported ${files.length} XML artifact(s) to: ${out}`)
  return out
}

function sourceLabel(source) {
  if (source.includes('/dist/app/update')) return 'dist-app-update'
  if (source.includes('/dist/app/author_elective_update')) return 'dist-app-author-elective-update'
  if (source.includes('/metadata/update')) return 'metadata-update'
  if (source.includes('/dist/update')) return 'dist-update'
  return basename(source)
}

function zipDirectory(out) {
  const zipPath = `${out}.zip`
  const result = spawnSync('zip', ['-r', zipPath, basename(out)], {
    cwd: resolve(out, '..'),
    stdio: 'inherit',
    encoding: 'utf8'
  })
  if (result.error) fail(`Failed to run zip: ${result.error.message}`)
  if (result.status !== 0) fail(`zip failed with exit code ${result.status}`)
  console.log(`Created zip: ${zipPath}`)
}

// ---------------------------------------------------------------------------
// update-set-package: build a real, importable ServiceNow update set
// ---------------------------------------------------------------------------
function commandUpdateSetPackage(flags, config) {
  const project = projectPath(flags, config)
  const skipBundle = Boolean(flags['no-bundle'])

  const projConfig = readProjectConfig(project)
  const scope = flags.scope || config.scope || projConfig.scope
  const scopeId = flags['scope-id'] || config.scopeId || projConfig.scopeId
  const appName = flags['app-name'] || config.appName || projConfig.name || scope
  const includes = toTokenList(flags.include)
  const excludes = toTokenList(flags.exclude)

  const providedName = flags['update-set-name'] || config.updateSetName
  const name = providedName || `now-fluent ${snDateTime()}`
  const description = flags.description || config.description ||
    `Generated by now-fluent from ${basename(project)}`

  // Output dir is named after the update set (no timestamp) so re-running with the
  // same --update-set-name overwrites it in place instead of leaving copies.
  const usingAutoOut = !(flags.out || config.out)
  const autoDirName = providedName
    ? slugify(providedName)
    : `update-set-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const out = resolve(flags.out || config.out || join(project, 'exports', autoDirName))
  if (usingAutoOut && existsSync(out)) rmSync(out, { recursive: true, force: true })

  if (skipBundle) {
    if (flags['build-local']) runSdk(['build'], { cwd: project, dryRun: flags['dry-run'] })
    mkdirSync(out, { recursive: true })
  } else {
    exportXmlArtifacts(flags, config, out)
  }

  let updateSetFile = null
  const files = collectArtifactFiles(project, { includes, excludes })

  if (!scope || !scopeId) {
    console.warn('Skipping importable update set XML: missing scope/scopeId.')
    console.warn('  Pass --scope and --scope-id, or run from a project that has now.config.json.')
  } else if (files.length === 0) {
    console.warn('Skipping importable update set XML: no matching record XML found.')
    console.warn('  Run with --build-local, and check your --include/--exclude filters.')
  } else {
    const records = files.map((file) => {
      const rawXml = readFileSync(file, 'utf8')
      return { ...parseRecordUpdate(rawXml, file), rawXml, file }
    })
    const keepPayloadScope = Boolean(flags['keep-payload-scope'])
    const xml = buildUpdateSetXml({
      name, description, scope, scopeId, appName,
      owner: flags.owner || config.owner, records,
      rewritePayloadScope: !keepPayloadScope
    })
    updateSetFile = join(out, `update-set-${slugify(name)}.xml`)
    writeFileSync(updateSetFile, xml)
    console.log(`Created importable update set XML: ${updateSetFile}`)
    const deletes = records.filter((r) => isDeletePayload(r.rawXml)).length
    console.log(`  name="${name}"  scope=${scope}  records=${records.length}  deletes=${deletes}`
      + `  payload sys_scope=${keepPayloadScope ? 'kept as built' : `${scope} (${scopeId})`}`)
    for (const r of records) {
      const action = isDeletePayload(r.rawXml) ? ' DELETE' : ''
      console.log(`   - ${typeLabelForTable(r.table)}: ${r.targetName}  [${r.table}]${action}`)
    }
  }

  if (!skipBundle) {
    const checklistPath = join(out, 'UPDATE_SET_CHECKLIST.md')
    writeFileSync(checklistPath, renderUpdateSetChecklist({
      project, out, updateSetFile,
      updateSetName: name,
      scope: scope || 'TBD',
      owner: flags.owner || config.owner || 'TBD'
    }))
    console.log(`Created update-set checklist: ${checklistPath}`)

    const manifestPath = join(out, 'manifest.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        manifest.updateSetFile = updateSetFile ? basename(updateSetFile) : null
        manifest.updateSetImportable = Boolean(updateSetFile)
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      } catch { /* manifest is best-effort */ }
    }
  }

  if (flags.zip) zipDirectory(out)
}

function toArray(value) {
  return Array.isArray(value) ? value : value != null ? [value] : []
}

// Flatten repeated flags AND comma-separated values into a clean token list.
// e.g. --include a,b --include c  ->  ['a', 'b', 'c']
function toTokenList(value) {
  return toArray(value)
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'update-set'
}

function snDateTime(date = new Date()) {
  // ServiceNow stores datetimes in GMT as 'YYYY-MM-DD HH:MM:SS'.
  return date.toISOString().replace('T', ' ').replace(/\..+$/, '')
}

function guid() {
  return randomUUID().replace(/-/g, '')
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function stripXmlDeclaration(xml) {
  return String(xml).replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim()
}

function readProjectConfig(project) {
  const configFile = join(project, 'now.config.json')
  if (!existsSync(configFile)) return {}
  try {
    return JSON.parse(readFileSync(configFile, 'utf8'))
  } catch {
    return {}
  }
}

const TABLE_TYPE_LABELS = {
  sys_script: 'Business Rule',
  sys_script_include: 'Script Include',
  sys_script_client: 'Client Script',
  sys_ui_action: 'UI Action',
  sys_ui_policy: 'UI Policy',
  sys_ui_script: 'UI Script',
  sys_ui_page: 'UI Page',
  sys_security_acl: 'ACL',
  sys_dictionary: 'Dictionary',
  sys_db_object: 'Table',
  sys_ws_operation: 'Scripted REST Resource',
  sys_ws_definition: 'Scripted REST Service',
  sys_script_fix: 'Fix Script',
  sys_processor: 'Processor',
  sysevent_email_action: 'Notification',
  sys_app_module: 'Application Menu Module',
  sys_module: 'Application Module'
}

function typeLabelForTable(table) {
  return TABLE_TYPE_LABELS[table] || table || 'Customer Update'
}

function collectArtifactFiles(project, { includes = [], excludes = [] } = {}) {
  const dirs = [
    join(project, 'dist', 'app', 'update'),
    // record deletions tracked in keys.ts (removed Fluent code) are emitted here as action="DELETE"
    join(project, 'dist', 'app', 'author_elective_update'),
    join(project, 'metadata', 'update'),
    join(project, 'dist', 'update')
  ].filter(existsSync)

  let files = []
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase().endsWith('.xml')) files.push(join(dir, name))
    }
  }
  if (includes.length) files = files.filter((f) => includes.some((s) => f.includes(s)))
  if (excludes.length) files = files.filter((f) => !excludes.some((s) => f.includes(s)))

  const seen = new Set()
  return files.filter((f) => {
    const key = basename(f)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function firstMatch(xml, regex) {
  const m = xml.match(regex)
  return m ? m[1] : null
}

function parseRecordUpdate(xml, file) {
  // Prefer the explicit table attribute; some build artifacts omit it, in which
  // case the first child element of <record_update> is the record's table.
  const table = firstMatch(xml, /<record_update[^>]*\btable="([^"]+)"/)
    || firstMatch(xml, /<record_update[^>]*>\s*<([A-Za-z0-9_]+)[\s>]/)
  const updateName = firstMatch(xml, /<sys_update_name>([^<]*)<\/sys_update_name>/)
    || basename(file).replace(/\.xml$/i, '')
  const targetName = firstMatch(xml, /<name>([^<]*)<\/name>/) || updateName
  return { table, updateName, targetName }
}

// A build artifact whose record element carries action="DELETE" (dist/app/author_elective_update).
function isDeletePayload(xml) {
  return /<record_update[^>]*>\s*<[A-Za-z0-9_]+[^>]*\baction="DELETE"/.test(String(xml))
}

// Point every sys_scope of a payload at the update set's application, so records land in the
// scope the update set is built for (e.g. a Global or other-scope update set from an sn_* project).
function rewriteSysScope(payload, scope, scopeId) {
  const display = xmlEscape(scope)
  const id = xmlEscape(scopeId)
  return payload
    .replace(/<sys_scope\b[^>]*\/>/g, `<sys_scope display_value="${display}">${id}</sys_scope>`)
    .replace(/<sys_scope\b[^>]*>[^<]*<\/sys_scope>/g, `<sys_scope display_value="${display}">${id}</sys_scope>`)
}

function buildUpdateSetXml({ name, description, scope, scopeId, appName, owner, records, rewritePayloadScope = true }) {
  const now = snDateTime()
  const user = owner || 'admin'
  const remoteSysId = guid()
  const appDisplay = appName || scope

  const header = [
    '<sys_remote_update_set action="INSERT_OR_UPDATE">',
    `<application display_value="${xmlEscape(appDisplay)}">${xmlEscape(scopeId)}</application>`,
    `<application_name>${xmlEscape(appDisplay)}</application_name>`,
    `<application_scope>${xmlEscape(scope)}</application_scope>`,
    '<application_version/>',
    '<collisions/>',
    '<commit_date/>',
    '<deleted/>',
    `<description>${xmlEscape(description || '')}</description>`,
    '<inserted/>',
    `<name>${xmlEscape(name)}</name>`,
    '<origin_sys_id/>',
    '<release_date/>',
    '<remote_base_update_set/>',
    `<remote_sys_id>${remoteSysId}</remote_sys_id>`,
    '<state>loaded</state>',
    '<summary/>',
    '<sys_class_name>sys_remote_update_set</sys_class_name>',
    `<sys_created_by>${xmlEscape(user)}</sys_created_by>`,
    `<sys_created_on>${now}</sys_created_on>`,
    `<sys_id>${remoteSysId}</sys_id>`,
    '<sys_mod_count>0</sys_mod_count>',
    `<sys_updated_by>${xmlEscape(user)}</sys_updated_by>`,
    `<sys_updated_on>${now}</sys_updated_on>`,
    '<update_set/>',
    '<update_source/>',
    '</sys_remote_update_set>'
  ].join('\n')

  let recordedAt = Date.now()
  const updates = records.map((r) => {
    const stripped = stripXmlDeclaration(r.rawXml)
    const payload = rewritePayloadScope ? rewriteSysScope(stripped, scope, scopeId) : stripped
    return [
      '<sys_update_xml action="INSERT_OR_UPDATE">',
      `<action>${isDeletePayload(stripped) ? 'DELETE' : 'INSERT_OR_UPDATE'}</action>`,
      `<application display_value="${xmlEscape(appDisplay)}">${xmlEscape(scopeId)}</application>`,
      '<category>customer</category>',
      '<comments/>',
      `<name>${xmlEscape(r.updateName)}</name>`,
      `<payload>${xmlEscape(payload)}</payload>`,
      `<remote_update_set display_value="${xmlEscape(name)}">${remoteSysId}</remote_update_set>`,
      '<replace_on_upgrade>false</replace_on_upgrade>',
      `<sys_created_by>${xmlEscape(user)}</sys_created_by>`,
      `<sys_created_on>${now}</sys_created_on>`,
      `<sys_id>${guid()}</sys_id>`,
      `<sys_recorded_at>${(recordedAt++).toString(16)}</sys_recorded_at>`,
      `<sys_updated_by>${xmlEscape(user)}</sys_updated_by>`,
      `<sys_updated_on>${now}</sys_updated_on>`,
      `<target_name>${xmlEscape(r.targetName)}</target_name>`,
      `<type>${xmlEscape(typeLabelForTable(r.table))}</type>`,
      '<update_domain>global</update_domain>',
      '<update_set/>',
      '<view/>',
      '</sys_update_xml>'
    ].join('\n')
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<unload unload_date="${now}">\n${header}\n${updates}\n</unload>\n`
}

function renderUpdateSetChecklist(details) {
  const importable = Boolean(details.updateSetFile)
  const importSection = importable
    ? `## Direct import (the generated update set)

\`${basename(details.updateSetFile)}\` in this folder is a real, directly-importable ServiceNow update set XML. To apply it:

1. In ServiceNow: **System Update Sets > Retrieved Update Sets**.
2. Click **Import Update Set from XML** and upload \`${basename(details.updateSetFile)}\`.
3. Open the loaded update set and click **Preview Update Set**.
4. Resolve any preview problems/collisions.
5. Click **Commit Update Set** only after preview is clean and approvals are complete.

The other \`*.xml\` files here are the raw per-record build artifacts (the
\`<record_update>\` payloads) kept for review/diffing — not an update set themselves.

`
    : `## No importable update set was generated

Only the raw per-record build artifacts are included (scope/scopeId missing or no
records matched your filters). Re-run with \`--scope\`/\`--scope-id\` and
\`--build-local\`, or adjust \`--include\`/\`--exclude\`.

`
  return `# Update-set package

Created by \`now-fluent update-set-package\`.

${importSection}## Package details

- Project: \`${details.project}\`
- Export folder: \`${details.out}\`
- Update set name: ${details.updateSetName}
- Importable update set file: ${importable ? basename(details.updateSetFile) : '(none)'}
- Scope: ${details.scope}
- Owner: ${details.owner}

## Before committing on the instance

- [ ] Confirm the target scope and that you are not overwriting ServiceNow-owned metadata without approval.
- [ ] Review the generated Fluent, scripts, and XML artifacts.
- [ ] Back up the records you intend to change.
- [ ] Import, then Preview, and resolve all problems/collisions.
- [ ] Commit only after preview is clean and approvals are complete.
- [ ] Smoke-test affected forms, rules, APIs, and permissions afterward.

## Note for Claude Code

The \`update-set-*.xml\` is a real, importable update set and is the recommended path for landing customer changes (including into ServiceNow-owned/vendor scopes where SDK install is not appropriate). It is still import + preview + commit by a human in ServiceNow — this tool only writes the file locally.
`
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
function commandDoctor(flags) {
  console.log(`now-fluent: ${VERSION}`)
  console.log(`node: ${process.version}`)
  console.log(`sdk command: ${SDK_BIN}`)

  const sdkVersion = runSdk(['--version'], { capture: true, allowFailure: true })
  if (sdkVersion.status === 0) {
    const output = `${sdkVersion.stdout || ''}${sdkVersion.stderr || ''}`.trim()
    console.log(`ServiceNow SDK: ${output || 'available'}`)
  } else {
    console.log(`ServiceNow SDK: not available via "${SDK_BIN}"`)
    console.log('Install it (npm i -g @servicenow/sdk) or set NOW_FLUENT_SDK.')
  }

  // The instance-reading paths (import --via query, import-update-set --sys-id)
  // need the SDK's `query` command, added in 4.10.
  if (sdkVersion.status === 0) {
    console.log(`now-sdk query: ${sdkSupportsQuery() ? 'available' : 'NOT available (needs SDK 4.10+) '
      + '— import --via query and import-update-set --sys-id will not work'}`)
  }

  const cfg = resolve('.now-fluent.json')
  console.log(`config: ${existsSync(cfg) ? cfg : 'none'}`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command == null || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (!ENHANCED.has(command)) {
    // Any now-sdk command (and future ones): forward verbatim.
    passthrough(argv)
    return
  }

  const { flags, positional, passthrough: extra } = parseFlags(argv.slice(1))
  flags.__passthrough = extra
  const config = loadConfig(flags)

  switch (command) {
    case '--version':
    case '-v':
      console.log(VERSION)
      break
    case 'doctor':
      commandDoctor(flags)
      break
    case 'import':
      commandImport(flags, config, positional)
      break
    case 'import-update-set':
      commandImportUpdateSet(flags, config, positional)
      break
    case 'export-xml':
      commandExportXml(flags, config)
      break
    case 'update-set-package':
      commandUpdateSetPackage(flags, config)
      break
    default:
      fail(`Unknown command: ${command}. Run "now-fluent help".`)
  }
}

main()
