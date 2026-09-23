# Claude Code instructions for this Fluent project

<!--
  Template from the now-fluent repo (templates/fluent-project/CLAUDE.md).
  Copy it to the root of a Fluent project as CLAUDE.md and fill in the <...> values.

  The @ line below pulls in now-fluent's full instructions from your local clone, so
  every project stays current with a `git pull` of now-fluent. Point it at YOUR clone.
  For a cloud session (claude.ai/code), which only sees this repository, a path on your
  laptop will not resolve: replace the @ line with a copy of now-fluent's CLAUDE.md.
-->

@<absolute path to your now-fluent clone>/CLAUDE.md

## This project

- **Instance alias:** `<alias>` — pass it as `--auth <alias>`. Check with `now-fluent doctor`.
- **Scope:** `<scope>` (`scopeId` `<sys_id>`), as set in `now.config.json`.
  <!-- Delete whichever line does not apply. -->
  - This is a ServiceNow / Store scope the project is BOUND to, not an app we own. Do not `install` into it; promote with `update-set-package`, or `push` only where our governance allows direct writes.
  - This is our own custom scoped app.
- **Promotion path:** <e.g. "update sets only — import, preview and commit by hand", or "push on dev, update-set-package for test/prod">

## Before the first push to an instance

Run the live check once per instance and scope. It writes throwaway, inactive script
includes and deletes them again, so ask before running it:

```bash
now-fluent verify-push --auth <alias> --scope <scope>
```

## Notes

<!-- Anything specific to this project: records not to touch, naming conventions, who approves pushes. -->
