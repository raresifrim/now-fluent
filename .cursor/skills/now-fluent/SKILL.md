---
name: now-fluent
description: >-
  Run ServiceNow SDK/Fluent CLI workflows via the now-fluent wrapper (now-sdk
  plus import, import-update-set, export-xml, update-set-package). Use when the
  user mentions ServiceNow, now-sdk, now-fluent, Fluent projects, update sets,
  HAM/sn_hamp, transform/import/build/install, or a now.config.json project.
---

# now-fluent

Use **`now-fluent`** instead of raw **`now-sdk`** unless the user explicitly asks otherwise.

- Forwards every now-sdk command verbatim: `now-fluent <cmd> ...` ≡ `now-sdk <cmd> ...`
- Adds: `import`, `import-update-set`, `export-xml`, `update-set-package`
- Pair with the official **now-sdk-explain** skill for Fluent API / DSL knowledge

## Core rules

1. Do not commit to Git unless the user explicitly asks.
2. Do not run deploy commands (`now-fluent install`, etc.) without explicit approval.
3. Use `--dry-run` on enhanced commands when the command shape is uncertain.
4. Treat ServiceNow-owned scopes (e.g. HAM / `sn_hamp`) as high risk — prefer local import/transform, scope-bound projects, and update-set workflows over SDK install into vendor scopes.
5. **Artifacts:** `dist/app/update/*.xml` are build artifacts, NOT an update set. Only `update-set-*.xml` from `update-set-package` is a real importable update set.
6. Never ask the user to paste passwords, tokens, or secrets — use `now-fluent auth --add <url>` and let them complete SDK auth.

## Discovery

```bash
now-fluent doctor    # versions
now-fluent help      # enhanced commands
now-fluent build --help   # any now-sdk command help via forwarding
```

Override SDK binary: `NOW_FLUENT_SDK="npx @servicenow/sdk"`. Optional defaults: `.now-fluent.json`.

## Common workflows

### New custom scoped app

```bash
now-fluent init --appName "My App" --packageName my-app --scopeName x_my_app --template base
now-fluent build
now-fluent install --auth <alias>   # only after explicit approval
```

### Import record(s) by sys_id

```bash
now-fluent import --project ./work --auth <alias> --sys-id <32hex> --table <table>
```

Tries `move` first; needs `--table` for transform fallback. Multiple ids: repeat `--sys-id`, comma list, or positional.

### Import exported update set XML → Fluent source

```bash
now-fluent import-update-set --from ./my-update-set.xml --project ./work --auth <alias>
```

Needs `--auth` for flows (`sys_hub_*`). Use `--include` / `--exclude` on large sets. Resumes via `keys.ts`; `--force` re-imports all.

### Export build artifacts (not an update set)

```bash
now-fluent export-xml --project ./work --build-local --zip
```

### Build importable update set (preferred for Global / vendor scopes)

```bash
now-fluent update-set-package \
  --project ./work \
  --update-set-name "<name>" \
  --include <token> \
  --build-local
```

Output: `exports/<name>/update-set-<name>.xml`. User imports manually: **System Update Sets → Retrieved Update Sets → Import Update Set from XML → Preview → Commit**.

`--include` / `--exclude`: substring match on `<table>_<sysid>` filenames; repeatable and comma-separated. Exclude `sys_module` unless wanted.

### Vendor scope (e.g. HAM)

1. Bind project: set `now.config.json` `scope` and `scopeId`
2. Import/transform records locally
3. `now-fluent build` to verify
4. Ship via `update-set-package`, not `install`, unless governance explicitly allows

## When stuck

- Read [reference.md](reference.md) for import-update-set healer/resume/family-group details
- Read project `CLAUDE.md` or `README.md` in the now-fluent repo
- Use `now-fluent explain <Topic>` (forwarded) or the now-sdk-explain skill for DSL/API docs
