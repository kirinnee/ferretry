---
id: linting
title: Linting
---

# Linting

Every repository gate is declared in `nix/pre-commit.nix` and runs in the nix environment, so
the same hooks and the same pinned tool versions run on a laptop and in CI.

## Commands

```bash
task lint                                        # local: every gate
pre-commit run --all-files                       # identical, one layer down
nix develop .#ci -c ./scripts/ci/pre-commit.sh   # exactly what CI runs
```

`task lint` is `pre-commit run --all-files`. The CI script adds dependency installation and
`--show-diff-on-failure`, so a formatting failure prints the patch instead of just a red X.

## Hook inventory

| Hook                        | What it enforces                                                           |
| --------------------------- | -------------------------------------------------------------------------- |
| `treefmt`                   | formatting: actionlint, nixfmt, prettier, shfmt                            |
| `a-biome`                   | Biome lint on TS/JS (formatting is prettier's job, not Biome's)            |
| `typecheck`                 | `tsc --noEmit` across the workspace                                        |
| `a-deadcode`                | Knip, repository view (`knip.json`) — includes tests                       |
| `a-deadcode-production`     | Knip, production view (`knip.production.json`) — from the bin entry        |
| `a-shellcheck`              | shellcheck on every `*.sh`                                                 |
| `a-enforce-exec`            | tracked shell scripts are executable                                       |
| `a-action-pins-trusted`     | trusted GitHub Actions pin a major tag                                     |
| `a-action-pins-non-trusted` | everything else pins a 40-char SHA plus its tag in a comment               |
| `a-cli-contracts`           | the release/architecture invariants in [Contracts](../contracts/README.md) |
| `a-no-legacy-state`         | package code cannot reference predecessor state or identifiers             |
| `a-commit-msg`              | conventional commit subject (`commit-msg` stage)                           |

Two Knip passes exist on purpose: the production view starts from the binary entry point and
therefore catches files that only tests reach, which the repository view considers used.

`prettier` skips `Changelog.md` and `Changelog.old.md` — semantic-release owns those files and
reformatting them would churn the release commit.

## Configuration rules

- Add custom hooks in `nix/pre-commit.nix` with an `a-` prefix. (`treefmt` and `typecheck` are
  the two hooks without it.)
- Use nix-provided tool paths or the repository's `validator` wrapper, which pins an explicit
  `PATH`. Hooks must never depend on a host-installed binary. JS/TS gates go through the
  `bun-tool` wrapper (`./node_modules/.bin/<tool>`), which requires `task setup` first.
- Give each independent enforcement mechanism its own hook, with a `files:` pattern narrow
  enough that unrelated commits do not pay for it.
- Policy enforcers are shell scripts under `scripts/validate/`, not inline nix strings — see
  [Contracts](../contracts/README.md) and [Shell Script Conventions](../shell-scripts/index.md).

## Diagnosing a failure

```bash
pre-commit run a-cli-contracts --all-files        # one hook, whole tree
pre-commit run a-shellcheck --files scripts/ci/test.sh
```

The `commit-msg` hook is not part of `--all-files`; drive it with the stage flags:

```bash
pre-commit run a-commit-msg --hook-stage commit-msg --commit-msg-filename .git/COMMIT_EDITMSG
```

> `pre-commit run` stashes unstaged changes for the duration of the run. Finish or stage
> in-flight edits before running it if anything else is writing to the tree.

## `.pre-commit-config.yaml` is generated

Nix writes `.pre-commit-config.yaml` from `nix/pre-commit.nix`, and it is gitignored. Never
edit it and never treat it as the source of configuration — the next `direnv reload` overwrites
it. The hooks are installed into `.git/hooks` by the devshell's `shellHook`
([Nix](../nix/index.md)).

Because the JS/TS hooks use the workspace's `node_modules` rather than a nix-built tooling
derivation, `nix flake check` cannot run them hermetically. `pre-commit run --all-files` inside
the devshell is the real gate.
