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

| Script                        | Runs as                                  | Enforces                                                 |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `cli-contracts.sh`            | `a-cli-contracts`                        | the ten workspace/CLI/release contracts below            |
| `action-pins.sh`              | `a-action-pins-trusted`, `…-non-trusted` | GitHub Action pinning policy                             |
| `commit-msg.sh`               | `a-commit-msg` (`commit-msg` stage)      | conventional commit subjects                             |
| `executable-shells.sh`        | `a-enforce-exec`                         | every tracked `*.sh` is executable                       |
| `no-legacy-state.sh`          | `a-no-legacy-state`                      | package code contains no legacy state identifiers/paths  |
| `composition-reachability.sh` | `a-composition-reachability`             | production modules are used by their composition root    |
| `daemon-scope.sh`             | `a-daemon-scope`                         | no PWA surface can read one daemon's data as another's   |
| `fetch-binding.sh`            | `a-fetch-binding`                        | no unbound `fetch` builtin is used as a value in the PWA |

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
| `state-home-log-directory` | the CLI and the daemon name the same `<state home>/logs` directory, and the daemon both requires it and admits it to its bootstrap shape                                                                    |
| `state-home-layout-claim`  | the layout decision, marker filename, bytes and mode live only in `@ferretry/protocol`; every CLI path that creates state in the home claims it first, and the daemon's refusal names a repair that exists  |
| `state-home-default`       | the daemon and the CLI's two resolvers all derive the default state home from the product name, so a `rename.sh --product` cannot point them at two different directories                                   |
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
produces release notes containing the entire changelog. The three `state-home-*` contracts are here
for a fourth reason: the CLI and the daemon are separate packages with no dependency between them, so
an artefact one creates and the other classifies has no compiler and no test that a single package
could own — and when they disagreed, no fresh machine could start the daemon at all.

That disagreement has now shipped three times, in the same shape each time. `logs/` was the first:
the CLI created it, the daemon read its own log directory as somebody else's data, and no clean
machine could boot. The daemon's own `start()` was the second, writing configuration into a home it
had not yet claimed and then refusing at its own next step. `fy fleet init` was the third, and the
worst: a provisioned fleet in an unclaimed home was refused **permanently**, so the only move the
shipped product left an owner was to delete the installation they had just set up.

Every one of them passed its own tests, because each writer owned its own fixture — which is why
`state-home-layout-claim` pins the shared decision itself rather than only the version literal. A
client applying its own weaker rule could adopt a genuinely foreign directory, and that would trade
one silent failure for a worse one. `state-home-default` is the same class caught before it shipped:
three functions derived `~/.ferretry`, two of them from a literal, agreeing only because the product
happens to be named that — and `rename.sh` rewrites package scopes but not `.ts` literals, so the
sanctioned rename would have split one installation in two.

## Composition-root reachability

`composition-reachability.sh` fails when a production module under `packages/*/src/**` is never
_used_ by its package's composition root — `packages/cli/bin/fy.ts`, `packages/daemon/bin/fyd.ts`,
or, for a package with no binary, the entries in its `exports` map.

It exists because the same defect appeared in three unrelated reviews: a unit builds a subsystem,
tests it to 100%, and never constructs it in the composition root. The daemon boots without it, so
the capability does not exist in the product while every gate stays green. Two mechanisms hide it:

- **Tests launder production code.** `knip.json` lists the test globs as entry points, so a module
  only its own tests import counts as reachable. This walk never enters `tests/` at all.
- **Barrels launder production code.** `export * from './x.ts'` makes `x` load at runtime, so
  file-level analysis — including `knip.production.json` — reports it used even when nothing asks
  for a single one of its symbols. This walk is symbol-aware: a re-export edge is followed only for
  the names an importer actually demands, so a barrel line is not a mounting.

The walk itself lives in `composition-reachability.ts`, because a real module graph needs resolved
specifiers and named-import tracking rather than text matching. It parses lexically — comments and
string literals are removed before any statement is read — and carries two tripwires that exit `2`
instead of under-reporting: every import Bun's own transpiler sees must be one the walker also saw,
and a demanded name that no module exports is a parser bug, not a silent miss.

`reachability-allowlist.txt` enumerates the modules that are unreachable today, one exact path per
line with a reason naming the PR that must wire it. Globs, wildcards, and directory entries are
rejected, so silencing a new violation always costs a reviewable line in the diff; a stale entry —
one that has since become reachable — is a hard failure, so the list can only shrink. The gate
prints its size on success to keep growth visible.

## Composition-root invocation

