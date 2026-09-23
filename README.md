# now-fluent

`now-fluent` is a thin wrapper around the ServiceNow SDK (`now-sdk`). It does two things:

1. **Forwards every now-sdk command verbatim** — use `now-fluent` exactly like `now-sdk`, with the same commands and arguments (including any future now-sdk commands).
2. **Adds six Fluent-focused helpers** on top: `pull`/`push` (the tight edit loop against one live record), `import` (move → online transform → Table-API query, whichever lands), `import-update-set` (a whole update set, from a file or straight off the instance), `export-xml`, and `update-set-package` (build a real, importable ServiceNow update set).

```text
now-fluent <now-sdk-command> [...exact now-sdk args]   # forwarded to now-sdk
now-fluent pull | push                                 # handled by now-fluent
now-fluent import | import-update-set                  # handled by now-fluent
now-fluent export-xml | update-set-package             # handled by now-fluent
```

## Safety model

- It does not commit to Git.
- It does not deploy anything to an instance unless you run an SDK command that does (`now-fluent install`, etc.) — those are just forwarded to now-sdk.
- `update-set-package` can build a real, importable update set XML, but it only writes the file locally — **importing, previewing, and committing stay manual steps you perform in ServiceNow.**
- `push` is the one command that **writes to an instance directly.** It only ever touches the records you name (or `--all` selects), it refuses a record that changed on the instance since you pulled it, and `--dry-run` shows you every request before you send one. Everything else in now-fluent is read-only or local.

## Requirements

- Node.js 20.18.0 or newer.
- ServiceNow SDK installed and callable as `now-sdk` (or set `NOW_FLUENT_SDK`).
- A ServiceNow SDK auth alias for commands that talk to an instance.

```bash
npm install --global @servicenow/sdk
now-fluent auth --add https://dev12345.service-now.com   # forwarded to now-sdk auth
```

The SDK executable defaults to `now-sdk` on your PATH. Override it with the `NOW_FLUENT_SDK` environment variable, e.g.:

```bash
NOW_FLUENT_SDK="npx @servicenow/sdk" now-fluent build
```

## Install locally

From this folder:

```bash
npm link
now-fluent doctor
```

Or run without linking:

```bash
node ./bin/now-fluent.mjs help
```

## Drop-in for now-sdk

Any command that isn't a now-fluent enhanced command is passed straight through to now-sdk with your exact arguments:

```bash
now-fluent auth --add https://dev12345.service-now.com
now-fluent init --appName "My App" --packageName my-app --scopeName x_my_app --template base
now-fluent build
now-fluent transform --auth dev --table sys_script_include --id 0123456789abcdef0123456789abcdef
now-fluent install --auth dev
now-fluent explain BusinessRule
```

To see now-sdk's own help for any command, just forward it:

```bash
now-fluent build --help
now-fluent transform --help
```

`now-fluent help` shows now-fluent's help; `now-fluent doctor` reports the now-fluent, Node, and now-sdk versions.

## pull / push — the tight edit loop against a live record

`update-set-package` is the *governed* path: build an update set, import it, preview it, commit it. That is right for promoting a change you do not own, and heavy for fixing a typo in a script include.

`pull`/`push` is the inner loop. Both ends are the plain Table REST API — the same ungated path `import --via query` uses — so neither is blocked by the scope checks that refuse `move`, the online `transform`, `download` and the SDK's own update-set export.

```bash
# read the record into the project AND snapshot what the instance holds right now
now-fluent pull --project ./work --auth dev --sys-id 0123456789abcdef0123456789abcdef

# ...edit the Fluent source...

# build, diff against the snapshot, and write only what changed back to the record
now-fluent push --project ./work --auth dev --sys-id 0123456789abcdef0123456789abcdef
```

### How push decides what to do

| situation | what push does |
| --- | --- |
| record does not exist on the instance | `POST` carrying the `sys_id`, so it keeps the identity `Now.ID` gave it |
| record exists, fields changed locally | `PUT` with **only** the changed fields |
| record exists, nothing changed locally | nothing — reported as `unchanged` |
| record changed on the instance since you pulled | **refused** (`--force` overrides) |
| record exists but was never pulled | **refused** — there is no baseline to tell your edits from someone else's |
| artifact is a `DELETE` (you removed the Fluent code) | skipped unless `--allow-delete` — and then still subject to every guard above |

