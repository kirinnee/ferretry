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
accounts referencing one path in the asset tree — so what this adds is a
**declaration and a report**, not a second mechanism: `config.shared` names documents, the sharing
report says per account and per field whether the effective value is a declared shared one or its own,
which slot supplied it, and HOW it reaches the home, and `link` / `unlink` are reviewed mutations like
any other. **A shared document IS the file in every home that references it**: every single-pick asset
(`memory`, each `skills` item, `hooks`, `hooksDir`, `mcp`) is materialised as a real symlink into
`fleet/assets`, so editing the document changes every account immediately with no apply in between —
which is what made extending `StateFileSystem`'s narrow `fleet/homes` symlink exemption from
`fleet/shared` to `fleet/assets` necessary, and it admits nothing else. **`settings` is the one
`generated` field**: a stack deep-merged in memory and written as one file, because a merge of N
sources cannot be a link to any of them AND each harness rewrites its own settings at runtime, so the
destination is also an input. A source outside the asset tree (`/`, `~`, `$HOME`, or a `..` that climbs
out) stays a **copy**, because a link inside a home may only ever resolve into the asset tree.
`resolveAssetMaterialization` is the single owner of that decision and the plan builder and the report
both read it, so a surface can never promise a live link the apply then copies. **`skills` is
per ITEM, not one directory**: the store registers one entry per skill, an account's `skills` is the
LIST it selected, a later slot replaces that whole list, and each item lands under its own name at
`<home>/skills/<item>` — so two accounts can overlap on some items and not others, and an item dropped
from a selection is removed from the home rather than left behind. **Unlink
materialises a private copy** rather than leaving an account with nothing, and never touches the shared
document. **Identity and auth are never shared**, enforced by the schema rather than by convention:
everything shareable is a `Profile` field, and an account's identity and provider login are
`AccountRoute` / `Agent` fields that no strict profile can express. This is deliberately **not** the
`shared-history.ts` pool even though both are symlinks — every asset path is a destination the fleet
plan writes on every apply, which is the exact opposite of the pool's "the harness owns this and
Ferretry never writes it", and pooling one would give a single inode two owners. Migration is therefore a declaration and moves
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

A **profile can authenticate an account instead of a login** — the "no login wanted" answer — and the
contract is [docs/fleet-env-profiles.md](docs/fleet-env-profiles.md). **There is no second profile
system**: a profile already existed, already composed, and `env` was already one of the fields it
composed; what it could not carry was a CREDENTIAL, because every value went into a generated wrapper
in plain text. So this is **one spelling added to the value grammar** — `${secret:NAME}`, the same
reference `config/daemon.json` already uses, against the same store — and composition needed no work
at all. Anyone reading it as a parallel mechanism will "simplify" it into one. **Composition is
therefore the composition it always was**, right-overriding-left through the chain
`compositionSlots` owns, and the report READS that chain rather than restating it, because two
orderings would disagree exactly where it matters most — on an account whose credential is not the
one the report claims. It is **visible** as the origin on each secret-listing row, naming the account,
the variable, the slot that won AND the slots it beat, in words that never say "layer" or "lane"
(both removed in `#384`). **Use, never read holds unchanged**: a value reaches exactly one place, the
environment of the child launched for that one account, so no route, command or error returns one and
`FleetLaunchEnvironment` is the THIRD thing in the daemon holding a `SecretVault`. **The two halves
read different documents on purpose** — a launch reads the published manifest so a `config.yaml` typo
cannot refuse every session, and the reference listing reads the configuration because only it knows
WHICH profile set a variable; do not unify them. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
`CODEX_SQLITE_HOME` are **refused at parse time, naming the variable**, since a profile that set one
could point an account at another account's credential, and a malformed `${secret:…}` is refused
rather than exported as the text of itself. A missing secret **refuses the launch naming every one**,
never an empty credential; a damaged vault refuses too. A profile is **opt-in** and an account that
binds none never opens the store, which is what keeps an ordinary fleet working on a host whose vault
is damaged. Read the GAPs before describing the surface: there is no UI for creating a profile yet,
the browser's sign-in row is told `environment` rather than `secret-store` on purpose, and a wrapper
run from a plain shell now fails for a profiled account by design.

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

