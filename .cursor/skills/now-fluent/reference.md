# now-fluent reference

## Enhanced commands summary

| Command | Purpose |
|---------|---------|
| `doctor` | Report now-fluent, Node, now-sdk versions |
| `import` | Bring records into a project by sys_id (move → transform fallback) |
| `import-update-set` | Unwrap update set XML payloads → transform to Fluent source |
| `export-xml` | Export built `<record_update>` artifacts + manifest |
| `update-set-package` | Build real importable update set XML from built records |

All other commands forward to now-sdk unchanged.

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
