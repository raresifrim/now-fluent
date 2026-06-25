# Claude Code instructions for ServiceNow SDK work

You are working in or near a ServiceNow SDK/Fluent project. Use the local `now-fluent` wrapper instead of calling `now-sdk` directly unless the user explicitly asks otherwise.

`now-fluent` is a thin wrapper around `now-sdk`:

- It **forwards every now-sdk command and its exact arguments verbatim**, so anything you'd run as `now-sdk <cmd> ...` you run as `now-fluent <cmd> ...` (current and future commands alike).
- It **adds four enhanced commands**: `import`, `import-update-set`, `export-xml`, and `update-set-package`.

The official ServiceNow SDK plugin/skills may also be installed. Use those for SDK knowledge, Fluent API guidance, and `now-sdk explain`-style lookups. Use `now-fluent` for local execution.

## Core rules

1. Do not commit to Git unless the user explicitly asks.
2. Do not run a deploying command (`now-fluent install` / `now-sdk install`, etc.) without explicit user approval.
3. Prefer `now-fluent` over raw `now-sdk`. Since `now-fluent` forwards unknown commands verbatim, the same arguments always work.
4. Use `--dry-run` with the enhanced commands (`import`, `update-set-package`, `export-xml`) when the command shape is uncertain.
5. Treat ServiceNow-owned scopes such as Hardware Asset Management as high risk. Prefer read-only analysis, local transform/import, scope-bound projects, and update-set workflows over installing into a vendor scope.
6. Distinguish the artifacts: the raw `dist/app/update/*.xml` files are SDK `<record_update>` build artifacts and are NOT an update set; only the `update-set-*.xml` produced by `update-set-package` is a real, importable ServiceNow update set.
7. Use `update-set-package` when the user wants an importable update set / manual governance path instead of an SDK install. It only writes files locally — import, preview, and commit stay manual steps in ServiceNow.

## Forwarded now-sdk commands

Run any now-sdk command through the wrapper with identical arguments, e.g.:

```bash
now-fluent auth --add https://dev12345.service-now.com
now-fluent init --appName "My App" --packageName my-app --scopeName x_my_app --template base
now-fluent build
now-fluent transform --auth dev --table sys_script_include --id <sysid>
now-fluent install --auth dev          # deploying — needs explicit user approval
now-fluent explain BusinessRule
```

now-sdk's own help is available by forwarding it: `now-fluent <command> --help`.
The SDK executable defaults to `now-sdk`; override with `NOW_FLUENT_SDK` (e.g. `npx @servicenow/sdk`).

## Discovery

```bash
now-fluent doctor          # now-fluent + node + now-sdk versions
now-fluent help            # now-fluent's own help
now-fluent move --help     # forwarded to now-sdk for exact syntax
now-fluent transform --help
```

## Authentication

```bash
now-fluent auth --add <instance_url>
```

If credentials are required, stop and ask the user to complete the SDK authentication flow. Do not ask the user to paste passwords, tokens, or secrets into chat.

## New custom scoped app

```bash
now-fluent init --appName "My App" --packageName my-app --scopeName x_my_app --template base
now-fluent build
now-fluent install --auth <alias>      # only after explicit approval
```

## Bring records into a project by sys_id (import)

`import` tries `now-sdk move`, then falls back to `now-sdk transform` per record:

```bash
now-fluent import --project ./work --auth <alias> --sys-id <32hex>
```

- Multiple ids: repeat `--sys-id`, use a comma list (`--sys-id a,b,c`), or pass ids positionally.
- `move` needs the target app present on the instance; the transform fallback needs the record's table, so pass `--table <table>` to enable it. If `move` fails and no `--table` is given, `import` stops and asks for one.
- `--dry-run` prints the now-sdk commands; `-- <args>` forwards extra flags (e.g. `-- -d`).

For a record whose table you already know, you can also just forward transform directly:
`now-fluent transform --auth <alias> --table <table> --id <sysid>`.

## Import a manually-exported update set XML (import-update-set)

When you already have an update set exported to XML (you publish/export it yourself), convert all its records to Fluent source locally — no instance contact:

```bash
now-fluent import-update-set --from ./my-update-set.xml --project ./work
```

