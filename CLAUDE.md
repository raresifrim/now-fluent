# Claude Code instructions for ServiceNow SDK work

You are working in or near a ServiceNow SDK/Fluent project. Use the local `now-fluent` wrapper instead of calling `now-sdk` directly unless the user explicitly asks otherwise.

`now-fluent` is a thin wrapper around `now-sdk`:

- It **forwards every now-sdk command and its exact arguments verbatim**, so anything you'd run as `now-sdk <cmd> ...` you run as `now-fluent <cmd> ...` (current and future commands alike).
- It **adds four enhanced commands**: `import`, `import-update-set`, `export-xml`, and `update-set-package`.
- Two of them read the instance through `now-sdk query` (SDK 4.10+), the plain Table REST API: `import --via query` and `import-update-set --sys-id`. That path is not gated by the scope checks that block `move`, the online `transform`, `download`, and the SDK's own update-set download — so it is the fallback that works in ServiceNow-owned scopes. `now-fluent doctor` reports whether the installed SDK has `query`.

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
now-fluent doctor          # now-fluent + node + now-sdk versions, and whether now-sdk has `query`
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

## Bring records into a project (import)

`import` has three strategies and, on `--via auto` (the default), tries them in order until one lands:

1. `now-sdk move` — one call, but needs the target app present on the instance.
2. `now-sdk transform --table <t> --id <id>` — online per record; resolves relationships itself, but the SDK's scope checks refuse records outside the project's app.
3. **query** — `now-sdk query` reads the row through the plain Table REST API, `import` rebuilds its `<record_update>` XML locally and runs `transform --from` on it **offline**. No scope-gated endpoint is in the path, so this is the strategy that still works in ServiceNow-owned scopes.

```bash
now-fluent import --project ./work --auth <alias> --sys-id <32hex>
now-fluent import --project ./work --auth <alias> --via query --sys-id <32hex>
```

- **`--table` is optional now.** The table of any sys_id is resolved from `sys_metadata.sys_class_name` with one query, so the old "cannot fall back to transform without a table" dead end is gone. Pass `--table` for records that do not extend `sys_metadata` (plain data tables), or to skip the lookup.
- Multiple ids: repeat `--sys-id`, use a comma list (`--sys-id a,b,c`), or pass ids positionally.
- `--query <encoded query>` with `--table` imports everything a query matches instead of a sys_id list, e.g. `--table sys_script_include --query "sys_scope.scope=sn_hamp^active=true"`. It defaults to `--via query`, skips records already registered in `keys.ts` (so an interrupted bulk run can just be re-run; `--force` re-imports everything), and `--limit <n>` caps how many it takes. An explicit `--sys-id` list is always imported, never skipped.
- The query path fetches each record's family and transforms it in the SAME call, so now-sdk embeds the children in the parent DSL instead of defining them twice. `--no-related` imports the record alone. Two lists drive this, and only a group's FIRST table counts as a parent (importing a `catalog_ui_policy` fetches its own actions, it does not climb back to the catalog item that owns it):
  - `TRANSFORM_TOGETHER` — families that must also be BATCHED together by import-update-set: `sys_transform_map`, `sys_ui_list`, `sys_security_acl`, `sys_ui_policy`, `catalog_ui_policy`, `sys_ui_form`.
  - `FETCH_TOGETHER` — fetch-only families for single-record import. Keep these OUT of `TRANSFORM_TOGETHER`: that list also chunks a whole update set, and one giant group would collapse a large export into a single slow all-or-nothing transform.
    - `sc_cat_item` + `item_option_new` + `catalog_ui_policy` + `catalog_ui_policy_action` + `catalog_script_client`. Verified live: a catalog item imports as a `CatalogItem()` with all 13 variables embedded as typed builders, 11 policy files carrying their 17 actions, and 3 `CatalogClientScript()` files that import the item's exported symbol — a cross-reference that only resolves because they were transformed together.
    - `sys_db_object` + `sys_dictionary` + `sys_choice` (a table and all its fields). Verified live: a `Table()` with a 25-column typed `schema` and choice lists embedded per column.
  - A family entry may declare `links` for joins the reference walk cannot make — a child matched against a FIELD VALUE of the parent instead of by a sys_id reference — and a table named in `links` is deliberately excluded from the reference walk. The table family needs this twice over: `sys_dictionary`/`sys_choice` identify their table by NAME, and worse, `sys_dictionary.reference` DOES point at `sys_db_object` but means "this field points TO that table", so a reference walk would drag in every field on the instance referencing it. `sys_choice` is additionally filtered to the instance base language (`glide.sys.language`, default `en`): only that language embeds into the schema, and the translations would otherwise land as dozens of standalone `Record()` files (36 of them for a 16-choice table on a 12-language instance).
  - Records outside both lists import ALONE. That is fine for the common case, because `--via auto` tries the online `transform --table --id` first and the SDK resolves relationships itself there; it only matters when the online transform is refused. Adding a family is one line in either list — the link columns are then discovered from the dictionary automatically.
  - The family is walked through `sys_dictionary`, never hard-coded, and the walk has to be **inheritance-aware in both directions**: `catalog_ui_policy_action` inherits its `ui_policy` column from `sys_ui_policy_action`, and that column references `sys_ui_policy`, not `catalog_ui_policy`. Matching only the concrete tables finds nothing and you silently get a policy with **no actions**, so both tables' ancestries (via `sys_db_object.super_class`) are resolved and matched. Ancestry stops before `sys_metadata`, or every column referencing it would look like a link to the parent.
  - The walk follows references **outward in both directions** and repeats, because not every family member points at the parent: a `Form()`'s sections hang off the `sys_ui_form_section` m2m and its elements off those sections (`sys_ui_form` → `sys_ui_form_section` → `sys_ui_section` → `sys_ui_element`). Verified live: a form imports with all its sections, layout and 18 fields.
  - `sys_ui_list_control` has no reference column to `sys_ui_list` (it is matched by name/view), so it is not reachable by the walk — import it through the update set instead.
