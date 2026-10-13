# S1: first run asks, never auto-imports — phone screenshots (390px)

Captured by `packages/pwa/harness/screenshot.ts --settings-only` (and `--light`), the run that also
asserts the Machines geometry gate (82/82) and no sideways scroll (113/113) in both schemes.

- `before/` — origin/main (v3.38.0), from `assets/account-u21-margins` `after/`: the first run was a
  link on the Runtimes card (`not-set-up`), and its first screen (`first-run`).
- `after/` — this branch: the machine opens its first run by itself (`first-run`, the tools step),
  then one question per tool (`first-run-claude`, `first-run-codex` with Sign in now), the sign-in in
  place (`first-run-sign-in`), the "nothing set up yet" ending (`first-run-nothing`), and the
  Runtimes card it leaves to (`not-set-up`).
