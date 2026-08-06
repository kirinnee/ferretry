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

This page is the list of gates. The rule they enforce — where a fact two programs must agree on is
allowed to be defined, and why a second definition fails silently — is
[Fact Ownership](../fact-ownership/index.md). Read that first when deciding whether a new invariant
deserves a contract at all.

`conflict-markers.sh` is the one that is about EVERY file rather than a relationship between several,
and it earns its place for the reason above turned inside out: no type and no test can own it, because
the artefact it refuses is not code. `docs/grants.md` reached `main` carrying three markers behind
eleven green checks — one of them rewritten by treefmt into valid Markdown, so the formatter had
laundered a defect into something every gate was right to pass.

## Validators

| Script                        | Runs as                                  | Enforces                                                          |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `action-pins.sh`              | `a-action-pins-trusted`, `…-non-trusted` | GitHub Action pinning policy                                      |
| `cli-contracts.sh`            | `a-cli-contracts`                        | the 19 workspace/CLI/release contracts below                      |
| `closed-set-agreement.sh`     | `a-closed-set-agreement`                 | copied cross-package closed sets have identical members           |
| `commit-msg.sh`               | `a-commit-msg` (`commit-msg` stage)      | conventional commit subjects                                      |
| `composition-invocation.sh`   | `a-composition-invocation`               | every constructed composition-root field has a caller             |
| `composition-reachability.sh` | `a-composition-reachability`             | production modules are used by their composition root             |
| `conflict-markers.sh`         | `a-conflict-markers`                     | marker shapes occur only in explicitly declared teaching docs     |
| `contract-registry.sh`        | `a-contract-registry`                    | executable, documented and wired contract inventories agree       |
| `daemon-scope.sh`             | `a-daemon-scope`                         | no PWA surface can read one daemon's data as another's            |
| `executable-shells.sh`        | `a-enforce-exec`                         | every tracked `*.sh` is executable                                |
| `fetch-binding.sh`            | `a-fetch-binding`                        | no unbound `fetch` builtin is used as a value in the PWA          |
| `no-fy-render-in-docs.sh`     | `a-no-fy-render-in-docs`                 | `fy-render` fence openers appear only in their two teaching files |
| `no-legacy-state.sh`          | `a-no-legacy-state`                      | package code contains no legacy state identifiers/paths           |
| `pages-config.sh`             | `task test:gate`                         | the PWA build and Pages deployment publish the same directory     |
| `relay-config.sh`             | `a-relay-config`, `task test:gate`       | relay code, bindings, discovery and deployment agree              |
| `route-agreement.sh`          | `a-route-agreement`                      | client/daemon paths, verbs and declared method debt agree         |
| `typecheck.sh`                | `typecheck`                              | every workspace package participates in the TypeScript build      |

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
| `daemon-default-address`   | the protocol owns the default daemon address and every production consumer derives it instead of copying the port literal                                                                                   |
| `loopback-single-source`   | the protocol owns host-spelling and peer-address loopback decisions, and each production consumer uses the decision for its input domain                                                                    |
| `pairing-fragment-readers` | the fragment version the daemon mints is accepted by the CLI that renders it and carries no rendezvous, and neither the CLI nor the PWA tests a version prefix of its own                                   |
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
| `release-daemon`           | every release archive, system package, cask and normal installer carries both independently declared executables                                                                                            |
| `released-version`         | `VERSION`, both shipped package manifests, the bump script and release assets stamp the same released version                                                                                               |
| `nix-packages`             | the Nix default package and flake check build the joined CLI-and-daemon release bundle                                                                                                                      |

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

## Conflict-marker declarations

`conflict-markers.sh` scans every tracked file for all raw, Markdown-laundered, and setext marker
shapes. There are two populations: damaged files and documents that must show the damage accurately.
The latter declare one exact repo-relative path and a file-specific reason in
`conflict-markers-allowlist.txt`; globs, directories, duplicate paths, and missing reasons are probe
errors. Rewording or misspelling a marker to evade the scan is not an exemption.

The file set is `git ls-files`, one tracked path is one file unit, and one matching line is one finding
unit. The declared list currently includes the validator that defines the patterns and the pending
design document that specifies the gate; every other match is an unresolved conflict and fails.

## Contract registry

`contract-registry.sh` fails when a contract exists in one inventory and not the others. Before this
gate, `cli-contracts.sh all` executed eighteen names while this document listed thirteen, and four
top-level validator scripts had no row at all. Each surface was valid on its own, which is why none of
the contracts it described could report the disagreement.

It compares each registry in both directions and checks the human-facing numeric count:

| Set                 | File set                                                                                 | Extraction pattern                                                                                        | Unit                   |
| ------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| CLI contracts       | `scripts/validate/cli-contracts.sh` and the Workspace/CLI/release table in this document | `cli-contracts.sh list`, column-zero case arms, first backticked table cells, and the numeric prose count | one contract name      |
| validator inventory | top-level `scripts/validate/*.sh` and the Validators table above                         | top-level shell basenames and first backticked cells                                                      | one script basename    |
| execution wiring    | `nix/pre-commit.nix` plus `scripts/ci/test.sh`                                           | `scripts/validate/<name>.sh` command paths                                                                | one wired script path  |
| hook inventory      | hook attributes in `nix/pre-commit.nix` and the Linting standard's inventory table       | four-space Nix attributes and first backticked cells                                                      | one pre-commit hook id |