- Failures self-heal exactly like `import-update-set`: files named in a build ERROR are removed (or auto-fixed) and the unit retried, with a verification build at the end. A record whose file that verification removes is reported as FAILED, not imported. `--keep-failed` leaves the files on disk; `--out <dir>`/`--keep` preserve the rebuilt XML.
- `--via move|transform|query` pins one strategy. `--dry-run` prints the plan for whichever strategies apply; `-- <args>` forwards extra flags (e.g. `-- -d`).

Fidelity note: the rebuilt XML mirrors what ServiceNow writes into an update set payload (`display_value` attributes on references, CDATA for script/HTML fields, `<field/>` for empties), and the SDK's parser ignores the `sys_package`/`sys_mod_count`/`sys_class_name`/`sys_update_name` bookkeeping fields anyway. What a single-table query CANNOT reproduce is a payload that carries several records inline (e.g. a `sys_hub_flow` payload embeds `sys_hub_flow_input` children and `delete_multiple` directives) — that is why families are fetched explicitly and why flows stay on the online path.

For a record whose table you already know, you can also just forward transform directly:
`now-fluent transform --auth <alias> --table <table> --id <sysid>`.

## Import an update set as Fluent source (import-update-set)

The update set can come from a local XML export **or straight off the instance**:

```bash
# from a file you exported/published manually — no instance contact at all
now-fluent import-update-set --from ./my-update-set.xml --project ./work

# from the instance, by sys_id or by name (needs --auth)
now-fluent import-update-set --sys-id <update set sys_id> --auth <alias> --project ./work
now-fluent import-update-set --name "My update set" --auth <alias> --project ./work
```

