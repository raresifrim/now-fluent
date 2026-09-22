# now-fluent reference

## Enhanced commands summary

| Command | Purpose |
|---------|---------|
| `doctor` | Report now-fluent, Node, now-sdk versions + push/pull credential readiness |
| `pull` | Import a record AND snapshot its live state as a push baseline |
| `push` | Write the built record back to the instance through the Table API |
| `import` | Bring records into a project by sys_id (move → transform fallback) |
| `import-update-set` | Unwrap update set XML payloads → transform to Fluent source |
| `export-xml` | Export built `<record_update>` artifacts + manifest |
| `update-set-package` | Build real importable update set XML from built records |

All other commands forward to now-sdk unchanged.

## pull / push — key behaviors

The inner edit loop. Both ends are the plain Table REST API, so neither is gated by the
scope checks that refuse `move` / online `transform` / `download`.

**Credentials.** Taken from the SDK's own store: `now-sdk auth --list` gives the host,
`now-sdk auth --print <alias> --format headers` gives live auth headers (that flag
exists for exactly this — "for use in manual API calls"). No second profile, no
keychain, no ServiceNow CLI (`snc`) dependency.

**`pull`** = `import --via query --force`, plus a baseline at
`<project>/.now-fluent/state/<table>_<sysid>.json` holding the record's full field
values and its `sys_updated_on` / `sys_mod_count`. `--no-state` skips the baseline.

**`push`** builds, reads the compiled `<record_update>` artifact, and writes it back:

| situation | action |
|---|---|
| record absent on instance | `POST` carrying the `sys_id` (keeps `Now.ID` identity) |
| record present, fields edited | `PUT` with only the changed fields |
| record present, nothing edited | no request — `unchanged` |
| drifted since pull | REFUSED (`--force` overrides) |
| present but never pulled | REFUSED (no baseline to diff against) |
| `action="DELETE"` artifact | skipped unless `--allow-delete` |

Never written: `sys_created_*`, `sys_updated_*`, `sys_mod_count`, `sys_update_name`,
`sys_package`, `sys_policy`, `sys_class_name`. **Is** written: `sys_scope` (that is what
puts the record in the right scope) — `--no-scope` omits it.

Flags: `--dry-run` (print requests, send nothing), `--all` + `--include`/`--exclude`,
`--full`, `--no-build`, `--no-drift-check`, `--update-set <id|name>` (experimental).
One refused record does not abandon the rest of the run.

**Not an update set commit.** A push runs business rules like a form edit; a commit does
not. Use `update-set-package` to promote anything you do not own.

**Verify first:** `npm run verify-push -- --auth <alias> [--scope <scope>]` proves, on a
real instance, that a Table API `PUT` merges rather than replaces, that an insert honours
a supplied `sys_id`, and whether writes into the target scope are permitted at all.

## import-update-set — key behaviors

- Unwraps `<sys_update_xml><payload>` (HTML-escaped or CDATA) into per-record `<record_update>` files
- Default: per-record transform with build verification and self-healing (remove broken files, retry, heal duplicates)
- Order: family batches → online flows/actions → standalone records
- `--bulk`: one atomic transform (fast, silent, one failure aborts all)
- `--keep-failed`: don't remove broken generated files
- `--force`: re-import even if registered in `keys.ts`
- `--no-flows`: skip online flow/action transforms

### Family groups (transform together)

Avoid "defined 2 times" build conflicts:

- `sys_transform_map` + entries + scripts
- `sys_ui_list` + elements + controls
- `sys_security_acl` + roles
- `sys_ui_policy` + actions + rl_actions
- `catalog_ui_policy` + actions
- `sys_ui_form` + form sections + sections + elements

### Flows (`sys_hub_*`)

Offline transform fails (missing shapes). Wrapper skips offline `sys_hub_*` and imports online:

1. Custom action definitions (`sys_hub_action_type_definition`)
2. Flows (`sys_hub_flow`)

Auto-fixes empty-string enum props in generated `Action()` files (known now-sdk bug).

### Good excludes for large exports

`sys_documentation,sys_translated,sys_ui_message,sys_atf_test,sys_atf_step,sys_hub_,sp_rel_widget_clone`

(flows auto-routed separately; include specific flow sys_ids selectively)

### HAM / vendor scope workaround

`download` may be gated; update set export is not. Export to XML → `import-update-set`.

## update-set-package flags

| Flag | Default / notes |
|------|-----------------|
| `--update-set-name` | Output folder name; re-run overwrites in place |
| `--scope`, `--scope-id`, `--app-name` | From `now.config.json` |
| `--owner` | `admin` |
| `--out` | Explicit folder (not auto-overwritten) |
| `--no-bundle` | Update set XML only |
| `--zip` | Also produce zip |

Records gathered from `dist/app/update`, `metadata/update`, `dist/update`.

## .now-fluent.json defaults

```json
{
  "project": "./my-app",
  "auth": "dev",
  "table": "sys_script_include",
  "updateSetName": "My customizations",
  "scope": "sn_hamp",
  "scopeId": "...",
  "appName": "Hardware Asset Management",
  "owner": "admin"
}
```