Tracked and untracked non-ignored validator scripts are included, so a new gate is visible before its
first commit. A zero-sized extraction is a broken probe and exits `2`; it is never reported as an empty
registry in compliance. A repeated contract, documentation row, or hook id also exits `2` before set
comparison; deduplicating the extraction must never hide a copied registry member.

## Closed-set agreement

`closed-set-agreement.sh` fails when either side of a registered cross-package enumeration gains or
loses a member. The live capability case is subtle: `DAEMON_CAPABILITIES` and the explicit keys in
`CapabilityGrantsDocumentSchema` agree today, but adding a protocol member alone still compiles.
Likewise, `satisfies readonly PushNotificationKind[]` prevents a wrong notification kind without
proving the PWA list contains every protocol kind. Soundness is not completeness.

The file set is five exact production files: `protocol/src/lib/grants.ts`,
`daemon/src/lib/runtime/config.ts`, `protocol/src/lib/push.ts`,
`pwa/src/lib/notification-preferences.ts`, and
`pwa/src/features/settings/notification-settings.tsx`. One structurally parsed member or key is one
unit. The parser exhaustively walks the named string arrays and the grants object's exact
`<key>: grantSchemaFor('<member>')` entries; unsupported expressions, skipped entries, ambiguous
declarations, empty parses, duplicate members, and a grants key naming another capability all exit
`2` instead of under-matching into a green result.

This is temporary detection, not permission to keep duplicate lists. The approved design's §4.6
prefers no capability-enumeration gate, and Wave 2a replaces these pairs with compiler-exhaustive
derivation. The explicit Wave A brief requires the detector until that move, when this gate, hook and
registry should be deleted rather than preserved as permanent architecture.

## Route agreement

`route-agreement.sh` fails in three directions: when a production client dials a path or verb the
daemon does not serve (`unserved`), when the daemon declares a route no production client reaches
(`unreached`), or when a route is reached only by dials whose verb cannot be read
(`verb-unproven`). The third direction declares the route's served verb, so changing that method makes
the old declaration stale and the new target undeclared rather than silently continuing to agree.

This is a lexical TypeScript pass, not a grep. Its primary route file set is every `*.ts`/`*.tsx` file
below `packages/daemon/src/lib/runtime/mounts` and `packages/daemon/src/lib/api/routes`; a containment
pass also scans all other daemon `{src,bin}` production TypeScript and exits `2` if a route-shaped
object moved outside those declared directories. Its observation set is every other workspace
package's `{src,bin}` production TypeScript. Tests are excluded because fixtures are not wires, and
`cli`, `protocol`, and `pwa` must each produce at least one dial or the probe fails as vacuous.

A route unit is one literal `{ method, path }` declaration with a statically named route handler. A
client unit is one resolved path observation at a served first-segment prefix, classified as a dial
when an enclosing call yields a verb and as a mention when code constructs the address. One source
expression may produce several units through call-site parameter specialization or returned switch-arm
specialization. Only dials satisfy route agreement; a constant or helper that merely names a path never
makes a route read as live. Comments, regex bodies and string bodies are blanked before structure is
read, constants and template interpolations are resolved, and every empty, opaque, or structurally
unreadable probe exits `2` instead of under-matching into a green result. The success line prints a
per-package breakdown so a suspiciously clean aggregate cannot hide a dropped package.

The initial route allowlist was seeded from `main` at `00b733d0` with 32 lines, then remeasured after
strict matching replaced two absorbing wildcards and unreadable verbs became explicit debt. The landing
baseline is 52 exact lines: 23 `unserved`, 13 `unreached`, and 16 `verb-unproven`. That increase exposes
previously hidden units rather than relaxing the rule; the allowlist header records the full arithmetic.
Each exact `<direction> <verb> <path>` entry has a reason, a new target fails, and a stale entry fails,
so this final baseline can only shrink as the reviewed drift is fixed.

### What route agreement cannot prove

**Route agreement proves that the two ends of a call agree. It cannot prove the client is capable of
making it.** `packages/pwa` has no service worker, so even live push routes would not make
`pushManager.subscribe` reachable in a real browser. A green route gate therefore does not mean the
feature works; it says only that the addresses and verbs inside the gate's observation set agree.
Runtime prerequisites, composition reachability, permissions, and transport availability need their
own proof.

That observation set begins at a first path segment the daemon already serves. A dial in an entirely
new namespace such as `/push/...` or `/v2/...`, or a literal-host URL whose path is not recognized at
a segment boundary, is outside the set rather than an `unserved` finding. The gate catches the shipped
`/v1/push/...` defect because `/v1` is served; a green run cannot rule out the same defect under a new
top-level prefix.

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
./scripts/validate/no-fy-render-in-docs.sh        # illustrations stay in conversation, out of durable files
./scripts/validate/closed-set-agreement.sh        # copied cross-package enumerations still agree
./scripts/validate/contract-registry.sh           # every contract is documented and wired
./scripts/validate/route-agreement.sh             # paths, verbs and declared method debt agree
./scripts/validate/action-pins.sh trusted
pre-commit run a-cli-contracts --all-files       # exactly as the gate runs it
```

`./scripts/release/publish.sh --snapshot` is the offline acceptance test for the release-facing
invariants ([Semantic Release](../semantic-release/index.md)). A contract proves itself the same way
any other code does: verify it **fires** on a deliberately planted violation, not merely that it
passes on a clean tree — a gate that never fails is indistinguishable from one that does nothing.

## Adding a contract

1. Pick a name and add a `case` branch to the right validator — one contract, one name, one
   branch. Add the name to the dispatcher's single registry; `contract-registry.sh` will require the
   matching documentation and execution wiring.
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
