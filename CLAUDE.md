# Claude Code instructions for ServiceNow SDK work

You are working in or near a ServiceNow SDK/Fluent project. Use the local `now-fluent` wrapper instead of calling `now-sdk` directly unless the user explicitly asks otherwise.

`now-fluent` is a thin wrapper around `now-sdk`:

- It **forwards every now-sdk command and its exact arguments verbatim**, so anything you'd run as `now-sdk <cmd> ...` you run as `now-fluent <cmd> ...` (current and future commands alike).
- It **adds six enhanced commands**: `pull`, `push`, `import`, `import-update-set`, `export-xml`, and `update-set-package`.
- Several of them reach the instance through the plain Table REST API rather than a scope-gated SDK endpoint: `import --via query` and `import-update-set --sys-id` READ it through `now-sdk query` (SDK 4.10+), and `pull`/`push` READ AND WRITE it directly (except a flow, which push loads through the SDK's `api/fluent/load`, as install does), authenticating with the credential `now-sdk auth --print` hands out. That path is not gated by the scope checks that block `move`, the online `transform`, `download`, and the SDK's own update-set download — so it is the fallback that works in ServiceNow-owned scopes. `now-fluent doctor` reports whether the installed SDK has `query` and whether push/pull credentials resolve.

The official ServiceNow SDK plugin/skills may also be installed. Use those for SDK knowledge, Fluent API guidance, and `now-sdk explain`-style lookups. Use `now-fluent` for local execution.

## Core rules

1. Do not commit to Git unless the user explicitly asks.
2. Do not run a deploying command (`now-fluent install` / `now-sdk install`, etc.) without explicit user approval.
3. Prefer `now-fluent` over raw `now-sdk`. Since `now-fluent` forwards unknown commands verbatim, the same arguments always work.
4. Use `--dry-run` with the enhanced commands (`push`, `import`, `update-set-package`, `export-xml`) when the command shape is uncertain. For `push`, a dry run is also the safe way to show the user exactly what would be written before asking for approval.
5. Treat ServiceNow-owned scopes such as Hardware Asset Management as high risk. Prefer read-only analysis, local transform/import, scope-bound projects, and update-set workflows over installing into a vendor scope.
6. Distinguish the artifacts: the raw `dist/app/update/*.xml` files are SDK `<record_update>` build artifacts and are NOT an update set; only the `update-set-*.xml` produced by `update-set-package` is a real, importable ServiceNow update set.
7. Use `update-set-package` when the user wants an importable update set / manual governance path instead of an SDK install. It only writes files locally — import, preview, and commit stay manual steps in ServiceNow.
8. `push` is the ONLY command that writes records to an instance. Treat it like `install`: do not run it without explicit user approval. `push --dry-run` only READS the instance and is always safe; it needs no approval.
9. Before relying on `push` against an instance for the first time, run `now-fluent verify-push --auth <alias> [--scope <scope>]` (it writes and deletes throwaway records, so ask first). It checks, live: that a Table API PUT merges rather than replaces (confirmed), that an insert honours a supplied sys_id (confirmed), whether `sys_scope` is honoured (on the instance tested: NO — creates land in Global), the account's current application (a write naming no scope runs there), whether a create run AS Global / AS the app lands there and can be updated and deleted again (with `--scope`; on the instance tested: AS Global and AS the app both land — YES; updating an app's record AS Global — NO, 403), and whether update-set capture can be steered by the session preference (on the instance tested: NO).

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
now-fluent doctor          # now-fluent + node + now-sdk versions, whether now-sdk has `query`,
                           # and whether push/pull can resolve instance credentials
now-fluent verify-push --auth <alias> [--scope <scope>]
                           # live check of what push relies on (writes + deletes throwaway records)
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

## The edit loop on one live record (pull / push)

`update-set-package` is the GOVERNED path for promoting a change you do not own. `pull`/`push` is the INNER LOOP for iterating on a record — the thing that makes small repeated edits bearable.

```bash
now-fluent pull --project ./work --auth <alias> --sys-id <32hex>[,<32hex>...]
now-fluent pull --project ./work --auth <alias> --table <table> --query "<encoded query>" [--limit <n>]
# ...edit the Fluent source...
now-fluent push --project ./work --auth <alias> --sys-id <32hex> --dry-run
now-fluent push --project ./work --auth <alias> --sys-id <32hex>   # needs user approval
```

