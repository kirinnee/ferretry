# Workspace agent guide

Use the repository's nix shell for every command (`direnv exec . <cmd>` or the loaded devshell).
This file is a pure index — the linked documents own their subjects.

## Non-negotiable invariants

- **Name single-sourcing (two-name model)**: the PRODUCT name (`ferretry`) is the root
  `package.json` `name`; the BINARY name (`fy`) is the `bin` key in `packages/cli/package.json`.
  Scripts, Taskfiles, and tests derive the binary name (`jq -r '.bin | to_entries[0].key'`).
  Renames go through `scripts/local/rename.sh --product <name> | --bin <name>` — never
  hand-sprinkle either name. See [Architecture](docs/standards/architecture/index.md).
- **No `@semantic-release/github`**: GoReleaser owns the GitHub release (`cd.yaml` on the `v*.*.*` tag).
  See [Semantic Release](docs/standards/semantic-release/index.md).
- **The Homebrew cask is committed into this repo** under `Casks/` — there is no separate tap repo.

## Engineering doctrine

`docs/standards/` is the living doctrine — keep it current as decisions are made.

| Subject                                                                          | Owns                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------- |
| [Software Design Philosophy](docs/standards/software-design-philosophy/index.md) | Why every other rule exists — start here            |
| [SOLID Principles](docs/standards/solid-principles/index.md)                     | Dependency management, coupling, cohesion           |
| [Functional Practices](docs/standards/functional-practices/index.md)             | Immutability, pure/total functions, railway results |
| [Domain-Driven Design](docs/standards/domain-driven-design/index.md)             | Ubiquitous language, domain modelling               |
| [Three-Layer Architecture](docs/standards/three-layer-architecture/index.md)     | `src/lib` / `src/adapters` / `bin` seams and ports  |
| [Stateless OOP with DI](docs/standards/stateless-oop-di/index.md)                | Constructor injection, no hidden state              |
| [Architecture](docs/standards/architecture/index.md)                             | Two-name model, package layout, repo-wide machinery |
| [Fact Ownership](docs/standards/fact-ownership/index.md)                         | One fact, one owner, when two programs must agree   |
| [Validation](docs/standards/validation/index.md)                                 | Parse-don't-validate at boundaries (zod)            |
| [Datetime](docs/standards/datetime/index.md)                                     | Instants, timezones, durations                      |
| [Utilities](docs/standards/utilities/index.md)                                   | Shared helpers and what belongs in one              |
| [Testing](docs/standards/testing/index.md)                                       | Unit / integration / SIT tiers and coverage ledgers |
| [Contracts](docs/standards/contracts/README.md)                                  | The `scripts/validate/` repo invariants             |
| [Linting](docs/standards/linting/index.md)                                       | Generated pre-commit gates                          |
| [Nix](docs/standards/nix/index.md)                                               | Flake, devshells, pinned toolchain                  |
| [Taskfile](docs/standards/taskfile/index.md)                                     | Task surface and authoring rules                    |
| [Shell Scripts](docs/standards/shell-scripts/index.md)                           | Script conventions and safety                       |
| [CI/CD](docs/standards/ci-cd/index.md)                                           | Workflows, jobs, action pinning                     |
| [Conventional Commits](docs/standards/conventional-commits/index.md)             | Commit grammar and the commit-msg gate              |
| [Semantic Release](docs/standards/semantic-release/index.md)                     | Versioning and the release pipeline                 |
| [Contributor Docs](docs/standards/contributor-docs/index.md)                     | How to write documentation in this repo             |

Parked subjects (deliberately stubbed, read before reviving):
[Docker](docs/standards/docker/index.md) · [Authorization](docs/standards/authorization/index.md).

## CLI authoring

See [.claude/skills/cli-authoring/SKILL.md](.claude/skills/cli-authoring/SKILL.md) — composition
root shape, three-layer architecture, terminal ports, test tiers, and release machinery doctrine.

## Task surface

See [Taskfile.yaml](Taskfile.yaml) (`task --list`). Tests: `task test` (unit + int + SIT);
coverage variants `task test:coverage`.

## Releasing