- `now-sdk transform --from` cannot read an update set export directly: each record is wrapped inside `<sys_update_xml><payload>` (either HTML-escaped or in a CDATA section). This command unwraps every `<payload>` (handling both encodings) into individual `<record_update>` files, then transforms them.
- Progress & self-healing: by default each record is transformed individually (`transform --from <file>`) with `[i/N] importing <table> <sysid>` progress, in this order: **family group batches first, then flows (online), then standalone records** — the heavy/slow chunks run first so an interrupted run keeps the most value. A record can exit 0 ("Transform completed successfully") yet write a Fluent object that breaks every later build (e.g. a `sys_declarative_action_assignment` missing mandatory fields) — the only reliable failure signal is the build diagnostics (`ERROR: <path>:line:col - error TS...`), not the exit code. So each transform's log is captured; on failure the files named in ERROR lines are removed and the record retried (this also heals poison left by an earlier "successful" record), and a final verification build cleans up anything the last records left broken. Duplicate-definition conflicts (`Record "table.sysid" is defined 2 times`) are healed by removing the standalone `Record()` file and keeping the parent DSL — and because the transform writes all its output BEFORE the failing build, a duplicate-only failure is resolved in place: the wrapper removes the standalone, verifies with a build, and counts the unit as SUCCESS without re-running the transform (a re-run would just recreate the standalone; some form-family batches emit it even when the family is transformed together). The standalone is identified by (strongest first): content — it contains `Record(` plus `Now.ID['<sysid>']`, while a parent DSL may not mention the sys_id at all (a `Form()` claims sections implicitly via table+view) and file NAMES can lie (the standalone is sometimes named after a different record in the same payload); directory — the fallback usually lands under `other/<table-with-dashes>/`; basename — a file named `<table>_<sysid>`. All removed files are listed at the end for manual handling; `--keep-failed` disables removal. `--bulk` instead runs one atomic `transform --from <dir>` over everything: faster for huge sets but silent for minutes and one fatal record aborts the whole run.
- Resume: presence is read from `src/fluent/generated/keys.ts`, counting only REAL registrations — entries keyed by the sys_id (`'<sysid>': {`) or with a direct `id:` property (covers children embedded in a parent DSL); an `id:` nested inside a composite `key: { ... }` block is a reference to another record and must NOT count (it caused never-imported records to be skipped). The verification build prunes keys.ts entries for files the healer removed, so healed-away records correctly re-import on the next run. Standalone records already registered are **skipped by default**, so re-running an interrupted import only transforms what's missing; `--force` re-imports/overwrites everything. A flow or action definition is skipped only when its seed id AND every update-set `sys_hub_*` record that references that seed id are all registered (seed alone isn't proof of a complete graph). Caveats: most graph records reference their parent instance rather than the flow, so this checks the seed + directly-referencing records, not the full live graph — but now-sdk writes keys.ts at the end of a transform commit, so a registered seed almost always means the flow transform completed; and since the online transform imports the LIVE graph, a flow changed on the instance since the export may keep re-importing (harmless). A family group is skipped only when **every** record its payloads define is already registered — one payload can define several records (each with its own `<sys_id>` tag, e.g. a `sys_ui_list` plus its inline elements), so all of them are checked against keys.ts; if any is missing (or a payload has no readable `<sys_id>`), the whole family imports in full. `--bulk` always imports everything.
- Family grouping: some parent/child families must be transformed **together in one transform call**, or now-sdk defines the children twice — embedded in the parent's DSL AND as standalone `Record()` files (the "defined 2 times" build conflict). `import-update-set` automatically collects each family into one batch and transforms it as a single `--from <dir>` unit (`<key>* family (N records, transformed together)`). Current families in `TRANSFORM_TOGETHER`: `sys_transform_map`+`sys_transform_entry`+`sys_transform_script` (entries embed into the map's `ImportSet()` `fields`), `sys_ui_list`+`sys_ui_list_element`+`sys_ui_list_control` (a `sys_ui_list` payload carries its element children inline; separate transforms can claim the same element twice), `sys_security_acl`+`sys_security_acl_role` (roles embed into the `Acl()` DSL `roles` array), `sys_ui_policy`+`sys_ui_policy_action`+`sys_ui_policy_rl_action` (actions embed into the policy DSL `actions` array), `catalog_ui_policy`+`catalog_ui_policy_action` (same pattern, catalog variant), and `sys_ui_form`+`sys_ui_form_sections`+`sys_ui_form_section`+`sys_ui_section`+`sys_ui_element` (a `Form()` DSL claims its `sys_ui_section` records IMPLICITLY — derived from table+view, the section sys_ids never appear in the Form file — while `sys_ui_section` payloads produce standalone `Record()` files for the same sections; `sys_ui_formatter` is NOT part of this family). Add new families there if other tables show the same conflict. Notes: transforming a child alone is safe when its parent already exists in the project (now-sdk merges it into the existing parent DSL); the conflict happens when the child lands before/without its parent. The standalone duplicate always lands under `other/<table-with-dashes>/`, but its basename is not always `<table>_<sysid>` (a `sys_ui_list_element` standalone is named `sys_ui_list_<first-sys_id-in-payload>`), which is why the dup-healer matches by directory first.
- The path may be given via `--from` or positionally. `--project` maps to transform's `--directory` (defaults to the current project).
- `--out <dir>` writes the extracted per-record XML to a chosen folder; `--keep` preserves the temp extraction; `--dry-run` prints the now-sdk command and leaves the extracted files for inspection.
- `--include <token[,token...]>` / `--exclude <token[,token...]>` select which records to import — same substring semantics as `update-set-package` (a token is a substring of `<table>_<sysid>`; a table name selects a type, a sys_id selects one record; both repeatable and comma-separated). Filtering happens before writing, so excluded records are never transformed. Essential for large app exports (a published app can be ~30k records dominated by `sys_documentation`/`sys_translated`/`sys_ui_message`); e.g. `--exclude sys_documentation,sys_translated,sys_ui_message` or `--include sys_sg_,catalog,sys_script`.
- Known-problematic records: `sys_atf_test`/`sys_atf_step` (ATF tests with computed `fieldValues` trigger a FATAL "could not be parsed" error that aborts a `--bulk` atomic run — in default per-record mode they just fail/heal individually, and some import fine), `sys_declarative_action_assignment` records can transform "successfully" yet fail the build with missing mandatory fields (per-record mode auto-removes them). The `sp_rel_widget_clone` table emits non-fatal TablePlugin errors. A good comprehensive exclude for bulk or to reduce noise: `sys_documentation,sys_translated,sys_ui_message,sys_atf_test,sys_atf_step,sys_hub_,sp_rel_widget_clone` (flows/`sys_hub_` are auto-routed anyway; see below).
- Performance: extraction is sub-second even for a 100MB / 30k-record export, but `now-sdk transform` of several thousand records can take **many minutes** with NO output during its commit phase — files appear only at the very end. This is not a hang; the wrapper prints a heads-up before transforming.
- Flows AND custom action definitions are handled automatically. Flow-graph records (`sys_hub_*`) can't be transformed offline from update-set XML (the action/trigger *shapes* / type definitions aren't in the set, so offline transform throws `Failed to find shape for instance` and aborts). So the command **skips all `sys_hub_*` from the offline `--from` pass** and routes two kinds of online seeds — custom action definitions first (`now-sdk transform --table sys_hub_action_type_definition --id <id>`, since flows may use them), then flows (`--table sys_hub_flow --id <id>`) — which pull the full resolved graph + shapes from the instance. KNOWN now-sdk BUG (auto-fixed by the wrapper): generated `Action()` files copy empty instance fields as `prop: ''`, but some props are enum-typed (e.g. `mid_selection_type: 'use_connection_alias' | 'define_connection_inline' | 'any'`), so the build fails with TS2769 at the `wfa.actionStep(...)` call — and the transform may even exit 0 while leaving the broken file. NOT a missing-dependency problem (the step shape resolves fine; the full typing appears in the error). The wrapper auto-fixes the named file in place by dropping the empty-string properties (empty = unset on the record, so omission is faithful), verifies with a build, and counts the seed as imported (`ok (auto-fixed)`); only if the fix doesn't compile does it fall back to removing the file (+ its orphaned `Now.include` scripts) and reporting the seed failed. Other `sys_hub_*` records (flow blocks/inputs/variables, action inputs/outputs, step ext inputs/outputs...) are children that come along with their seed's online transform. This needs `--auth <alias>`; without it, flows are skipped with a notice; `--no-flows` skips them silently. Caveat: now-sdk captures flows as low-level `Record({ table: 'sys_hub_*' })` entries (the whole graph — ~250+ records per flow), NOT the high-level `Flow()` DSL, and falls back to `Record()` on unsupported descendants (e.g. `sys_hub_pill_compound`). A published app can have dozens of flows × hundreds of records each, so import flows **selectively** (`--include <flow_sys_id>`) rather than all at once.
- This is a useful workaround for ServiceNow-owned scopes (e.g. `sn_hamp`): `download` is gated by the instance's company-key/maint check, but an update set export is not — export the records to an update set XML, then `import-update-set`. Getting OOB records into the update set is a manual step on your side.