Every fleet account also publishes **whether it is signed in and when that was last established**,
and the contract is [docs/fleet-health.md](docs/fleet-health.md). It replaces a question that could
only be answered by spending: health used to mean "can this wrapper answer a sentinel prompt", which
LAUNCHED the account's agent and asked a model to reply — a billable turn per account, on a timer,
for nobody. `healthy` now means the current credential was recently accepted, which says nothing
about quota, entitlement or provider uptime. **Zero spend is structural**: the verdict is a pure
function of a usage snapshot somebody already collected and a LOCAL credential read, so there is no
seam to hang a spend on, and `GET /v1/fleet/health` is a store read a browser may hydrate on page
load. **There is no health timer** — health rides the free read-only `GET /api/oauth/usage` the quota
pass already makes, so a verdict refreshes as a side effect of a read the daemon was making anyway.
The single most consequential rule is that a confirmed Anthropic JSON **`403` from that endpoint is
HEALTHY**: the token merely lacks `user:profile`, permanently, for an inference-scoped token, and
reading it as a rejection sends somebody to re-login forever on a working account. An HTML/WAF `403`
and a bare control-plane `401` are inconclusive, with a strict secret-safe response fingerprint
retained so neither becomes an invented credential verdict. `needs_credentials` is a separate
verdict from `needs_relogin` because an account authenticated by an environment variable **cannot** be
fixed by signing in. **Codex is honestly `unknown`** and that is the finished answer, not a gap: its
usage endpoint answers `200` for stale tokens, and the refresh that would prove liveness rotates a
single-use token. A stale `401` cannot condemn a fresh login — an opaque credential digest is compared
before a remote negative commits — and a fifteen-minute horizon expires NEGATIVE verdicts too, so an
external re-login is never condemned forever. Read the GAPs before describing what this protects
against; the credentialed provider path is deliberately not proved on a booted daemon, because the
only way to close that is a setting redirecting where a bearer token is sent.

`packages/daemon` also decides **what a caller who is NOT on this host may do**, per capability
(`fleet`, `terminal`, `browser`, `filesystem`, `warden`, `pairing`) and per axis (_use_ / _configure_). **A
loopback caller is ungoverned** — somebody at the machine already has the machine — and "loopback"
means how the request ARRIVED, decided from the carrier: the relay terminates on the host it serves,
so any check reading a peer address, a `Host` header or a URL would hand a remote phone full control.
Defaults are permissive and the **operator password** is the opt-in layer; a grant can only ever
narrow what a credential could already do, and an undetermined document fails closed. The contract,
the widen/narrow asymmetry and the declared GAPs are [docs/grants.md](docs/grants.md).

A browser can also drive **the harness's own sign-in**, and the daemon holds no token while it does: it
launches the account's own wrapper with piped stdio and a sanitized environment, publishes a verification
URL — and for Codex a device code — accepts one short-lived authorization code straight into that child's
stdin, and lets the harness write its own credential into its own store. The contract is
[docs/design/harness-login.md](docs/design/harness-login.md). **There is one flow PER HARNESS and no shared
abstraction over them**: Claude prints a URL and reads a pasted code, Codex completes a device grant and has
no return trip, and a single parameterised flow would have needed both as options — a shape that can express
a Codex sign-in waiting for a paste. A login is a **declared** per-harness property, and whether one applies
to an ACCOUNT is decided by where its credential comes from: a token file or an environment variable means
there is nothing to sign in to, so no control is offered and the surface says where the credential DOES come
from instead. Every route that acts sits on `fleet.configure` with the existing per-change
operator-password confirmation and **no second gate** — the remote risk is account substitution, not token
theft. `--with-access-token` and `--with-api-key` stay host-and-CLI-only at every layer.

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

**Starting the daemon IS the setup**, and the contract is [docs/fleet-defaults.md](docs/fleet-defaults.md).
A harness the boot detects earns four names and no others — `claude-default` / `claude-auto-default`,
`codex-default` / `codex-auto-default` — from `packages/fleet/src/lib/defaults.ts`, which is the single
owner of the naming rule a browser form also uses. **This writes executable wrappers into the operator's
home, so the boot says what it created, where, and the key that switches it off**; nothing is ever
replaced, because scaffolding stays create-if-absent and a host that already has a fleet keeps it byte
for byte. Detection is `locateHarnessCommand`'s and there is no second detector, an unreadable manifest
prepares nothing rather than guessing, and a preparation that fails is a loud notice and never a refused
boot. **An account created this way also arrives SIGNED IN** where there was a login to copy: the first
run seeds each new home from this host's own harness install, which is an **import and never a sync** —
a harness rewrites its credential by temp-file-and-rename, so a synchroniser would race that forever and
lose silently, and a symlink would be replaced by the first refresh. **macOS is a keychain
read-and-rewrite, not a file copy**, because the item name derives from the home path; a file-copy-only
seed passes every other test and does nothing on a Mac. Only a **`missing`** credential is written —
`unreadable` is refused and named, never overwritten — the donor is read once per harness, the target is
read first so a re-run is silent, and **nothing this preparation did not add is ever touched**. Every
ending is a value, so a locked keychain costs one sentence rather than the fleet, and the boot says per
account which are signed in, which are not, and the absolute directory each login was read from. **No
credential value can reach a boot line**: the sentences are built from verdicts and the material never
leaves the adapter that copied it.

## Migration context

Mission and phase order: [docs/PROMPT.md](docs/PROMPT.md). Architecture, pairing, and security
design: [docs/design/split-proposal.md](docs/design/split-proposal.md). Feature backlog:
[handover.md](handover.md).

## Migration state

Resuming or continuing the kteam→Ferretry migration (including on a new machine):
[docs/migration/START-HERE.md](docs/migration/START-HERE.md) — the single entry point: bootstrap,
work order, and cleanup. State and the `port/*` branch map are in `docs/migration/HANDOFF.md`; unit briefs in `docs/migration/units/`, source
surveys in `docs/migration/surveys/`.