`composition-invocation.sh` fails when a world field on `DaemonWorld` or `CliWorld` is declared,
populated in the world literal, and read by nothing.

It is the OTHER half of the defect above, and the reachability walk is structurally blind to it: a
module the composition root imports and constructs IS reached, so it stays off the allowlist at 100%
coverage while nothing ever calls it. `SessionResumeService` sat that way through four wiring units —
`createSessionResume` was a world field nothing invoked, so `POST /v1/sessions/:id/resume` answered
`unknown_route` — and wiring it surfaced three defects no unit test had reached.

The rule is a count, not a graph: a field mentioned twice in the composition root is a declaration
and an assignment, which is nothing calling it. A third mention, or any mention in the package's own
`src/`, is a genuine read. **Comments are stripped before counting**, in the root and in every
candidate file, because this composition root is documented as densely as it is written — the first
unit to run the gate silenced it by accident with a comment explaining why a field had no caller.

Two shapes resolve a report, and neither is a suppression list: wire the field into a real caller, or
delete it when a live wiring already exists elsewhere. There is deliberately no allowlist — a field
that cannot be resolved either way is a decision for a human, and the gate holds the commit until
somebody makes it.

## Daemon scoping

`daemon-scope.sh` fails when a PWA surface could read one daemon's data as another's.

One browser can be paired to several daemons at once, and a daemon's ids — session, task, pin,
board — are unique only WITHIN the daemon that minted them. Two daemons therefore routinely hand the
same browser the same id for different things, so anything the bundle remembers about daemon-owned
data has to be keyed by `(daemonId, …)`.

That has been carried by hand for the whole migration. Every unit brief repeats it,
`docs/migration/surveys/pwa-shape.md` lists 56 single-daemon assumptions with `file:line`, and
surfaces were still being found by eye afterwards. An invariant that depends on every author
remembering it is not an invariant, which is the same reason `name-single-source` and the
`state-home-*` contracts exist.

Three passes, each catching a different way a surface goes unscoped:

| Pass         | Fails when                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retain`     | module-scope mutable state remembers daemon data without keying through `daemonSessionKey()`                                                        |
| `access`     | a module opens a request or a socket without carrying a `DaemonConnection` — the only type that pairs an origin with the device token minted for it |
| `invalidate` | a class declares `clearDaemon()` — i.e. declares itself daemon-scoped — and the connection registry never receives it                               |

`invalidate` is the one that found a live defect. `DaemonDraftStore` was a module default inside
`composer.tsx`, which made it the only daemon-scoped store in the bundle the registry could not
reach: `clearDaemon` existed, was tested, and was called by nothing. Unpairing left that daemon's
drafts in `localStorage` under `fy-drafts-v1`, where the next pairing to mint the same daemon id
would read them back — and minting the same id is exactly what a RE-pair does.

**Why it is not a grep for `daemonId`.** That has been tried in this repo and it fails open: a file
that only MENTIONS the name in a comment passes. Every pattern here is matched against cleaned
source — comments blanked and string bodies emptied first, line numbers preserved so a report is
still a coordinate — and each pass asks a structural question (what is this map keyed BY, does this
class reach the registry) rather than a lexical one.

**It fails closed about itself.** When a container escapes into a function the pass cannot follow,
it demands an allowlist line rather than assuming the benign reading. It also refuses to report a
vacuous pass: no PWA sources, no cache registry, or a registry holding nothing exits `2`.

`daemon-scope-allowlist.txt` carries the reviewed exceptions, one exact `<pass> <target> # <reason>`
per line — no globs, so silencing a new finding always costs a reviewable line in the diff, and a
stale entry is a hard failure. Only two shapes of reason are acceptable: the value is **not daemon
data**, or a named **owner** forwards `clearDaemon` to it. "It is keyed by daemon so staleness is
harmless" is not one of them — daemon ids are durable across a re-pair.

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
./scripts/validate/composition-reachability.sh    # production code is actually mounted
./scripts/validate/composition-invocation.sh      # every world field has a caller
./scripts/validate/daemon-scope.sh                # no PWA surface reads another daemon's data
./scripts/validate/fetch-binding.sh               # no stored fetch builtin can throw "Illegal invocation"
./scripts/validate/action-pins.sh trusted
pre-commit run a-cli-contracts --all-files       # exactly as the gate runs it
```

`./scripts/release/publish.sh --snapshot` is the offline acceptance test for the release-facing
invariants ([Semantic Release](../semantic-release/index.md)). A contract proves itself the same way
any other code does: verify it **fires** on a deliberately planted violation, not merely that it
passes on a clean tree — a gate that never fails is indistinguishable from one that does nothing.

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
