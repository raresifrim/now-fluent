# now-fluent

`now-fluent` is a thin wrapper around the ServiceNow SDK (`now-sdk`). It does two things:

1. **Forwards every now-sdk command verbatim** — use `now-fluent` exactly like `now-sdk`, with the same commands and arguments (including any future now-sdk commands).
2. **Adds a few Fluent-focused helpers** on top: `import` (move with a transform fallback), `export-xml`, and `update-set-package` (build a real, importable ServiceNow update set).

```text
now-fluent <now-sdk-command> [...exact now-sdk args]   # forwarded to now-sdk
now-fluent import | export-xml | update-set-package    # handled by now-fluent
```

## Safety model

- It does not commit to Git.
- It does not deploy anything to an instance unless you run an SDK command that does (`now-fluent install`, etc.) — those are just forwarded to now-sdk.
- `update-set-package` can build a real, importable update set XML, but it only writes the file locally — **importing, previewing, and committing stay manual steps you perform in ServiceNow.**

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

## import — bring records into a project by sys_id

`import` tries `now-sdk move` first and, if that fails, falls back to `now-sdk transform` for each record. (`move` claims records into the app but needs the app present on the instance; `transform --table --id` downloads and converts without that requirement, but needs the record's table.)

```bash
now-fluent import \
  --project ./my-app \
  --auth dev \
  --sys-id 0123456789abcdef0123456789abcdef
```

Multiple records — repeated flags, comma-separated lists, or positional ids all work:

```bash
now-fluent import --project ./my-app --auth dev \
  --sys-id id1 --sys-id id2

now-fluent import --project ./my-app --auth dev \
  --sys-id id1,id2,id3

now-fluent import --project ./my-app --auth dev id1 id2 id3
```

Enable the transform fallback by giving the table the record(s) belong to:

```bash
now-fluent import --project ./my-app --auth dev \
  --table sys_script_include \
  --sys-id 0123456789abcdef0123456789abcdef
```

If `move` fails and no `--table` is provided, `import` stops and tells you to re-run with `--table` (transform needs a table). Use `--dry-run` to print the now-sdk commands without running them, and `-- <args>` to pass extra flags through to the underlying move/transform (e.g. `-- -d`).

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

Run from a project that has `now.config.json` (any `init`-created project) and scope/scope-id/app-name are filled in automatically — you usually only pass `--update-set-name` and your selection.

### Selecting which records to include

Records are gathered from `dist/app/update`, `metadata/update`, and `dist/update` (filenames look like `<table>_<sysid>.xml`), then filtered:

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
  "updateSetName": "My customizations",
  "scope": "sn_hamp",
  "scopeId": "6cd246601b9e0010cf95dd33dd4bcb8a",
  "appName": "Hardware Asset Management",
  "owner": "admin"
}
```

## ServiceNow-owned scopes such as Hardware Asset Management

ServiceNow-owned scopes (e.g. HAM, `sn_hamp`) should be treated differently from custom scoped apps you own:

- Use `now-fluent import` / `now-fluent transform` to bring records into a local project for analysis and Fluent authoring.
- Bind the project to the scope (its `now.config.json` `scope`/`scopeId`) so builds keep the correct `apiName`.
- Prefer **`update-set-package`** to land customer changes through ServiceNow's import/preview/commit flow, rather than installing an SDK package into a vendor scope.
- Do not `install` into a ServiceNow-owned scope unless your organization explicitly owns and governs that application/version.

## Working with the official ServiceNow SDK plugin/skills

Use the official ServiceNow SDK plugin/skills for knowledge and code authoring (how to model a Business Rule, ACL, Table, Scripted REST API, Flow, etc., and `now-sdk explain`). Use `now-fluent` for execution: it is now-sdk plus `import`, `export-xml`, and `update-set-package`.