See [README.md](README.md#releasing) and [INSTALLATION.md](INSTALLATION.md).
Repo invariants live in [scripts/validate/](scripts/validate/) and run from pre-commit.

## Layout

Bun workspaces monorepo — see [README.md](README.md#layout). Only `packages/cli` is real at P0;
`protocol`, `daemon`, `fleet`, and `pwa` are placeholders for the P1 lift.

`packages/relay` owns how a browser reaches a daemon: the end-to-end session protocol and the
Cloudflare rendezvous that can carry it. The wire contract is
[docs/relay-protocol.md](docs/relay-protocol.md) — implement against that document, not the code.
The carrier contract has no chooser: direct is attempted first, and Ferretry's hosted relay is the
automatic fallback. No **carrier** address is compiled in: each build carries only the
**discovery origin** it reads the advertisement from — a service address, never a user's — while the
relay endpoint and the daemon URL are runtime values. The hosted default therefore comes from a
no-store runtime advertisement whose operator can change or disable it without a release.
**Both ends discover it** from `HOSTED_RELAY_DIRECTORY_ORIGIN` in `@ferretry/relay`, compiled into
the PWA and daemon on every build route. It is temporarily Ferretry's personal `workers.dev`
subdomain; moving to a product domain changes that single source fact. Forks consequently discover
Ferretry's hosted directory too — an accepted owner trade-off until that move. A daemon that read
no advertisement was reachable from nothing but its own host, which is why
`scripts/validate/relay-config.sh` pins that source chain. An explicit `relay` block in
`config/daemon.json` **wins and is never overwritten**, `enabled: false` included, and every failure
to discover fails closed to direct-only with the consequence and the remedy said out loud.
Running your own relay stays supported as an **expert opt-in path** with its own runbook,
[docs/cloudflare-relay-self-hosting.md](docs/cloudflare-relay-self-hosting.md), and its fingerprint
allowlist remains independent of the hosted deployment. The PWA's interim three-way carrier chooser
and self-hosting route are still there and removing them is still an explicit GAP. **First contact
is no longer direct-only.** A relay session commits to one of three modes with its first sealed
record (protocol §14): a request session, one live event or terminal stream, or a one-attempt
`pair` — sent only after the daemon is proved against the QR-pinned fingerprint, never as an
anonymous routed request, with its own relay guess budget so an internet stranger cannot expire a
code a LAN device could still redeem. **The QR stays the ordinary one-version `v1` fragment** — daemon
address, code, fingerprint, no rendezvous — because the scanning device reads the SAME hosted
directory advertisement the daemon read and finds the fallback itself, so **a device that can never
reach the daemon's address pairs anyway** and then reconnects as an ordinary authenticated session.
The mint's `discoveredRelayUrl` is host-facing only: it exists so `fy pair`, Add Device and
`fyd --check` know a loopback daemon is redeemable and what to disclose, and it is derived from relay
provenance so a self-hosted rendezvous yields nothing. That is a **declared GAP** — a fresh device
cannot discover a self-hosted rendezvous, and naming one in the link is deferred, not promised. All
three modes are built on both ends; read §14 for the state machine and §13 for what is still
outstanding around it rather than restating either here.

`packages/fleet` gives a fleet **one default set of instructions, skills and base settings** that
every account uses, with a per-account switch between that shared document and the account's own copy.
The contract is [docs/fleet-sharing.md](docs/fleet-sharing.md). Sharing was always expressible — two
accounts referencing one path in the asset tree each get a copy of it — so what this adds is a
**declaration and a report**, not a second mechanism: `config.shared` names documents, the sharing
report says per account and per field whether the effective value is a declared shared one or its own
and which slot supplied it, and `link` / `unlink` are reviewed mutations like any other. **`skills` is
per ITEM, not one directory**: the store registers one entry per skill, an account's `skills` is the
LIST it selected, a later slot replaces that whole list, and each item lands under its own name at
`<home>/skills/<item>` — so two accounts can overlap on some items and not others, and an item dropped
from a selection is removed from the home rather than left behind. **Unlink
materialises a private copy** rather than leaving an account with nothing, and never touches the shared
document. **Identity and auth are never shared**, enforced by the schema rather than by convention:
everything shareable is a `Profile` field, and an account's identity and provider login are
`AccountRoute` / `Agent` fields that no strict profile can express. This is deliberately **not** the
`shared-history.ts` pool — every asset path is a destination the fleet plan writes on every apply,
which is the exact opposite of the pool's "the harness owns this and Ferretry never writes it", and
pooling one would give a single inode two owners. Migration is therefore a declaration and moves
nothing. `settings` is reported but not linkable, and a directory asset cannot be privately
materialised; the doc names each remaining limit.

`packages/pwa` reads every reference — `:agent`, `@file`, `&task`, `!attention`, `/skill` or
`$skill`, `%terminal:<key>`, `%browser:<key>` — through one grammar, one proof-before-link gate, one
renderer and one click behaviour. The authoring and implementation contract is
[docs/reference-standard.md](docs/reference-standard.md) — implement against that document, and
extend the grammar there rather than adding a second one.

A fenced `fy-render` block renders an illustration inline in an assistant's own transcript message,
and **no author-supplied code executes** — `svg` and `image` become an `<img>`; `mermaid` and
`lottie` are handed as **data** to a trusted library inside an opaque-origin sandbox frame, which is
a narrower claim than "author code is sandboxed" and the difference is the point. A compiled Mermaid
diagram returns as SVG text and re-enters through that same measured `<img>` sink; Lottie stays live
because an animation must. `html` is still shown as escaped source with the limitation stated on
screen, because no browser-only boundary for executing author JavaScript survived measurement — so
**handover row 65 stays open**. The frame is denied every ordinary **subresource** — which is not the
same as having no network, since self-navigation, prerender and WebRTC egress were all measured from
that frame shape and remain a declared residual: the parent fetches the one pinned library and
transfers the bytes over a capability port, and the shell's `script-src` lists nothing but build-time
hashes, so author bytes cannot become code. The watchdogs bound
**wall-clock lifetime only**, never CPU or memory. Chromium evidence is not Safari evidence, and a
real `macos-15` `safaridriver` job is a release gate. The grammar, the measured `<img>` result and
its scope, and the declared gaps are [docs/fy-render.md](docs/fy-render.md). It is
**conversation-only**: a fence opener in any durable file fails
`scripts/validate/no-fy-render-in-docs.sh`.

`packages/daemon` owns a secret store whose contract is **use, never read**: an agent names a secret
and Ferretry runs a command with the value in _that child's_ environment, so the agent never holds a
credential. **No route, command or API returns a secret value** — that is enforced by the types, and
adding a getter would delete the feature. The threat model, the `${secret:NAME}` grammar and the
declared GAPs are [docs/secrets.md](docs/secrets.md); read it before describing what this protects
against, because the useful property is narrower than people assume.

`packages/daemon` locates the harness commands (`claude`, `codex`) through **one** rule an operator can
change: an explicit per-harness path, then declared search directories, then the inherited
environment — the contract is [docs/harness-paths.md](docs/harness-paths.md). It exists because a
daemon started by systemd or launchd inherits a minimal environment, so a harness that works in the
operator's terminal is invisible to their daemon. **Both surfaces exist deliberately** — a `harness`
block in `config/daemon.json` and `FY_CLAUDE_BIN` / `FY_CODEX_BIN` / `FY_HARNESS_PATH`, the
environment winning per harness — because a unit file cannot edit a JSON document. **A named path
that resolves to nothing fails loudly and searches no further**, since a silent fallback leaves an
operator believing they configured something they did not. Boot, `fyd --check` and the doctor report
each name the resolved path AND the rule that produced it, and **nothing is ever launched to find
out**. It is discovery only: a start still launches the absolute wrapper the manifest publishes.

`packages/daemon` also decides **what a caller who is NOT on this host may do**, per capability
(`fleet`, `terminal`, `browser`, `filesystem`, `warden`, `pairing`) and per axis (_use_ / _configure_). **A
loopback caller is ungoverned** — somebody at the machine already has the machine — and "loopback"
means how the request ARRIVED, decided from the carrier: the relay terminates on the host it serves,
so any check reading a peer address, a `Host` header or a URL would hand a remote phone full control.
Defaults are permissive and the **operator password** is the opt-in layer; a grant can only ever
narrow what a credential could already do, and an undetermined document fails closed. The contract,
the widen/narrow asymmetry and the declared GAPs are [docs/grants.md](docs/grants.md).

How another device GETS that access is [docs/pairing.md](docs/pairing.md): a two-minute single-use code,
a device token the daemon keeps only a hash of, and revocation of either. **No route returns a device
token or a digest** — the wire projection has no field for one — and a **pairing code is a live
credential**, so its QR is generated locally and never by an image service, never announced to a screen
reader, never persisted, and never screenshotted for real (committed captures use a fixed fake code).
Minting is governed by the `pairing` capability rather than by an admin-token minimum, because a browser is
always a paired device and could otherwise never add a second one.

The fleet's **New account** form fills itself in from what the host already knows, and the contract for
that is [docs/harness-discovery.md](docs/harness-discovery.md). `GET /v1/fleet/harnesses` surfaces the
`PATH` lookup the boot preflight has always done — the **same** resolver, never a second detector — plus
the model each harness declares in its own settings file and the `CLAUDE.md`/`AGENTS.md` that host already
has. Two rules make prefilling safe: **a prefilled value carries the file it came from or it is not
sent** (a fallback says so and is the fleet package's own starter model, never an invented one), and
**every prefilled field stays editable, losing its provenance note the moment somebody types over it**.
A host with no harness on `PATH` is a warning and never a refusal, exactly as at boot. Nothing here
writes: the form hands off to the existing review-and-authorize step at one call.

## Migration context

Mission and phase order: [docs/PROMPT.md](docs/PROMPT.md). Architecture, pairing, and security
design: [docs/design/split-proposal.md](docs/design/split-proposal.md). Feature backlog:
[handover.md](handover.md).

## Migration state

Resuming or continuing the kteam→Ferretry migration (including on a new machine):
[docs/migration/START-HERE.md](docs/migration/START-HERE.md) — the single entry point: bootstrap,
work order, and cleanup. State and the `port/*` branch map are in `docs/migration/HANDOFF.md`; unit briefs in `docs/migration/units/`, source
surveys in `docs/migration/surveys/`.