- **From the instance:** `now-sdk query sys_update_xml` returns the set's rows, whose `payload` field holds exactly the same `<record_update>` blob the XML export wraps — so both sources feed one identical pipeline. This needs no export step, works on an update set that is still **in progress**, and is a plain Table API read, so it also works where the SDK's own gated update-set download (`fluent_update_set_export.do`, which requires `sysparm_ck` + the project's scope) is refused. Both `sys_update_set` (built locally, linked by `update_set`) and `sys_remote_update_set` (retrieved, linked by `remote_update_set`) are searched in one query, so any update set sys_id can just be pasted in. A `--name` that matches several sets lists them and asks for the exact `--sys-id`.
- **Batched update sets:** a batch *parent* captures nothing itself — its records live in the child sets pointing at it through `parent`, and batches nest. `--sys-id` walks that tree and imports the whole batch, matching what the platform's own export of a parent contains.
- **Duplicate captures:** the same record is often captured in several child sets of one batch. Records are written per `<table>_<sysid>`, so the last payload wins, and rows are ordered by `sys_created_on` — the newest capture. Verified against live records: this reproduces the record's current state, whereas an exported XML can hand you a stale earlier capture.
- **Paging is stabilised with a `sys_id` tiebreaker.** ServiceNow leaves rows tied on the sort column in undefined order, and ties are the norm (an update set's `sys_update_xml` rows share a `sys_created_on` by the dozen), so paging on a non-unique sort silently skips one row and repeats another.
- **From a file:** `now-sdk transform --from` historically could not read an update set export directly, because each record is wrapped inside `<sys_update_xml><payload>` (HTML-escaped or CDATA). This command unwraps every `<payload>` (handling both encodings, plus the plain XML the Table API returns) into individual `<record_update>` files, then transforms them.
- Progress & self-healing: by default each record is transformed individually (`transform --from <file>`) with `[i/N] importing <table> <sysid>` progress, in this order: **family group batches first, then flows (online), then standalone records** — the heavy/slow chunks run first so an interrupted run keeps the most value. A record can exit 0 ("Transform completed successfully") yet write a Fluent object that breaks every later build (e.g. a `sys_declarative_action_assignment` missing mandatory fields) — the only reliable failure signal is the build diagnostics (`ERROR: <path>:line:col - error TS...`), not the exit code. So each transform's log is captured; on failure the files named in ERROR lines are removed and the record retried (this also heals poison left by an earlier "successful" record), and a final verification build cleans up anything the last records left broken. Duplicate-definition conflicts (`Record "table.sysid" is defined 2 times`) are healed by removing the standalone `Record()` file and keeping the parent DSL — and because the transform writes all its output BEFORE the failing build, a duplicate-only failure is resolved in place: the wrapper removes the standalone, verifies with a build, and counts the unit as SUCCESS without re-running the transform (a re-run would just recreate the standalone; some form-family batches emit it even when the family is transformed together). The standalone is identified by (strongest first): content — it contains `Record(` plus `Now.ID['<sysid>']`, while a parent DSL may not mention the sys_id at all (a `Form()` claims sections implicitly via table+view) and file NAMES can lie (the standalone is sometimes named after a different record in the same payload); directory — the fallback usually lands under `other/<table-with-dashes>/`; basename — a file named `<table>_<sysid>`. All removed files are listed at the end for manual handling; `--keep-failed` disables removal. `--bulk` instead runs one atomic `transform --from <dir>` over everything: faster for huge sets but silent for minutes and one fatal record aborts the whole run.
- Resume: presence is read from `src/fluent/generated/keys.ts`, counting only REAL registrations — entries keyed by the sys_id (`'<sysid>': {`) or with a direct `id:` property (covers children embedded in a parent DSL); an `id:` nested inside a composite `key: { ... }` block is a reference to another record and must NOT count (it caused never-imported records to be skipped). The verification build prunes keys.ts entries for files the healer removed, so healed-away records correctly re-import on the next run. Standalone records already registered are **skipped by default**, so re-running an interrupted import only transforms what's missing; `--force` re-imports/overwrites everything. A flow or action definition is skipped only when its seed id AND every update-set `sys_hub_*` record that references that seed id are all registered (seed alone isn't proof of a complete graph). Caveats: most graph records reference their parent instance rather than the flow, so this checks the seed + directly-referencing records, not the full live graph — but now-sdk writes keys.ts at the end of a transform commit, so a registered seed almost always means the flow transform completed; and since the online transform imports the LIVE graph, a flow changed on the instance since the export may keep re-importing (harmless). A family group is skipped only when **every** record its payloads define is already registered — one payload can define several records (each with its own `<sys_id>` tag, e.g. a `sys_ui_list` plus its inline elements), so all of them are checked against keys.ts; if any is missing (or a payload has no readable `<sys_id>`), the whole family imports in full. `--bulk` always imports everything.
- Family grouping: some parent/child families must be transformed **together in one transform call**, or now-sdk defines the children twice — embedded in the parent's DSL AND as standalone `Record()` files (the "defined 2 times" build conflict). `import-update-set` automatically collects each family into one batch and transforms it as a single `--from <dir>` unit (`<key>* family (N records, transformed together)`). Current families in `TRANSFORM_TOGETHER`: `sys_transform_map`+`sys_transform_entry`+`sys_transform_script` (entries embed into the map's `ImportSet()` `fields`), `sys_ui_list`+`sys_ui_list_element`+`sys_ui_list_control` (a `sys_ui_list` payload carries its element children inline; separate transforms can claim the same element twice), `sys_security_acl`+`sys_security_acl_role` (roles embed into the `Acl()` DSL `roles` array), `sys_ui_policy`+`sys_ui_policy_action`+`sys_ui_policy_rl_action` (actions embed into the policy DSL `actions` array), `catalog_ui_policy`+`catalog_ui_policy_action` (same pattern, catalog variant), and `sys_ui_form`+`sys_ui_form_sections`+`sys_ui_form_section`+`sys_ui_section`+`sys_ui_element` (a `Form()` DSL claims its `sys_ui_section` records IMPLICITLY — derived from table+view, the section sys_ids never appear in the Form file — while `sys_ui_section` payloads produce standalone `Record()` files for the same sections; `sys_ui_formatter` is NOT part of this family). Add new families there if other tables show the same conflict. Notes: transforming a child alone is safe when its parent already exists in the project (now-sdk merges it into the existing parent DSL); the conflict happens when the child lands before/without its parent. The standalone duplicate always lands under `other/<table-with-dashes>/`, but its basename is not always `<table>_<sysid>` (a `sys_ui_list_element` standalone is named `sys_ui_list_<first-sys_id-in-payload>`), which is why the dup-healer matches by directory first.
- The update set may be given via `--from`/`--sys-id`/`--name` or positionally (a 32-hex positional is read as a sys_id, anything else as a path). `--project` maps to transform's `--directory` (defaults to the current project).
- `--out <dir>` writes the extracted per-record XML to a chosen folder; `--keep` preserves the temp extraction; `--dry-run` prints the now-sdk command and leaves the extracted files for inspection.
- `--include <token[,token...]>` / `--exclude <token[,token...]>` select which records to import — same substring semantics as `update-set-package` (a token is a substring of `<table>_<sysid>`; a table name selects a type, a sys_id selects one record; both repeatable and comma-separated). Filtering happens before writing, so excluded records are never transformed. Essential for large app exports (a published app can be ~30k records dominated by `sys_documentation`/`sys_translated`/`sys_ui_message`); e.g. `--exclude sys_documentation,sys_translated,sys_ui_message` or `--include sys_sg_,catalog,sys_script`.
- Known-problematic records: `sys_atf_test`/`sys_atf_step` (ATF tests with computed `fieldValues` trigger a FATAL "could not be parsed" error that aborts a `--bulk` atomic run — in default per-record mode they just fail/heal individually, and some import fine), `sys_declarative_action_assignment` records can transform "successfully" yet fail the build with missing mandatory fields (per-record mode auto-removes them). The `sp_rel_widget_clone` table emits non-fatal TablePlugin errors. A good comprehensive exclude for bulk or to reduce noise: `sys_documentation,sys_translated,sys_ui_message,sys_atf_test,sys_atf_step,sys_hub_,sp_rel_widget_clone` (flows/`sys_hub_` are auto-routed anyway; see below).
- Performance: extraction is sub-second even for a 100MB / 30k-record export, but `now-sdk transform` of several thousand records can take **many minutes** with NO output during its commit phase — files appear only at the very end. This is not a hang; the wrapper prints a heads-up before transforming.
- Flows AND custom action definitions are handled automatically. Flow-graph records (`sys_hub_*`) can't be transformed offline from update-set XML (the action/trigger *shapes* / type definitions aren't in the set, so offline transform throws `Failed to find shape for instance` and aborts). So the command **skips all `sys_hub_*` from the offline `--from` pass** and routes two kinds of online seeds — custom action definitions first (`now-sdk transform --table sys_hub_action_type_definition --id <id>`, since flows may use them), then flows (`--table sys_hub_flow --id <id>`) — which pull the full resolved graph + shapes from the instance. KNOWN now-sdk BUG (auto-fixed by the wrapper): generated `Action()` files copy empty instance fields as `prop: ''`, but some props are enum-typed (e.g. `mid_selection_type: 'use_connection_alias' | 'define_connection_inline' | 'any'`), so the build fails with TS2769 at the `wfa.actionStep(...)` call — and the transform may even exit 0 while leaving the broken file. NOT a missing-dependency problem (the step shape resolves fine; the full typing appears in the error). The wrapper auto-fixes the named file in place by dropping the empty-string properties (empty = unset on the record, so omission is faithful), verifies with a build, and counts the seed as imported (`ok (auto-fixed)`); only if the fix doesn't compile does it fall back to removing the file (+ its orphaned `Now.include` scripts) and reporting the seed failed. Other `sys_hub_*` records (flow blocks/inputs/variables, action inputs/outputs, step ext inputs/outputs...) are children that come along with their seed's online transform. This needs `--auth <alias>`; without it, flows are skipped with a notice; `--no-flows` skips them silently. Caveat: now-sdk captures flows as low-level `Record({ table: 'sys_hub_*' })` entries (the whole graph — ~250+ records per flow), NOT the high-level `Flow()` DSL, and falls back to `Record()` on unsupported descendants (e.g. `sys_hub_pill_compound`). A published app can have dozens of flows × hundreds of records each, so import flows **selectively** (`--include <flow_sys_id>`) rather than all at once. Observed live on two flows: one resolved every shape and produced the high-level `Flow()` DSL; the other hit `Failed to find shape for instance`, fell back to low-level `Record()` entries (47 files for one flow) and built fine. KNOWN now-sdk BUG WITH NO WORKAROUND: when a `Flow()` DSL calls `wfa.dataPill(_params.trigger.current.<prop>)` and the trigger's record type exposes `<prop>` only through an index signature, the build fails with `TS4111` demanding bracket access while `wfa.dataPill` rejects bracket access with `TS212` ("first argument must be a property access expression") — the two rules contradict, the file cannot compile, and adding the table's type definitions does not help. The wrapper does the right thing: it removes the file, keeps the project building, and reports that flow as FAILED rather than counting it as imported.
- This is a useful workaround for ServiceNow-owned scopes (e.g. `sn_hamp`): `download` is gated by the instance's company-key/maint check, but reading `sys_update_xml` is not. Point `--sys-id` at the update set on the instance (no export needed), or export it to XML first and use `--from`. Getting OOB records into the update set is still a manual step on your side.

## Scope-bound projects for vendor scopes (e.g. HAM / sn_hamp)

To work with records in a ServiceNow-owned scope, bind the project to that scope so builds keep the correct `apiName`:

1. `now-fluent init ...` to scaffold a project.
2. Set the project's `now.config.json` `scope` and `scopeId` to the target scope (look up the scope's sys_id from `sys_scope` on the instance).
3. `now-fluent import --project ... --auth ... --sys-id ...` to pull records in-scope (`--table` optional; add `--via query` to bypass the SDK's scope checks outright).
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
