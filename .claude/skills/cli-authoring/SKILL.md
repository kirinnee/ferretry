---
name: cli-authoring
description: Doctrine for building and extending the CLI package — composition root shape, three-layer architecture, terminal ports, test tiers, and release machinery. Use when adding commands, adapters, or domain services to packages/cli, or when touching compile/release scripts.
---

# CLI authoring doctrine

Adapted from the diene `bun-cli` baseline. The CLI is a compiled Bun binary wired through
explicit dependency injection. These rules are load-bearing; deviations break tests, gates,
or the release pipeline.

## Identity is derived, never written

The `bin` key in `packages/cli/package.json` is the single source of the product name and the
entry path. Everything else derives it:

```bash
jq -r '.bin | to_entries[0].key' packages/cli/package.json    # binary name
jq -r '.bin | to_entries[0].value' packages/cli/package.json  # entry file
```

Never hardcode the name in scripts, Taskfiles, tests, or code. The few static files that must
carry it (GoReleaser config, cask, installer, docs) are rewritten by `scripts/local/rename.sh`.

## Composition root (`packages/cli/bin/<name>.ts`)

- `createProgram()` — commander skeleton only: name, description, `--version` (from
  package.json, semver-asserted), `--help`. Domain-free.
- `CliWorld` — the interface of adapters a CLI invocation needs. The SIT in-process driver
  injects captured doubles here; `buildWorld()` builds the production set.
- `registerDomain(program, world)` — the ONLY scaffold↔domain seam. One command = one
  controller class that takes its ports via constructor and returns/sets an exit code.
  Zod parses raw args at the controller boundary.
- `execute()` — build, wire, `parseAsync`, catch → stderr + exit 1, then run every cleanup in
  `finally`, each in its own try/catch so a cleanup failure never masks the command's result.
- `if (import.meta.main)` guards execution — tests import the factories without running the CLI.

## Three-layer architecture

- `src/lib/` — pure domain. NO console, NO `process.*`, NO chalk/ora/cli-progress/inquirer,
  NO imports from `adapters/`. Enforced by `scripts/validate/cli-contracts.sh arch`.
- `src/adapters/` — all IO. Terminal ports live here:
  `ICliIo` (success/warn/error/exit/interactive), `ISpinner` (ora), `IProgressBar`
  (cli-progress), `IPrompt` (inquirer), `IShellRunner` (Bun `$`).
  Never prompt off a TTY — check `world.interactive` first.
- `bin/` — the glue. Structural typing bridges scaffold ports to domain ports.

## Test tiers (bun:test, AAA comments, `should` assertions)

| Tier | Where                | Ledger (100% goal)            | Config             |
| ---- | -------------------- | ----------------------------- | ------------------ |
| unit | `tests/unit/`        | `src/lib/**` only             | `bunfig.unit.toml` |
| int  | `tests/integration/` | `src/adapters/**` only        | `bunfig.int.toml`  |
| SIT  | `tests/sit/`         | full system (in-process mode) | `bunfig.sit.toml`  |

SIT is dual-driver: `BinaryCliDriver` spawns the compiled binary (black box, the default);
`InProcessCliDriver` runs identical journeys through `createProgram()`/`registerDomain()` with
captured IO for the coverage ledger (`SIT_DRIVER=inprocess`). Every journey asserts on
`{code, out, err}` only.

## Release machinery

- `scripts/release/compile.sh` — `bun build --compile` for `bun-linux-x64-baseline`,
  `bun-linux-arm64`, `bun-darwin-arm64` (x64 uses -baseline so it runs under QEMU).
- GoReleaser v2 compiles a Go stub per target (`goreleaser.go`); the post-build hook
  `goreleaser-shim.sh` swaps the real Bun binary over the stub (the prebuilt builder is Pro-only).
- The Homebrew cask is committed into THIS repo under `Casks/` and strips the macOS quarantine
  attribute post-install (binaries are unsigned).
- `install.sh` (curl|bash) verifies checksums before installing; every curl carries
  `--connect-timeout` and `--max-time`.
- Versioning: plain semantic-release (conventional-commits preset). `@semantic-release/github`
  is FORBIDDEN — GoReleaser owns the GitHub release, triggered by the `v*.*.*` tag.
- The offline acceptance test for all of it: `./scripts/release/publish.sh --snapshot`.

## Quality gates

Biome lints (formatting is treefmt/prettier's job), strict no-emit TypeScript, knip twice
(repository view incl. tests; production view from the bin entry — it catches files used only
by tests). Shell scripts are shellcheck-clean, executable, and `set -euo pipefail`.
Run everything: `task lint`.
