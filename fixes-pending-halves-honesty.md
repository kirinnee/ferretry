# fixes-pending-halves-honesty

- ports-pending.json `pendingHalves` now names every real skeleton half (found with `isSkeleton` over all subsystems):
  catalogs/shells/layouts app (as briefed) PLUS found extras: gate app, vault app+cli, browsers cli, mcp cli, skills cli.
- `scripts/validate/ports-pending.ts`: two-way rule (skeleton half not named fails; a name for a real or missing half
  fails); `pendingHalves` only shrinks vs base, with `ONE_TIME_HALF_ALLOWANCE` (reason "a correction: these halves were
  skeletons the whole time (britnee)"). The allowance also lists the extras above — flag for britnee: the brief said
  exactly three, but without them the new rule adds findings.
- `pending-apps.ts` accepts daemon/app/cli names (registries still de-register only app halves).
- `typecheck-apps.ts`: a pending app half that is only `index.ts` needs no pendingAppPorts exclusion.
- Planted tests in scripts/gen/tests/checks.test.ts, both directions plus the shrink rule. gen/tests 128 pass 0 fail.
- check.ts: no new finding vs before (pre-existing: "board has reasons but is not listed in pending", gate/vault manifest-match, etc.).
- typecheck.sh, tsc -p ., tsc -p packages/app: clean.