The snapshot lives in `<project>/.now-fluent/state/<table>_<sysid>.json`. It is what makes the diff and the drift check possible, and it is disposable — add `.now-fluent/state/` to `.gitignore`. **Commit `.now-fluent/adopted.json`**, though: it records which sources were adopted from another scope (below), and it belongs with the source it describes. A snapshot taken against one instance is never used as the diff reference for another — push notices and refuses.

### Cross-scope: pull adopts, push returns

A Fluent project is bound to one scope, and the SDK enforces it at build time — a script include pulled from Global carries `apiName: 'global.X'`, which a project bound to `x_my_app` refuses to compile (`error TS11: apiName must begin with 'x_my_app.'`).

So **pull adopts** a record from another scope: it rewrites `sys_scope` and the `api_name` prefix into the project's scope before the offline transform, and the source compiles as if the record had always been the project's. The baseline records the origin, and **push returns it there** — translating the fields back and updating the original record: same `sys_id`, same record, still in Global.

```bash
# project bound to x_my_app; the record lives in Global
now-fluent pull --project ./work --auth dev --sys-id <global script include>
#   pull ADOPTS them ... global -> x_my_app (push returns it to global)
#   apiName in the source: x_my_app.PriceUtils
now-fluent push --project ./work --auth dev --sys-id <same>
#   adopted from global: pushing it back there (api_name x_my_app.PriceUtils -> global.PriceUtils)
#   updated (1 field(s))
```

Only your edits are sent; the scope and `api_name` translate back and diff out.

**`update-set-package` respects adoption too.** Packaging an adopted record into an update set for the project's scope would *move* it into that scope on commit and rename its `api_name` — so it refuses, and offers the choices:

| you want to | run |
| --- | --- |
| edit it in place, governed | `update-set-package --scope global --scope-id global --include <sys_id>` — the payload is translated back to Global |
| edit it in place, quickly | `push` |
| move it into your project's scope | `update-set-package --move-adopted` — says which `api_name`s will change |

Packaging records built in your project's scope for **another** scope (`--scope global`) rewrites their `api_name` along with `sys_scope` — `x_my_app.Helper` becomes `global.Helper` — so each payload matches the scope it lands in. It says so, and lists the renamed records: committing creates them in that scope, or moves them there if they already exist in yours. `--keep-payload-scope` leaves both as built.

`import` (on the query path) and `import-update-set` adopt the same way: records from another scope are rewritten before the transform, and their origin is recorded once they land. Flows go through the SDK's online transform and are not adopted.

