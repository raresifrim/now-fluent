#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, basename, dirname, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

const VERSION = '1.0.0'

// The ServiceNow SDK executable. Override with NOW_FLUENT_SDK, e.g.
//   NOW_FLUENT_SDK="npx @servicenow/sdk"
const SDK_BIN = process.env.NOW_FLUENT_SDK || 'now-sdk'

// Commands handled by now-fluent itself. EVERY other command (and its exact
// arguments) is forwarded verbatim to now-sdk, so any current or future now-sdk
// command works unchanged.
const ENHANCED = new Set(['help', '--help', '-h', '--version', '-v', 'doctor', 'import', 'import-update-set', 'export-xml', 'update-set-package'])

const BOOLEAN_FLAGS = new Set(['build-local', 'zip', 'no-bundle', 'dry-run', 'keep', 'no-flows', 'bulk', 'keep-failed', 'force'])

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

  import --project <path> --auth <alias> --sys-id <32hex>[,<32hex>...] [--table <table>]
         [--dry-run] [-- <extra now-sdk args>]
      Import one or more records into a local project by sys_id. Tries
      "now-sdk move" first; if that fails and --table is given, falls back to
      "now-sdk transform --table <table> --id <sysid>" for each id.
      sys_ids may be given via repeated --sys-id, --ids, comma-separated lists,
      or as positional arguments.

  import-update-set --from <path> [--project <path>] [--auth <alias>] [--out <dir>]
                    [--keep] [--no-flows] [--bulk] [--keep-failed] [--force]
                    [--include <substr>...] [--exclude <substr>...] [--dry-run]
                    [-- <extra now-sdk args>]
      Import a ServiceNow update set XML file (already exported/published
      manually) into a project as Fluent source. Unwraps each
      <sys_update_xml><payload> record from the <unload> (handles both
      HTML-escaped and CDATA payloads) into individual <record_update> files and
      runs "now-sdk transform --from" on them.
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
      The update set path may be given via --from or positionally. Extracted
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
function runSdk(args, { cwd, dryRun, capture, allowFailure } = {}) {
  const [cmd, ...base] = splitShellLike(SDK_BIN)
  const fullArgs = [...base, ...args]
  const printable = [cmd, ...fullArgs].map(shellQuote).join(' ')

  if (dryRun) {
    console.log(`[dry-run] ${printable}`)
    return { status: 0, stdout: '', stderr: '' }
  }

  console.log(`> ${printable}`)
  const result = spawnSync(cmd, fullArgs, {
    cwd: cwd || process.cwd(),
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: process.env
  })
  if (result.error) fail(`Failed to run ${cmd}: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(`Command failed with exit code ${result.status}: ${printable}`, result.status || 1)
  }
  return result
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
// import: move, falling back to transform
// ---------------------------------------------------------------------------
function commandImport(flags, config, positional) {
  const project = projectPath(flags, config)
  const auth = flags.auth || config.auth
  if (!auth) fail('Missing required --auth for import')
  const sysIds = sysIdsFrom(flags, config, positional)
  const table = flags.table || config.table
  const dryRun = Boolean(flags['dry-run'])
  const extra = flags.__passthrough || []

  if (!existsSync(project)) {
    console.warn(`Project directory does not exist yet: ${project}`)
    console.warn('Initialize it first with: now-fluent init ... (or now-sdk init ...)')
  }

  console.log(`Importing ${sysIds.length} record(s) into ${project} via now-sdk move...`)
  const moveArgs = ['move', '--ids', ...sysIds, '--auth', auth, '--source', project, ...extra]
  const moveResult = runSdk(moveArgs, { cwd: project, dryRun, allowFailure: true })

  if (moveResult.status === 0) {
    console.log(`\nmove succeeded for: ${sysIds.join(', ')}`)
    return
  }

  console.warn(`\nmove failed (exit code ${moveResult.status}).`)
  if (!table) {
    fail('Cannot fall back to transform without a table. Re-run with --table <table> '
      + '(the table that the sys_id(s) belong to) to enable the transform fallback.')
  }

  console.log(`Falling back to: now-sdk transform --table ${table} --id <sysid> (per record)...`)
  const failed = []
  for (const id of sysIds) {
    const transformArgs = ['transform', '--auth', auth, '--table', table, '--id', id, '--directory', project, ...extra]
    const result = runSdk(transformArgs, { cwd: project, dryRun, allowFailure: true })
    if (result.status === 0) {
      console.log(`  transformed ${id}`)
    } else {
      console.error(`  transform failed for ${id} (exit code ${result.status})`)
      failed.push(id)
    }
  }
  if (failed.length) fail(`import failed for: ${failed.join(', ')}`)
  console.log(`\nimport (via transform fallback) succeeded for: ${sysIds.join(', ')}`)
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

function extractUpdateSetPayloads(xml) {
  // A ServiceNow update set export is an <unload> with one <sys_update_xml> per
  // captured record; each holds the record inside <payload>. The payload comes
  // in two encodings: HTML-escaped (&lt;record_update&gt;...) or wrapped in a
  // single CDATA section (<![CDATA[<record_update>...]]>). Handle both.
  const payloads = []
  const re = /<payload>([\s\S]*?)<\/payload>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1].trim()
    if (!raw) continue
    const cdata = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)
    const recordXml = cdata ? cdata[1].trim() : decodeXmlEntities(raw).trim()
    if (!recordXml.includes('<record_update')) continue
    payloads.push(recordXml)
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

function commandImportUpdateSet(flags, config, positional) {
  const fromRaw = flags.from || config.from || positional[0]
  if (!fromRaw) fail('Missing required --from <path to update set XML> (or pass it positionally)')
  const from = resolve(fromRaw)
  if (!existsSync(from)) fail(`Update set XML not found: ${from}`)

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

  const xml = readFileSync(from, 'utf8')
  const payloads = extractUpdateSetPayloads(xml)
  if (payloads.length === 0) {
    fail(`No <sys_update_xml> payloads found in ${basename(from)}. `
      + 'Expected a ServiceNow update set export (an <unload> containing '
      + '<sys_update_xml><payload>...</payload></sys_update_xml> entries).')
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
    const { table } = parseRecordUpdate(payload, from)
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
    fail(`No records matched after filtering (${payloads.length} payload(s) in ${basename(from)}).`)
  }

  const filterNote = (includes.length || excludes.length) ? ` (filtered out ${filtered})` : ''
  console.log(`Extracted ${records.length} non-flow record(s) from ${basename(from)}${filterNote}.`)
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
  const removedForErrors = []
  // Note on keys.ts: a transform that exits 0 registers its ids there, but the
  // verification build after a removal prunes entries whose source file is gone, so
  // no manual scrubbing is needed — the presence check just has to read only REAL
  // registrations (see loadProjectRecordIds).
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
  const removeNamed = (out, indent) => {
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
        let res
        let attempts = 0
        while (true) {
          res = runSdk(['transform', '--from', u.file, '--directory', project, ...extra],
            { cwd: project, dryRun, allowFailure: true, capture: !dryRun })
          if (dryRun) break
          const out = `${res.stdout || ''}${res.stderr || ''}`
          process.stdout.write(out)
          if (res.status === 0) break
          const removed = removeNamed(out, '    ')
          // Duplicate-definition-only failures: the transform already wrote ALL its
          // output (the build runs after the writes), so removing the standalone
          // Record() resolves the conflict — re-running the transform would only
          // recreate it (some batches emit the standalone even when the family is
          // transformed together). Verify with a build and treat green as success:
          // the record stays embedded in its parent DSL, nothing is lost.
          const clean = stripAnsi(out)
          if (removed && /is defined \d+ times/.test(clean) && !/:\d+:\d+\s*-\s*error/.test(clean)) {
            const b = runSdk(['build'], { cwd: project, allowFailure: true, capture: true })
            if (b.status === 0) {
              console.log('    duplicate(s) resolved by removal — build OK')
              res = { status: 0 }
              break
            }
            removeNamed(`${b.stdout || ''}${b.stderr || ''}`, '    ')
          }
          if (!removed || attempts >= 2) break
          attempts++
          console.warn(`    retrying ${u.label}...`)
        }
        if (dryRun) return
        if (res.status === 0) { importedRecords += u.count }
        else { failedRecords.push(u.label); console.error(`  ✗ ${u.label} FAILED (exit ${res.status})`) }
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
      + 'Try --build-local, or check dist/app/update and metadata/update.')
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
    const xml = buildUpdateSetXml({
      name, description, scope, scopeId, appName,
      owner: flags.owner || config.owner, records
    })
    updateSetFile = join(out, `update-set-${slugify(name)}.xml`)
    writeFileSync(updateSetFile, xml)
    console.log(`Created importable update set XML: ${updateSetFile}`)
    console.log(`  name="${name}"  scope=${scope}  records=${records.length}`)
    for (const r of records) {
      console.log(`   - ${typeLabelForTable(r.table)}: ${r.targetName}  [${r.table}]`)
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

function buildUpdateSetXml({ name, description, scope, scopeId, appName, owner, records }) {
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
    const payload = stripXmlDeclaration(r.rawXml)
    return [
      '<sys_update_xml action="INSERT_OR_UPDATE">',
      '<action>INSERT_OR_UPDATE</action>',
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