## Scope-bound projects for vendor scopes (e.g. HAM / sn_hamp)

To work with records in a ServiceNow-owned scope, bind the project to that scope so builds keep the correct `apiName`:

1. `now-fluent init ...` to scaffold a project.
2. Set the project's `now.config.json` `scope` and `scopeId` to the target scope (look up the scope's sys_id from `sys_scope` on the instance).
3. `now-fluent import --project ... --auth ... --sys-id ... --table ...` to pull records in-scope.
4. `now-fluent build` to verify it compiles.

Do not `install` into the vendor scope unless governance explicitly allows it; use `update-set-package` instead.

## Export the built record XML

```bash
now-fluent export-xml --project ./work --build-local --zip
```

Raw per-record `<record_update>` build artifacts plus a manifest. Not an update set on their own. Exports every built record by default; `--include`/`--exclude` (same repeatable, comma-separated, substring selection as `update-set-package`) export only selected records.

## Importable update set

When the user wants an update set they can import into ServiceNow (instead of an SDK install) — especially for Global scope or vendor scopes like HAM — run:

```bash
now-fluent update-set-package \
  --project ./work \
  --update-set-name "<name>" \
  --include <substring> \
  --build-local
```

This builds a **real, directly-importable** ServiceNow update set at `exports/<update-set-name>/update-set-<name>.xml` (an `<unload>` with one `sys_remote_update_set` and one `sys_update_xml` per selected record), plus the raw artifacts, `manifest.json`, and `UPDATE_SET_CHECKLIST.md`. The export folder is named after `--update-set-name`, so re-running with the same name overwrites it in place. It writes files locally only — the user imports/previews/commits it manually in ServiceNow.

