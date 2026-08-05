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
**Both ends discover it**: the PWA from its build-time `FY_RELAY_DIRECTORY_ORIGIN`, the daemon from
`__FY_RELAY_DIRECTORY__` — the same value, resolved by the same
`scripts/ci/relay-directory-origin.sh`, because a session crosses a relay only if both ends are on
it. A daemon that read no advertisement was reachable from nothing but its own host, which is why
`scripts/validate/relay-config.sh` pins that release chain. An explicit `relay` block in
`config/daemon.json` **wins and is never overwritten**, `enabled: false` included, and every failure
to discover fails closed to direct-only with the consequence and the remedy said out loud.
Running your own relay stays supported as an **expert opt-in path** with its own runbook,
[docs/cloudflare-relay-self-hosting.md](docs/cloudflare-relay-self-hosting.md), and its fingerprint
allowlist remains independent of the hosted deployment. The PWA's interim three-way carrier chooser
and self-hosting route are still there and removing them is still an explicit GAP, and **pairing
itself can never be relayed** — a relayed session is opened with the device grant the pairing
exchange has not issued yet, so first contact with a daemon is always direct. Protocol
§13 names each remaining piece and its state.

`packages/pwa` reads every reference — `:agent`, `@file`, `&task`, `!attention`, `/skill` or
`$skill`, `%terminal:<key>`, `%browser:<key>` — through one grammar, one proof-before-link gate, one
renderer and one click behaviour. The authoring and implementation contract is
[docs/reference-standard.md](docs/reference-standard.md) — implement against that document, and
extend the grammar there rather than adding a second one.

`packages/daemon` owns a secret store whose contract is **use, never read**: an agent names a secret
and Ferretry runs a command with the value in _that child's_ environment, so the agent never holds a
credential. **No route, command or API returns a secret value** — that is enforced by the types, and
adding a getter would delete the feature. The threat model, the `${secret:NAME}` grammar and the
declared GAPs are [docs/secrets.md](docs/secrets.md); read it before describing what this protects
against, because the useful property is narrower than people assume.

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
Minting is governed by the `pairing` capability rather than by the `host` scope, because a browser is
always a paired device and could otherwise never add a second one.

## Migration context

Mission and phase order: [docs/PROMPT.md](docs/PROMPT.md). Architecture, pairing, and security
design: [docs/design/split-proposal.md](docs/design/split-proposal.md). Feature backlog:
[handover.md](handover.md).

## Migration state

Resuming or continuing the kteam→Ferretry migration (including on a new machine):
[docs/migration/START-HERE.md](docs/migration/START-HERE.md) — the single entry point: bootstrap,
work order, and cleanup. State and the `port/*` branch map are in `docs/migration/HANDOFF.md`; unit briefs in `docs/migration/units/`, source
surveys in `docs/migration/surveys/`.
