---
id: contracts
title: Contracts
---

# Contracts

A contract is a repository invariant that is checked mechanically instead of remembered. They
live in `scripts/validate/` and run from pre-commit, so breaking one fails the commit that broke
it rather than the release three weeks later.

Contracts exist for facts that are true across several files at once — a name that must match in
five places, a plugin order that must not change, a checksum step that must not disappear. If an
invariant fits in one file, a type or a test is the better home for it.

## Validators

| Script                 | Runs as                                  | Enforces                                                |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `cli-contracts.sh`     | `a-cli-contracts`                        | the ten workspace/CLI/release contracts below           |
| `action-pins.sh`       | `a-action-pins-trusted`, `…-non-trusted` | GitHub Action pinning policy                            |
| `commit-msg.sh`        | `a-commit-msg` (`commit-msg` stage)      | conventional commit subjects                            |
| `executable-shells.sh` | `a-enforce-exec`                         | every tracked `*.sh` is executable                      |
| `no-legacy-state.sh`   | `a-no-legacy-state`                      | package code contains no legacy state identifiers/paths |

Hook wiring lives in `nix/pre-commit.nix` — see [Linting](../linting/index.md).

## Workspace, CLI, and release contracts

`scripts/validate/cli-contracts.sh <name>` runs one contract; `all` runs every one. Each derives
the PRODUCT name from the root `package.json` and the BINARY name from the CLI package's `bin`
key first, so the checks survive a rename ([Architecture](../architecture/index.md)).

| Contract                   | What it guarantees                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arch`                     | the CLI entry and terminal adapter exist, and every package's `src/lib/` contains no terminal IO (`console.*`, `process.*`, chalk/ora/cli-progress/inquirer) and no imports from `adapters/`                |
| `workspace-package-scopes` | every non-CLI workspace package is named `@<PRODUCT>/<directory>`; the load-bearing CLI name remains equal to its `bin` key                                                                                 |
| `name-single-source`       | the Taskfile and the compile/shim/smoke scripts derive the binary name from `bin`, and every static file that must spell a name out (GoReleaser, cask, `go.mod`, installer) agrees with its source of truth |
| `release-backup-order`     | the first `@semantic-release/exec` step is the changelog backup, and `@semantic-release/github` is absent                                                                                                   |
| `changelog-asset`          | `Changelog.old.md` is committed by the release commit and `publish.sh` passes `--release-notes ./IncrementalChangelog.md`                                                                                   |
| `release-artifacts`        | GoReleaser produces archives and a checksum file, and ships `install.sh` as a release extra file                                                                                                            |
| `homebrew-cask`            | the cask is named after the product, installs the binary, targets `Casks/` in this repository, and strips the macOS quarantine attribute post-install                                                       |
| `installer-checksum`       | `install.sh` downloads `checksums.txt` and verifies it (`sha256sum -c` / `shasum -a 256`) before installing                                                                                                 |
| `installer-timeouts`       | every `curl` in `scripts/release/` carries `--connect-timeout` and `--max-time`                                                                                                                             |
| `installation-parity`      | the archive naming, the installer, and `INSTALLATION.md` describe the same artifacts — docs cannot drift from what is published                                                                             |

Why these and not others: each one has a failure mode that is invisible locally and expensive
remotely. A missing checksum verification ships a silently corruptible installer; a renamed
binary with a stale cask produces a release that installs nothing; a reordered plugin chain
produces release notes containing the entire changelog.

## Action pinning

`config/action-trust.json` (`schemaVersion: 1`) classifies every action as `trusted` or
`non-trusted`. Trusted actions pin a major tag; everything else pins an exact 40-character SHA
with its tag as a trailing comment. The validator also fails on an action used but unclassified,
and on a classification for an action nobody uses any more — so the trust map cannot rot. Full
policy in [CI/CD](../ci-cd/index.md).

## Running them

```bash
./scripts/validate/cli-contracts.sh all          # every workspace/CLI/release contract
./scripts/validate/cli-contracts.sh homebrew-cask # one, while iterating
./scripts/validate/no-legacy-state.sh             # package migration boundary
./scripts/validate/action-pins.sh trusted
pre-commit run a-cli-contracts --all-files       # exactly as the gate runs it
```

`probes/` holds self-verification definitions that exercise several of these invariants
end-to-end; `./scripts/release/publish.sh --snapshot` is the offline acceptance test for the
release-facing ones ([Semantic Release](../semantic-release/index.md)).

## Adding a contract

1. Pick a name and add a `case` branch to the right validator — one contract, one name, one
   branch. Add the name to the `all` loop.
2. Derive identifiers (`jq -r '.name' package.json`, `jq -r '.bin | to_entries[0].key' …`);
   never hardcode a name inside a check.
3. Assert on parsed structure, not text, when the file is structured: `yq -o=json '.' <file> |
jq -e '…'`. Reserve `rg -qF` for genuinely unstructured files.
4. Fail with a `❌` message to stderr explaining what is wrong, and exit non-zero; finish with a
   `✅` line naming the contract. Follow
   [Shell Script Conventions](../shell-scripts/index.md).
5. Widen the hook's `files:` pattern in `nix/pre-commit.nix` if the contract reads files the
   pattern does not already cover — a contract that never runs is worse than none, because it
   reads as covered.
6. Prove it fails: break the invariant on purpose, watch the hook reject it, then restore.