- **Both ends are the plain Table REST API**, the same ungated path `import --via query` uses, so neither is blocked by the scope checks that refuse `move`, the online `transform`, `download` and the SDK's update-set export. One exception: a flow is pushed through the SDK's loader (`api/fluent/load`) — see FLOWS below.
- **Credentials come from the SDK's own store.** `now-sdk auth --print <alias> --format headers` exists to hand out a live credential for manual API calls; `--format env` also emits `SN_SDK_INSTANCE_URL`. There is no second profile, no keychain, and no ServiceNow CLI (`snc`) dependency — `snc` would add a native installer, an interactive-only profile setup, an OS-keychain credential store, and a `record` command group that is fetched from the instance rather than built into the binary.
- **`pull` records a baseline** at `<project>/.now-fluent/state/<table>_<sysid>.json`: the record's full field values plus `sys_updated_on`/`sys_mod_count` as the instance held them. The import half is exactly `import --via query --force`.
- **Selecting records: a sys_id list OR a query, never both.** `--sys-id` takes a comma list, repeats, or positional ids (mixed tables fine). `--query <encoded query> --table <table>` pulls every match (`--limit` caps it) and, unlike `import --query`, re-takes records already in the project — pull always takes the instance version, and warns before replacing local source. Only a `--query` typed on the command counts: a `query` in `.now-fluent.json` is ignored by pull (it used to make `pull --sys-id A` import the config query's records instead). push takes `--sys-id` lists or `--all` (+ `--include`/`--exclude`); each record succeeds or is refused on its own.
- **`push` builds, reads the compiled `<record_update>` artifact, and writes it back**: `PUT` for a record that exists, `POST` carrying the `sys_id` for one that does not (so the record keeps the identity `Now.ID` gave it). By default only fields that differ from the baseline are sent.
- **Safety rails.** A record that changed on the instance since the pull is REFUSED (`--force` overrides). A record that exists but was never pulled is REFUSED — there is no baseline to separate your edits from someone else's. Instance-owned bookkeeping (`sys_created_*`, `sys_updated_*`, `sys_mod_count`, `sys_update_name`, `sys_package`, `sys_policy`, `sys_class_name`) is never written. A `DELETE` artifact is skipped unless `--allow-delete`, and even then it goes through the same baseline and drift guards as an update — an unpulled or drifted record is never destroyed. One refused record does not abandon the rest of the run.
- **`--table` is optional for both.** push takes it from the built artifact and validates any `--table` you pass against it; pull resolves it from `sys_metadata.sys_class_name`.
- **A baseline is instance-scoped.** One pulled from dev is never used as the diff reference for a prod push — push notices the mismatch and refuses.
- **CROSS-SCOPE — pull adopts, push returns.** The SDK refuses to compile `apiName: 'global.X'` in a project bound to `x_my_app` (TS11). So pull ADOPTS a record from another scope: it rewrites `sys_scope` and the `api_name` prefix into the project's scope in the rebuilt XML before the offline transform, and records the origin in `.now-fluent/adopted.json` — only for records that actually imported. That file is durable (unlike the disposable baselines in `.now-fluent/state/`) and belongs in version control with the source it describes. push translates those fields back and PUTs the original record — same sys_id, still in its origin scope; only real edits are sent. This is the intended workflow for editing Global records from a scoped project. Adoption happens on the query path (pull's default). `--no-adopt-scope` skips only the REWRITE; the origin is still recorded, because the SDK build stamps the project's `sys_scope` onto every artifact regardless of the source — forgetting the origin would let `update-set-package` package the record as a move.
  - `import` (query path) and `import-update-set` adopt exactly like pull: records from another scope are rewritten into the project's scope before the transform (no TS11), and their origin is recorded in `adopted.json` once they land (import-update-set checks `keys.ts`, which the verification build prunes of anything removed). Flows (`sys_hub_*`) go through the SDK's online transform and are not adopted.
  - `update-set-package` respects adoption: packaging an adopted record for the project's scope would MOVE it and rename its `api_name` on commit, so it REFUSES. Package it for its origin instead (`--scope global --scope-id global --include <id>` → an in-place edit, payload translated back), or pass `--move-adopted` to move it deliberately.
  - Packaging records built in the project's scope for ANOTHER scope (`--scope global`, `--scope y_scope`) rewrites `api_name` along with `sys_scope` (`x_my_app.X` → `global.X`), so the payload matches the scope it lands in — and says so, because committing creates the records there or MOVES them there if they already exist in the project's scope. `--keep-payload-scope` leaves both exactly as built.
  - push refuses, BEFORE writing, any update whose source scope differs from the live record's and whose origin is not recorded (e.g. a clone without `adopted.json`, or a `--via transform` import) — sending it could rename the `api_name` out from under callers. Fix by pulling again.