Adoption happens on the query path (pull's default), because only that path's rebuilt XML is ours to rewrite and record. `--no-adopt-scope` skips the *rewrite* only — the record's origin is still recorded, because the SDK build stamps the project's scope onto every artifact whether or not the source was rewritten, and forgetting the origin would let `update-set-package` package it as a move. (Without the rewrite, a record carrying an `apiName` will fail the build with TS11.)

### Scope: push cannot choose one

**Verified live (dev instance, SDK 4.12.x): `sys_scope` is inert on a Table API write.** The platform sets it from the scope the REST transaction runs in — Global for `/api/now/table` — and rewrites `api_name` to match (`x_my_app.Thing` → `global.Thing`). The `apps.current_app` user preference does not steer it either.

So push cannot put a record in a scope of your choosing. What it does instead:

| case | behaviour |
| --- | --- |
| updating an existing record | unaffected — its scope is already set, and the field is ignored |
| **creating** a record in the project's own scope | run **as that application** (`?sysparm_transaction_scope=`). **Probe first:** once per run a throwaway inactive script include is created as the app, its scope read back, and it is always deleted; your record is created only if the probe landed in the app — otherwise the create is refused and nothing of yours was written. Your record's scope is verified too (landed elsewhere → deleted and reported FAILED). The app must exist on the instance; `sys_db_object`/`sys_dictionary` creates are refused (a DELETE cannot un-make a table or column). Verified live on one dev instance (`sn_sow`); the spike's `transaction-scope` line checks yours. Updates and deletes of records inside an app run as that app (a Global DELETE was refused live with 403). |
| **creating** a record in any other scope | **refused** |
| `--target-scope global` | creates it in Global on purpose, and reports the scope and `api_name` it actually got |
| `--target-scope <other scope>` (not global, not the project's own) | refused before any request — this transport cannot do it |

Every write reads `sys_scope` back afterwards and fails the record if it landed somewhere else. That check is the whole point: before it existed, a scoped create reported `created (13 field(s))` while silently producing a Global record with a rewritten `api_name`.

**To get records into a specific scope, use `update-set-package`** — its payload carries `sys_scope`, and import/preview/commit places records properly:

```bash
now-fluent update-set-package --project ./work --update-set-name "To Global"   --scope global --scope-id global --build-local
```

`--target-scope global` is for records you **author** in a scoped project and want created in Global. A record you **pulled** from Global needs none of this — adoption returns it automatically (above).

For an **authored** record, write its `apiName` in the project's scope (`x_my_app.Thing`) — the build still rejects `apiName: 'global.Thing'` in a scoped project (TS11). With `--target-scope global` the platform creates it in Global and rewrites the `api_name` to `global.Thing` itself; push reports what it got.

push also refuses, **before writing**, any update whose source puts the record in a different scope from where it lives on the instance — sending it could rename the record's `api_name` out from under its callers. The usual cause is a record pulled without adoption; pulling it again fixes it.

### Update set capture: reported, not controlled

`--update-set <sys_id|name>` points your account's session at an in-progress update set. **Verified live: that does not reliably steer capture** — a REST transaction resolves its own update set, and a record written while the session pointed at a named set was captured into `Default` instead.

So the flag's real job is the check that follows: after the push, it looks at where each write was actually captured and, on a mismatch, names the set it went to and fails the run. It restores your previous update set preference afterwards either way.

If you need changes in a specific update set, build one with `update-set-package` rather than hoping capture follows.

### Two limitations worth knowing

**push cannot clear a field by deleting it from the Fluent source.** A Table API write merges, and the built artifact only contains the fields your Fluent code models — so "absent from the artifact" means "not modelled", not "delete this value". Removing a property leaves the old value on the record. Set it to an explicit empty value instead.

**pull replaces local source.** It takes the instance version of the records you name, so uncommitted Fluent edits to those records are lost. It warns when a record already exists locally; commit or stash first.

### Credentials

`push`/`pull` use **the credential you already gave the SDK** — no second profile, no keychain, no extra tool. `now-sdk auth --print <alias>` exists to hand out a live credential for manual API calls, and that is exactly what now-fluent asks it for. `now-fluent doctor` reports whether that works.

### What push is NOT

A push is a **record write**, so it runs business rules exactly as editing the form would. Committing an update set does not. For a script include that difference is nil; for dictionary and table records it is not. `push` also produces no update set of its own unless you point the session at one with `--update-set <sys_id|name>` (experimental — see below).

Use `update-set-package` to promote anything you do not own.

### Before trusting it: run the spike

Two platform behaviours `push` depends on — that a Table API `PUT` **merges** rather than replaces, and that an insert honours a supplied `sys_id` — plus whether your instance lets you write into a given application scope at all, are instance- and version-dependent. Prove them on a dev instance first:

```bash
npm run verify-push -- --auth dev                 # Global only
npm run verify-push -- --auth dev --scope sn_hamp # ...and inside an application scope
```

It creates throwaway `sys_script_include` records, checks each assumption, deletes them again, and exits non-zero if any assumption fails. `--keep` leaves the records behind for inspection.

### Useful flags

| flag | effect |
| --- | --- |
| `--dry-run` | build, read the live records and run every guard, then print the exact verb, URL and (diffed) body — writes nothing |
| `--all` | push every built record (`--include`/`--exclude` select, same tokens as `update-set-package`) |
| `--full` | send every modelled field, not just the changed ones |
| `--force` | push anyway when the record drifted |
| `--no-drift-check` | skip the drift comparison entirely |
| `--no-build` | push whatever is already in the build output |
| `--target-scope global` | create in Global on purpose from a scoped project (the only value this transport can deliver) |
| `--no-scope` | omit `sys_scope` from the body — a no-op on the instance, since the field is ignored either way |
| `--allow-delete` | apply `DELETE` artifacts instead of skipping them |
| `--update-set <id\|name>` | point your session at an update set, then verify where capture actually landed |

`--table` is optional for both commands: `push` reads it from the built artifact (and validates a `--table` you do pass against it), and `pull` resolves it from `sys_metadata.sys_class_name`.

## import — bring records into a project

`import` has three ways to get a record into a project and tries them in order until one lands:

| strategy | what it runs | needs |
| --- | --- | --- |
| `move` | `now-sdk move --ids ...` | the target app to already exist on the instance |
| `transform` | `now-sdk transform --table <t> --id <id>` | the SDK's scope checks to allow the record |
| `query` | `now-sdk query` → rebuilt `<record_update>` XML → `now-sdk transform --from` | nothing beyond read access |

The `query` strategy is the one that always works: it reads the record through the plain Table REST API and rebuilds its update-set-style XML locally, so no scope-gated SDK endpoint is in the path. That is what makes records in ServiceNow-owned scopes importable when `move` and the online `transform` are refused.

```bash
now-fluent import \
  --project ./my-app \
  --auth dev \
  --sys-id 0123456789abcdef0123456789abcdef
```

Multiple records — repeated flags, comma-separated lists, or positional ids all work:

```bash
now-fluent import --project ./my-app --auth dev --sys-id id1 --sys-id id2
now-fluent import --project ./my-app --auth dev --sys-id id1,id2,id3
now-fluent import --project ./my-app --auth dev id1 id2 id3
```

### `--table` is now optional

The table of any sys_id is resolved with one query against `sys_metadata.sys_class_name`, so the old "cannot fall back to transform without a table" dead end is gone. Pass `--table` only for records that do not extend `sys_metadata` (plain data tables), or to skip the lookup.

### Importing by query

`--query <encoded query>` (with `--table`) imports everything a query matches instead of a sys_id list:

```bash
now-fluent import --project ./my-app --auth dev \
  --table sys_script_include \
  --query "sys_scope.scope=sn_hamp^active=true"
```

It defaults to `--via query`, and skips records already registered in the project's `keys.ts` — so an interrupted bulk import can simply be re-run. `--force` re-imports everything; `--limit <n>` caps how many records it takes.

### Composite records

The query path also fetches each record's family — a UI policy's actions, an ACL's roles, a form's sections and elements — and transforms them **in the same call**, so now-sdk embeds them in the parent's DSL instead of defining them twice. `--no-related` imports the record alone.

Covered families:

| parent | fetched with it |
| --- | --- |
| `sc_cat_item` | variables, UI policies, policy actions, catalog client scripts |
| `sys_db_object` | every field (`sys_dictionary`) and its choice lists |
| `sys_ui_form` | form sections, sections, elements |
| `sys_ui_policy` / `catalog_ui_policy` | their actions |
| `sys_security_acl` | its roles |
| `sys_transform_map` | its entries and scripts |
| `sys_ui_list` | its elements |

Anything else imports as a single record. That is usually fine, because `--via auto` tries the online `transform --table --id` first and the SDK resolves relationships there itself — the family list only matters when the online transform is refused. Adding a family is one line in the source; the link columns are discovered automatically.

The family is discovered from `sys_dictionary` rather than hard-coded, and the walk follows references outward in both directions until nothing new turns up, so a form reaches its elements through the section m2m (`sys_ui_form` → `sys_ui_form_section` → `sys_ui_section` → `sys_ui_element`). It also resolves table inheritance on both sides: `catalog_ui_policy_action` inherits its `ui_policy` column from `sys_ui_policy_action`, and that column references `sys_ui_policy` — matching only the concrete tables would silently produce a policy with no actions.

Some members are joined by a field value rather than a sys_id reference — a table's fields and choices are matched by table *name* — so those joins are declared explicitly and kept out of the reference walk. Choices are limited to the instance's base language, since only that language embeds into the schema and the translations would otherwise arrive as dozens of loose records.

Verified against a live instance: a catalog item imports as a `CatalogItem()` with all 13 of its variables embedded, 11 UI policies carrying their 17 actions, and 3 client scripts that reference the item's exported symbol; a table imports as a `Table()` with a 25-column typed schema and its choice lists; importing a catalog UI policy by sys_id produces byte-identical output to importing the update set that contains it; and a form imports with all its sections, layout and 18 fields.

`sys_ui_list_control` is the one family member with no reference column back to its parent (it is matched by name/view), so import it through the update set instead.

### Other flags

`--via auto|move|transform|query` pins one strategy. `--dry-run` prints the plan for whichever strategies apply. `--out <dir>`/`--keep` preserve the rebuilt XML for inspection. Failures self-heal the same way `import-update-set` does: files named in a build ERROR are removed (or auto-fixed) and the unit retried, with a verification build at the end (`--keep-failed` leaves them on disk). `-- <args>` passes extra flags to the underlying now-sdk calls (e.g. `-- -d`).

## import-update-set — import a whole update set as Fluent source

Converts every record captured in an update set into Fluent source. The update set can come from a local XML export **or straight off the instance**:

```bash
# from an XML file you exported/published manually — no instance contact at all
now-fluent import-update-set --from ./my-update-set.xml --project ./my-app

# from the instance, by sys_id (or by name)
now-fluent import-update-set --sys-id <update set sys_id> --auth dev --project ./my-app
now-fluent import-update-set --name "My update set" --auth dev --project ./my-app
```

Reading it from the instance queries the set's `sys_update_xml` rows, whose `payload` field holds exactly the same `<record_update>` blob the XML export wraps — so both sources feed one identical pipeline. Compared with exporting first, it:

- needs no export step, and no `--from` file to keep track of;
- works on an update set that is still **in progress** (nothing has to be marked complete and exported);
- is a plain Table API read, so it also works where the SDK's own gated update-set download is refused;
- searches both `sys_update_set` (built locally) and `sys_remote_update_set` (retrieved), so any update set sys_id can just be pasted in;
- handles **batched** update sets: a batch parent captures nothing itself, so the whole child tree is walked and imported, matching what the platform's own export of a parent contains.

Validated against a live instance: for every update set exported locally from that instance, the payloads fetched by `--sys-id` are byte-identical to the exported XML (4, 19, 36, 65, 320 and 631-record sets). Where a record was captured in several sets of one batch, the instance route resolves to the **newest** capture — confirmed to match the record's live state, while the exported file can hand you a stale earlier one.

Everything downstream is the same for both sources: per-record progress, resume via `keys.ts`, family batching, self-healing, and online routing for flows and action definitions. See `now-fluent help` for the full flag list (`--include`/`--exclude`, `--bulk`, `--force`, `--keep-failed`, `--no-flows`, `--out`, `--keep`).

## export-xml — export the built record XML

```bash
now-fluent export-xml --project ./my-app --build-local --zip
```

`--build-local` runs `now-sdk build` first. The export contains the raw per-record `<record_update>` build artifacts plus a `manifest.json`. These are build artifacts, not an update set — use `update-set-package` for that.

By default **every built record is exported**. To export only some, use the same `--include`/`--exclude` selection as `update-set-package` (repeatable, comma-separated, substring match — a sys_id for one record, a table name for a type):

```bash
# only the script include(s)
now-fluent export-xml --project ./my-app --build-local --include sys_script_include

# everything except the SDK bookkeeping sys_module records
now-fluent export-xml --project ./my-app --build-local --exclude sys_module

# two specific records by sys_id
now-fluent export-xml --project ./my-app --build-local --include id1,id2
```

## update-set-package — build an importable update set

Builds a **real, directly-importable ServiceNow update set XML** from the project's built record XML. Ideal for Global scope or ServiceNow-owned/vendor scopes (e.g. HAM) where an SDK install is not appropriate.

```bash
now-fluent update-set-package \
  --project ./my-app \
  --update-set-name "HAM Custom Disposal Utils" \
  --scope sn_hamp \
  --include sys_script_include \
  --build-local
```

It produces, in `exports/<update-set-name>/` (named after `--update-set-name`, so re-running with the same name **overwrites it in place** instead of leaving timestamped copies):

- `update-set-<name>.xml` — the importable update set (an `<unload>` with one `sys_remote_update_set` and one `sys_update_xml` per selected record).
- The raw per-record build artifacts (for review/diffing).
- `manifest.json` and `UPDATE_SET_CHECKLIST.md`.
- An optional `.zip` (only with `--zip`).

Import it in ServiceNow via **System Update Sets → Retrieved Update Sets → Import Update Set from XML → Preview → Commit**. The tool never touches the instance.

### Naming, scope, and ownership

| Flag | Purpose | Default |
|------|---------|---------|
| `--update-set-name` | Name shown in ServiceNow + the output folder name | generated |
| `--scope` | Application scope (e.g. `sn_hamp`) | `now.config.json` → `scope` |
| `--scope-id` | Scope/app sys_id | `now.config.json` → `scopeId` |
| `--app-name` | Application display name | `now.config.json` → `name`, else scope |
| `--description` | Update set description | generated |
| `--owner` | `sys_created_by` to stamp | `admin` |
| `--out` | Explicit output folder (not auto-overwritten) | `exports/<name>/` |
| `--no-bundle` | Write only the update set XML (no manifest/checklist/copies) | off |
| `--zip` | Also produce a `.zip` | off |
| `--keep-payload-scope` | Keep each payload's `sys_scope` as built. By default every payload `sys_scope` is rewritten to `--scope`/`--scope-id`, so e.g. a Global (`--scope global --scope-id global`) or other-scope update set built from an `sn_*` project lands in the right application | off |

Known now-sdk build defects are fixed in the payloads before packaging: `sys_hub_flow_snapshot.outputs` serialized as `[object Object]` (subflows with a `masterSnapshot`) is written empty, as on the instance. Top-level flow steps (`sys_hub_action_instance_v2`, `sys_hub_flow_logic_instance_v2`, `sys_hub_sub_flow_instance_v2`) are emitted without `parent_ui_id`; an explicit empty `<parent_ui_id/>` is added so a step moved out of a removed If/loop is re-parented on commit. Any other `[object Object]` in a payload is reported as a warning.

Run from a project that has `now.config.json` (any `init`-created project) and scope/scope-id/app-name are filled in automatically — you usually only pass `--update-set-name` and your selection.

### Selecting which records to include

Records are gathered from `dist/app/update`, `dist/app/author_elective_update` (record deletions tracked in `keys.ts`, emitted with `action="DELETE"` and packaged as `sys_update_xml` action `DELETE`), `metadata/update`, and `dist/update` (filenames look like `<table>_<sysid>.xml`), then filtered:

- `--include <token[,token...]>` — keep only files matching a token.
- `--exclude <token[,token...]>` — drop files matching a token.

Both are **repeatable and accept comma-separated lists**, so you can include several objects in one command — all equivalent:

```bash
--include id1 --include id2 --include id3
--include id1,id2,id3
--include id1,id2 --include id3
```

A token is a filename substring, so a **sys_id** selects one exact record and a **table name** selects a type. Mix freely — e.g. one script include + one business rule:

```bash
--include e4954a6feb8222101eb4f30e8ad0cd4c,f9318f6777ad71102383b5ff9a5a9976
```

> Caveat: tokens are substrings, so `sys_script` also matches `sys_script_include` (and `sys_script_client`, etc.). Disambiguate within the `sys_script*` family by sys_id.

> The SDK emits `sys_module` records for `bom.json`/`package.json` next to your real records. Select your records by sys_id, or add `--exclude sys_module`, to keep them out of the update set.

## Optional config file

Create `.now-fluent.json` in your working directory to set defaults for the enhanced commands:

```json
{
  "project": "./my-app",
  "auth": "dev",
  "table": "sys_script_include",
  "via": "query",
  "updateSetName": "My customizations",
  "scope": "sn_hamp",
  "scopeId": "6cd246601b9e0010cf95dd33dd4bcb8a",
  "appName": "Hardware Asset Management",
  "owner": "admin"
}
```

## ServiceNow-owned scopes such as Hardware Asset Management

ServiceNow-owned scopes (e.g. HAM, `sn_hamp`) should be treated differently from custom scoped apps you own:

- Use `now-fluent import` to bring records into a local project for analysis and Fluent authoring. Its `query` strategy reads records through the plain Table API, so it works in vendor scopes where `move` and the online `transform` are refused — as does `import-update-set --sys-id`, which needs no export step.
- Bind the project to the scope (its `now.config.json` `scope`/`scopeId`) so builds keep the correct `apiName`.
- Prefer **`update-set-package`** to land customer changes through ServiceNow's import/preview/commit flow, rather than installing an SDK package into a vendor scope.
- Do not `install` into a ServiceNow-owned scope unless your organization explicitly owns and governs that application/version.
- `push` is *technically* not scope-gated (it is the plain Table API), but "the API allows it" is not "your governance allows it". Verify with `npm run verify-push -- --auth dev --scope <scope>` on a dev instance, and keep vendor-scope changes on the update-set path unless your process says otherwise.

## Working with the official ServiceNow SDK plugin/skills

Use the official ServiceNow SDK plugin/skills for knowledge and code authoring (how to model a Business Rule, ACL, Table, Scripted REST API, Flow, etc., and `now-sdk explain`). Use `now-fluent` for execution: it is now-sdk plus `pull`/`push`, `import`, `import-update-set`, `export-xml`, and `update-set-package`.

## Tests

```bash
npm test                              # parser unit tests + push/pull end-to-end tests
npm run verify-push -- --auth dev     # the live spike against a real instance
```

`npm test` needs no instance and no SDK: a fake `now-sdk` and an in-process mock Table API stand in for both. The mock encodes the two platform behaviours `push` relies on (PUT merges, POST honours a supplied `sys_id`), so the tests prove the *client* is correct **given** those semantics — `verify-push` is what proves the platform provides them.
