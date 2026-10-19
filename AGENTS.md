# Working in gesso

Use [README.md](README.md) for local setup and supported commands.

## Design decision record

Read [docs/design-decisions.md](docs/design-decisions.md) before changing product flow, interface hierarchy, visual language, motion, or interaction behavior.

Keep that log current in the same commit as a design change:

- Record the date, concrete decision, reason, affected surface, and implementation references.
- Distinguish implemented behavior, accepted direction still pending, and superseded decisions. Do not describe a prototype capability as shipped without checking the code.
- When a decision changes, append the new decision and mark or link the earlier one as superseded. Preserve why the earlier choice existed.
- Record retrospective decisions under the date they were documented; do not invent their original dates.
- Follow the user's latest correction and the current artifact when they conflict with an older log entry. Update the log to reflect the correction.

Routine fixes that only restore an already-recorded behavior do not need a new design decision. Record new constraints or changes in behavior that they reveal.