- **SCOPE — push names it on every write (verified live).** `sys_scope` in the body is INERT on a Table API write: the platform sets it from the scope the REST transaction runs in and rewrites `api_name` to match. A transaction that names no scope runs in the account's CURRENT APPLICATION — the app picker. With the picker on Global that is Global (the first finding); seen live with the picker on `sn_sow`, a plain create landed in `sn_sow`, and a `--target-scope global` push reported success for a record that was not in Global (fixed). So push never leaves it to the picker: every write carries `?sysparm_transaction_scope=` — a create the scope it must land in (the project's own, or Global), an update or delete the scope the record already lives in (Global included). A 400/403 wrote nothing and falls back once to a write that names no scope; the read-back still judges where a create landed. Verified live (dev410927, picker on `sn_sow`): a create run AS Global lands in Global, and a Global update of a record inside `sn_sow` is REFUSED (403) while the same update run AS `sn_sow` is accepted — so naming the record's own scope is required, not cosmetic. The spike's `transaction-global` / `update-from-global` / `update-as-app` lines re-check this per instance, and it prints the account's current application. Consequences to tell the user about:
  - Updating an existing record keeps its scope — it is already set; the update runs as that scope.
  - A Global create that lands anywhere else is DELETED again and reported FAILED, naming the app picker as the likely cause (a `sys_db_object`/`sys_dictionary` record is never deleted — Global schema creates are probed first instead, and refused if the probe lands elsewhere).
  - CREATING a record in the PROJECT's own scope (new record, no install) runs the create AS that application — `?sysparm_transaction_scope=<app sys_id>`, the mechanism the SDK itself uses for flow activation. PROBE FIRST: once per run, before any record of the user's is created, push creates a throwaway inactive script include as the app, reads its scope back and always deletes it. Only if the probe landed in the app is the real record created; otherwise the create is refused and nothing of the user's was written. The real record's scope is still read back: landed elsewhere anyway → deleted again and reported FAILED (business rules its insert ran are not undone); scope unreadable → reported FAILED as UNVERIFIED, left in place. Refused outright: `sys_db_object`/`sys_dictionary` creates (a table or column cannot be un-made by a DELETE — use `install` or `update-set-package`), and any create when the app does not exist on the instance. `--target-scope <the project's own scope>` is the same as the default. `--dry-run` shows the parameter but does not run the probe. Verified live (dev instance, `sn_sow`): a create run as the app lands in it, with `api_name` `<scope>.X`; other instances may differ — the spike's `transaction-scope` line answers it.
  - WRITES to a record that lives in a non-Global app run AS that app, the way editing it in that app would: DELETES (the probe, a rollback, `--allow-delete`) as the app first and from Global only if that fails; UPDATES as the app, falling back to a write naming no scope only on a 400/403 (which wrote nothing). Verified live: a Global DELETE and a Global UPDATE of a record inside `sn_sow` are both refused with HTTP 403, and both succeed run as `sn_sow`. The probe runs once per run even when it fails, so an undeletable probe is named once and never repeated per record; the spike's `delete-as-app` line checks this.
  - CREATING a record in any OTHER scope (neither Global nor the project's) is REFUSED. `--target-scope global` is the explicit opt-in that creates it in Global anyway and reports the scope and `api_name` it actually got.
  - `--target-scope <any scope other than global or the project's own>` is refused up front — this transport cannot deliver it. Use `update-set-package --scope <scope> --scope-id <id>`, whose payload carries `sys_scope`.
  - Every write reads the scope back; a record that landed elsewhere is reported FAILED, never as success.
  - `--no-scope` omits `sys_scope` from the body, which changes nothing on the instance (the field is ignored either way).
  - `--target-scope global` is for records AUTHORED in the scoped project. A record PULLED from Global needs none of it — adoption returns it automatically. An authored record must still use the project's scope in its `apiName` (`apiName: 'global.Thing'` fails TS11 in a scoped project); on create the platform rewrites it to `global.Thing`, and push reports that.
- **UPDATE SET CAPTURE — reported, not controlled (verified live).** `--update-set` points the account's session at an update set, but a REST transaction resolves its own and may ignore that: a record written while the session pointed at a named set was captured into `Default`. So the flag's real job is the check afterwards — it reports where each write was actually captured and fails the run on a mismatch. It restores the previous preference either way. For changes that must be in a specific update set, use `update-set-package`.
- **FLOWS are pushed as ONE unit, LOADED the way install loads them.** Verified with a real SDK 4.12.2 build: a `Flow()` compiles into ONE artifact holding the flow, its trigger and step instances, and `delete_multiple` directives (`flow=<id>^sys_idNOT IN<current steps>`) that remove steps no longer in the source; the flow record always carries `active=false`/`status=draft`, because `install` activates flows afterwards (`POST api/now/wfa_fluent/activate_flows`, run as the app's scope). So selecting the flow, one of its steps, or `--all` pushes the whole artifact:
  - WHY NOT THE TABLE API (seen live, twice): writing the flow's records one by one lands every row — edits, added and removed steps — yet Flow Designer shows the flow EMPTY (no trigger, no step) and `activate_flows` refuses it with `PUBLISH_FAILED: No Trigger instance found in the flow definition`. A flow is more than its rows: the platform builds the rest when it LOADS a flow's `<record_update>` (an update set commit, an app install). A real Flow Designer flow also has snapshots (`sys_hub_flow.latest_snapshot`/`master_snapshot` → `sys_hub_flow_snapshot`, which carries its own copy of the trigger and steps); ours had none.
  - So push sends the artifact, as built, through the SDK's own loader: `POST api/fluent/load/<scope sys_id>` (multipart `files`) — exactly what `now-sdk install` does for a project whose `now.config.json` says `type: 'configuration'` (sdk-api `installConfigurations`), and it answers with the update set it captured into (`--update-set` is handed to it as `targetUpdateSetId`). The endpoint comes with the ServiceNow IDE, like `activate_flows`; an instance without it is REFUSED and nothing is written — push never falls back to the Table API for a flow.
  - Every read and guard runs first (drift on the flow record — its baseline is re-taken after activation, which changes it; drift on any step with a baseline; scope rules as for a single create: a new flow goes in the project's own scope (the app must exist) or, with `--target-scope global`, in Global, the payload's `sys_scope` rewritten to Global; directive anchoring). No probe: the loader runs as the scope in its path. After the load, the flow and every record of the artifact are read back (baselines), directive matches must be gone, and a new flow must have landed in the scope asked for — otherwise FAILED.
  - Like install, the load leaves the flow an inactive draft; push then activates it if it is new or was active (`--activate` forces, `--no-activate` skips). If activation fails, the flow stays an inactive draft and the run fails saying so. Only the records' changes versus the baseline decide whether anything is loaded (`unchanged` otherwise), but the loader always receives the whole artifact.
  - A `delete_multiple` directive must name the flow or one of its records, and may match at most 50 records — otherwise the whole unit is refused before any write. The separate `DELETE` artifact the build writes for a removed step is SKIPPED (the directive removes it). push never deletes a whole flow (refused; delete it in Flow Designer). A `sys_hub_*` record outside its flow's artifact (a low-level `Record()`) is refused.
  - Compressed fields (a trigger's `trigger_inputs`, a step's `values`) are gzip+base64 (`H4sI…`) in the build and are sent AS-IS. Verified live: a Flow Designer trigger stores `H4sI…`; a trigger written decompressed broke the SDK's own reader (`Corrupt data in trigger instance: incorrect header check`).
  - An activation attempt writes the flow record even when it FAILS (seen live: `mod_count` 0 → 1), so the flow's baseline is re-taken after every attempt — otherwise the next push is refused as drift.
  - pull (and `import --via query`) route `sys_hub_flow`/`sys_hub_action_type_definition` ids to the SDK's online transform, because the query path cannot rebuild a graph; they are not adopted across scopes, and the SDK may refuse a flow outside the project's app.
  - NOT YET VERIFIED LIVE: the loader path. Runbook phases 7–8 exercise it: create a flow in Fluent, push, activate, fire it with an incident; edit a step, add and remove one, drift, pull it back, delete it — and report each flow's snapshots next to an active Flow Designer flow's (`KEEP_FLOW=1` leaves it on the instance to open in Flow Designer). Live on the old Table API path (dev410927, `sn_sow`): the drift guard refuses a real change, and pull via the online transform generates `src/fluent/generated/automation/flow/sys_hub_flow_<id>.now.ts`.
- **Two limitations to tell the user about.** (1) push CANNOT clear a field by removing it from the Fluent source: the write merges and the artifact only holds modelled fields, so removal means "not modelled", not "delete". Set an explicit empty value instead. (2) pull REPLACES local source for the records it names — it warns when a record already exists locally, but uncommitted edits are lost.
- Other flags: `--all` (+ `--include`/`--exclude`) pushes every built record, `--full` sends every modelled field, `--no-build` skips the build, `--no-drift-check` disables the comparison. `--dry-run` runs the (local) build, READS the live records and runs every guard, and stops only where a write would be sent — so it shows the real verb, the real diffed body, and any refusal the real run would hit. It needs `--auth` like a real push; it never writes.

**A push is NOT an update set commit.** It is a record write, so it runs business rules exactly as editing the form would; committing an update set does not. For a script include the difference is nil; for dictionary and table records it is not. Prefer `update-set-package` for anything you do not own, and for vendor scopes keep to the update-set path unless the user's governance says otherwise — "the Table API allows it" is not "your process allows it".

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
