# Claude Code instructions for ServiceNow SDK work

You are working in or near a ServiceNow SDK/Fluent project. Use the local `now-fluent` wrapper instead of calling `now-sdk` directly unless the user explicitly asks otherwise.

`now-fluent` is a thin wrapper around `now-sdk`:

- It **forwards every now-sdk command and its exact arguments verbatim**, so anything you'd run as `now-sdk <cmd> ...` you run as `now-fluent <cmd> ...` (current and future commands alike).
- It **adds three enhanced commands**: `import`, `export-xml`, and `update-set-package`.

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