Key flags:

- `--update-set-name "<name>"` — name in ServiceNow and the output folder name.
- `--scope` / `--scope-id` / `--app-name` — default to the project's `now.config.json`; pass them only for a project without one.
- `--description`, `--owner` — optional (owner stamps `sys_created_by`, default `admin`).
- `--include <token[,token...]>` / `--exclude <token[,token...]>` — choose which built records go in. Both are repeatable AND accept comma-separated lists (`--include id1,id2,id3`). A token is a filename substring: a sys_id selects one exact record, a table name selects a type. Note `sys_script` also matches `sys_script_include`, so disambiguate with sys_ids. The SDK emits `sys_module` records for `bom.json`/`package.json`; exclude them (`--exclude sys_module`, or select your records by sys_id) unless wanted.
- `--no-bundle` — write only the update set XML.
- `--zip` — also produce a `.zip`.

Tell the user to import via: System Update Sets → Retrieved Update Sets → Import Update Set from XML → Preview → Commit.

## ServiceNow-owned scopes and HAM

For Hardware Asset Management or other ServiceNow-owned apps:

1. Prefer reading context and importing/transforming records locally for analysis.
2. Bind a project to the scope (its `now.config.json` `scope`/`scopeId`) so builds keep the correct `apiName`.
3. Prefer update sets or official app customization paths for customer changes.
4. Do not install an SDK package into the vendor scope unless the user confirms this is explicitly permitted by their governance process.
5. Use `update-set-package` to build an importable update set XML (scope-bound) when the user wants to apply changes through ServiceNow's import/preview/commit flow.
