# Ferretry — mission prompt

You are working in **Ferretry** (`github.com/kirinnee/ferretry`), Kirin's personal product that
extracts **kteam** (agent-team control plane) and **kfleet** (agent fleet provisioner) out of the
home-manager repo into a standalone daemon + PWA + CLI product.

> A group of ferrets is called a **business**. Ferretry runs your business of ferrets: you
> dispatch agents, they ferret out results, and you watch the whole business from one PWA.

## What we are building

- **`fy`** — the CLI (humans _and_ agents inside panes use it). Binary name is `fy`; the product
  name is `ferretry`. Two-name model — see `docs/standards/architecture.md`.
- **`fyd`** — the per-host daemon: owns detached agent sessions (tmux), transcripts, tasks,
  attention, warden, terminals, remote browser, fleet provisioning. HTTP + WebSocket API.
  State home: `~/.ferretry` (files authoritative, SQLite = disposable index).
- **The PWA** — ONE installable web app that pairs with MANY daemons: single-use pairing codes
  (QR scan or copy/paste, from CLI and web), per-device revocable tokens, one multiplexed
  event WebSocket per daemon, links over tailnet (`tailscale serve`) or Cloudflare tunnel + Access.
- **Fleet** — kfleet's job as a first-class subsystem: generates per-account agent wrappers and
  publishes a **fleet manifest** the daemon consumes (this replaces kteam's old
  grep-the-wrapper-shell-script hack).

Full architecture, pairing protocol, and security model: `docs/design/split-proposal.md`.

## Phase order (do not reorder)

1. **Standards** — port diene's `docs/standards/**` tree (57 files on the `bun-cli` branch of
   `~/Workspace/atomi/diene/diene.all`) into this repo, adapted: strip AtomiCloud-specific
   subjects (infisical, service-tree; park docker until we ship images), keep the engineering
   doctrine (three-layer, stateless-oop-di, SOLID, functional practices, testing, validation,
   linting, nix, taskfile, semantic-release, shell-scripts, conventional-commits, contributor-docs),
   and rewire `CLAUDE.md` as the pure index into it. `docs/standards/` is the living doctrine —
   keep it current as decisions are made.
2. **Replicate kteam (full migration)** — port `~/.config/home-manager/modules/kteam-ts` (daemon,
   CLI, UI) and `~/.config/home-manager/modules/kfleet-ts` into `packages/{daemon,cli,pwa,fleet}`
   with `packages/protocol` extracted (zod schemas shared by cli + pwa). Behavior-preserving
   first: same features, new names (`kteam`→`fy`, `kteamd`→`fyd`, `~/.kteam`→`~/.ferretry`,
   `KTEAM_*` env → `FY_*` with back-compat reads). Decouple from kfleet internals via the fleet
   manifest. kloge and loctl are OUT of scope — keep them external.
3. **New features** — `handover.md` at the repo root is the imported backlog (stable item
   numbers; import every row as Todo). The new remote-access architecture (pairing, device
   tokens, ws tickets, CORS, link adapters) is part of this phase and is specified in the
   design doc.

## Sources of truth

| What                          | Where                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| kteam source to replicate     | `/home/kirin/.config/home-manager/modules/kteam-ts` (src ~251 files, `ui/`)                 |
| kfleet source to replicate    | `/home/kirin/.config/home-manager/modules/kfleet-ts`                                        |
| Architecture & pairing design | `docs/design/split-proposal.md`                                                             |
| Feature backlog               | `handover.md` (root)                                                                        |
| Engineering doctrine          | `docs/standards/` + `.claude/skills/cli-authoring/SKILL.md`                                 |
| Repo conventions' origin      | diene.all `bun-cli` branch (`git -C ~/Workspace/atomi/diene/diene.all show bun-cli:<path>`) |

## Rules

- One bounded feature at a time: implement → verify → review → land. No audit swarms.
- Never break the release pipeline: `nix develop .#releaser -c ./scripts/release/publish.sh
--snapshot` must stay green on `main`; it is the merge gate alongside `task test` and pre-commit.
- Conventional commits; the repo is **public** — write commit messages and docs accordingly.
- The migration must not disturb the still-running kteam installation on this machine
  (`~/.kteam`, `kteamd`) — Ferretry gets its own state home and ports.
- Big context and full-strength models: this is deep systems work; plan before porting each
  subsystem, and record decisions in `docs/standards/` as you go.
