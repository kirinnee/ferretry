# UNIT S1 — make the four packages real, and add the gates that police the migration

You are implementing **unit S1** of the Ferretry migration, the head of the serial foundation
spine. Every other unit rebases onto your work, so correctness and minimalism both matter.

## Where you work

**Worktree:** `<your-worktree>` — already created for you on branch
`port/s1-workspace-gates`. Work ONLY there. Do not touch the primary checkout at
`/home/kirin/Workspace/personal/ferretry` (that is the lead's, for review and merge).

First command in the worktree: `direnv allow .` (already run, but re-run if the env complains),
then use `direnv exec . <cmd>` for everything so the nix devshell is loaded.

## Read first

- `docs/design/migration-plan.md` — the binding plan. Your unit is §7's S1 row; §1.2 and §1.3
  explain the two gates you are adding and why.
- `docs/PROMPT.md` "Migration decisions".
- `docs/standards/` — especially `architecture`, `contracts`, `linting`, `taskfile`, `testing`,
  `three-layer-architecture`.
- `.claude/skills/cli-authoring/SKILL.md`.
- The real machinery you are extending: `package.json`, `packages/cli/package.json`,
  `tsconfig.json`, `bunfig.{unit,int,sit}.toml`, `Taskfile.yaml`,
  `tasks/Taskfile.{test,compile}.yaml`, `knip*.json`, `nix/pre-commit.nix`,
  `scripts/validate/cli-contracts.sh`.

## Safety

- **Never touch the live installation**: `~/.kteam`, the running `kteamd`, its tmux sessions, its
  ports. You have no reason to go near them in this unit.
- Public repo. No secrets in code, docs, commits, or PR text.

## Scope — exactly this, nothing more

### 1. Make `packages/{protocol,daemon,fleet,pwa}` real workspace members

Each currently holds only a `README.md`, so the `packages/*` glob matches nothing usable. Give
each a `package.json`, a `tsconfig.json` extending the root, and a minimal but real source entry
so typecheck, lint, dead-code, and coverage gates all have something valid to look at.

**Package naming — derive, never hardcode.** Per `docs/standards/architecture`, the PRODUCT name
lives only in the root `package.json` `name` (`ferretry`). New packages are scoped from it:
`@ferretry/protocol`, `@ferretry/daemon`, `@ferretry/fleet`, `@ferretry/pwa`.

**Do NOT rename or restructure `packages/cli`.** Its `name` and `bin` key are load-bearing for the
`name-single-source` contract. Leave both exactly as they are.

Because the scope now encodes the product name, `scripts/local/rename.sh --product <name>` must
also rewrite these package scopes — extend it, and verify by running a rename to a scratch name
and back, confirming a clean `git diff`.

### 2. Extend the contract gate to every package

`scripts/validate/cli-contracts.sh arch` currently checks `packages/cli` only. Parameterize it
over the workspace packages so each package's `src/lib` purity is enforced (no `console`, no
`process.*`, no terminal deps, no imports from `adapters/`). An empty or minimal package must
pass **trivially, not vacuously** — if there is no `src/lib` yet, that is fine, but the gate must
fail loudly the moment a violating file appears.

Add a contract asserting **every workspace package's scope matches the product name**, so a
future package cannot drift from the two-name model.

### 3. Add the `no-legacy-state` gate — this is the important one

New `scripts/validate/no-legacy-state.sh`, wired into `nix/pre-commit.nix` as an `a-`-prefixed
hook (follow the existing convention; note `treefmt` and typecheck are the exceptions).

It must fail when any file under `packages/` contains `KTEAM_`, `.kteam`, `kteamd`, or `kfleet` as
an identifier or path literal. The migration forbids backward compatibility, and dozens of agents
will port code that is full of these strings — this gate is what makes that rule mechanical
instead of a hope.

Requirements: `set -euo pipefail`, shellcheck-clean, executable, fast. Documentation prose that
legitimately discusses the history is exempt via a **narrow, explicit allowlist** — a path list in
the script, not a broad pattern. Include a self-test proving the gate actually fires (a fixture it
scans and rejects, or a documented `probes/` entry consistent with how this repo self-verifies).

### 4. Wire the packages into the task surface

`tasks/Taskfile.test.yaml` and `tasks/Taskfile.compile.yaml`, plus the `bunfig.{unit,int,sit}.toml`
coverage ledgers, so each package's `src/lib/**` lands in the unit ledger and `src/adapters/**` in
the integration ledger, per `docs/standards/testing`. Keep the existing 100%-goal semantics.
Follow the Taskfile rules in `docs/standards/taskfile` (inline one-liners; logic in
`scripts/local/`; never call `scripts/ci/*` from a Taskfile).

`packages/pwa` is a browser bundle, not a compiled binary — do not add it to the binary compile
matrix. Only `packages/cli` (`fy`) compiles today; `packages/daemon` will add `fyd` in a later
unit, so leave a clear seam rather than pre-wiring it.

## Absolute rule about gates

**Do not weaken a gate to make it pass.** No blanket knip ignores, no `|| true`, no disabling
hooks, no loosening tsconfig strictness. If a gate genuinely must be scoped for an
intentionally-empty package, scope it as narrowly as possible and explain exactly why in the PR
description. A weakened gate is a rejected PR — these gates are the only thing standing between
this migration and 226k lines of unreviewable drift.

## Definition of done

1. `direnv exec . pre-commit run --all-files` — all hooks pass.
2. `direnv exec . task test` — unit + integration + SIT pass.
3. `direnv exec . nix develop .#releaser -c ./scripts/release/publish.sh --snapshot` — green.
4. `direnv exec . task check` and `direnv exec . task lint` — green.
5. Your new `no-legacy-state` gate demonstrably **fails** on a planted violation and passes once
   removed. Show this in the PR description.
6. The rename round-trip in §1 leaves a clean `git diff`.

## Deliver as a PR

Conventional commits, reviewable chunks. Then:

```bash
git push -u origin port/s1-workspace-gates
direnv exec . gh pr create --title "build(workspace): make the four packages real and add migration gates" --body "<see below>"
```

PR body must contain: what you changed and why; the exact gate commands you ran with their
results; proof the `no-legacy-state` gate fires; any gate you scoped and the precise justification;
and anything you found that contradicts the plan.

Do **not** merge. The lead reviews and merges.

## Report

Final message: the PR number and URL, the gate results, and any decision you had to make that the
plan did not cover. Keep it tight.
