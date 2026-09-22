# Real `now-sdk build` output

Genuine artifacts from ServiceNow SDK 4.12.2 compiling a hand-written Fluent project
(a `ScriptInclude`, a `BusinessRule` and a `Property` in scope `x_push_demo`).

They are here because hand-written XML is a poor test of a parser: real output has
details you would not think to invent. These files carry
`action="INSERT_OR_UPDATE" apply_defaults="true"` — a SECOND attribute after `action`,
which an earlier version of the parser rejected outright — plus a CDATA script, an
empty `<caller_access/>`, and a `<sys_update_name>` that must never be written back.

Regenerate by running `now-sdk build` in a Fluent project and copying
`dist/app/update/*.xml`.
