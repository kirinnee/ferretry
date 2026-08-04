> [!NOTE]
> Historical design proposal (2026-07-30), imported from the home-manager repo. The name chosen since is **Ferretry** (CLI `fy`, daemon `fyd`) — read "pitwall" below as a superseded working title.

# kteam + kfleet → standalone product — split proposal

Status: **draft for review** · Task: `&F192` · Date: 2026-07-30
Research inputs: full surveys of `modules/kteam-ts`, `modules/kfleet-ts` + `kfleet/` assets + repo coupling, and `~/Workspace/atomi/diene` (bun-cli branch of `diene.all`).

---

## 1. What we're building

One personal product, out of the home-manager repo, in two halves:

- **Daemon** (per machine — Mac, boxes): the agent runtime kteamd already is — sessions, tmux,
  transcripts, tasks, attention, warden, terminals, remote browser — plus the fleet layer (kfleet's
  job) folded in as a subsystem. Exposes a versioned REST + WebSocket API over a **link**
  (tailnet or Cloudflare tunnel).
- **PWA** (one install, centrally hosted): pairs with **many** daemons via single-use pairing
  codes (QR or copy-paste), holds a per-daemon device token, multiplexes their event streams.
- **CLI**: one binary, copied structurally from diene's `bun-cli` template; both the human tool
  and the agent-facing tool inside panes (as today).

---

## 2. Name

Constraints applied: short, phonetic, easy to spell, CLI-friendly, no major collision in the
dev-tools/agents space. Checked candidates (2026-07-30):

| Candidate                  | Metaphor                                                                                                                                                                     | Collision check                                                                                 | Verdict                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Pitwall** ✅ recommended | F1 pit wall: the command station watching every car's telemetry, radioing drivers. Daemons = garages, sessions = cars, attention = team radio, sessions list = timing tower. | Only F1 hobby projects (telemetry viewers, an F1 MCP server). No product/company in this space. | **Strong. Two simple words, perfect metaphor.** |
| Rookery                    | Colony of rooks (smart, social corvids). Daemons = rooks.                                                                                                                    | CNCF **Rook** (storage) shadows the root word.                                                  | Usable, but always "like Rook?"                 |
| Drover                     | Drives herds across long distances.                                                                                                                                          | Several small CLIs incl. an agent-workflow one.                                                 | Crowded.                                        |
| Conn                       | Naval "take the conn".                                                                                                                                                       | Generic; ungreppable; reads as "con".                                                           | Weak.                                           |
| Muster                     | Muster the crew; muster roll = crew list.                                                                                                                                    | **Taken twice**: themuster.dev (AI agent harness!) + giantswarm/muster (MCP proxy).             | Dead.                                           |
| Roost                      | Where the birds come home.                                                                                                                                                   | ROOST (safety nonprofit), roost.ai, many small repos.                                           | Dead.                                           |

**Recommendation: Pitwall.**

- CLI: `pitwall` (agents and humans), short alias `pw` shipped as an alias, not a second binary.
- Daemon: `pitwalld`.
- Repo: `github.com/kirinnee/pitwall` (personal, as requested).
- PWA: `app.pitwall.<personal-domain>` (hosting choice = open question §10).

(Everything below says "pitwall"; s/pitwall/<chosen name>/ if you pick differently.)

## 3. Brand / design direction

**Concept: the timing tower.** Race-control instrumentation, not dashboard-SaaS.

- **Logo**: a minimal timing-tower mark — a vertical stack of 3 rounded timing rows, top row
  highlighted (the leader / the session needing attention). Doubles as a "P" at small sizes if the
  highlighted row extends left as the stem. Works as monochrome glyph → favicon → maskable PWA icon.
- **Palette**: carbon black / graphite base, **telemetry cyan** as the primary accent, **amber**
  reserved exclusively for attention (radio) items, signal green for healthy/live. Light mode =
  "garage daylight": warm paper grey with the same accents.
- **Type**: condensed grotesk for headers, **tabular mono numerals everywhere data lives**
  (timing screens). The existing UI's session list literally becomes a timing tower: callsign,
  status, gap-since-last-event.
- **Keep** the existing 7-theme × light/dark system and per-daemon PWA branding (`PwaConfig`
  already does name/short_name/icon overlay per daemon) — the new brand becomes the default theme,
  and per-connection accent colors distinguish daemons at a glance.

## 4. Architecture

```
                    ┌─────────────────────────────┐
                    │  PWA  (one origin, static)  │
                    │  connection registry (IDB)  │
                    │  per-daemon device tokens   │
                    └──────┬──────────┬───────────┘
             HTTPS+WSS via │          │ HTTPS+WSS via
          tailscale serve  │          │ cloudflared + CF Access
                    ┌──────┴────┐ ┌───┴───────┐
                    │ pitwalld  │ │ pitwalld  │   ... (many)
                    │  (Mac)    │ │ (box)     │
                    └───────────┘ └───────────┘
                     tmux · harness homes · fleet manifest · files-first state
```

Monorepo (bun workspaces) — a deliberate deviation from diene's one-repo-per-template rule,
because this is one product, not a template fleet; every package still follows diene's _internal_
conventions (§7):

```
pitwall/
├── flake.nix  Taskfile.yaml  nix/  scripts/{ci,local,release,validate}/  probes/  .github/
└── packages/
    ├── protocol/   zod schemas for every API type + typed client SDK (shared by cli & pwa)
    ├── daemon/     kteam-ts src, de-kfleeted            → bin pitwalld
    ├── fleet/      kfleet-ts as a library + subcommands → `pitwall fleet apply|login|usage`
    ├── cli/        diene bun-cli skeleton               → bin pitwall
    └── pwa/        kteam-ts ui/, multi-daemon aware     → static dist (CF Pages/Workers)
```

Key structural decisions:

1. **The daemon is already a server** (Bun HTTP+WS on loopback, token auth, serves the
   SPA). We keep that shape; what changes is the trust model (§5) and CORS (today: none at all).
   The address moved: the system being replaced listens on 7337 and runs on every machine this one
   is installed onto, so the shipped default is single-sourced in `packages/protocol` and is not
   that number. A first boot with no recorded port takes the first free address from it and writes
   the choice into `config/daemon.json`; every port below is that recorded value, not a constant.
2. **Files stay authoritative, SQLite stays a disposable index** — this philosophy survives the
   move untouched. `~/.pitwall/` mirrors today's `~/.kteam/` layout.
3. **kfleet folds into the product** as `packages/fleet`. The three ugly couplings die:
   - kteam grepping generated wrapper _shell scripts_ for `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/
     `KTEAM_MODEL` → replaced by a **fleet manifest** (`~/.pitwall/fleet/manifest.json`) that
     `pitwall fleet apply` writes: per account `{wrapper, kind, mode, home, model, models[]}`.
   - the hardcoded account/model allowlist in `fleet-inventory.ts` → comes from the manifest.
   - the hardcoded default warden account → daemon config.
   - `kfleet serve` on :47318 as a separate usage process → a daemon-internal usage collector
     (one process fewer; kloop's consumer endpoint is preserved, see §8).
4. **PWA is centrally hosted, daemon-served as fallback.** Central origin = update once, all
   daemons benefit; daemon keeps serving its own copy so a tailnet-only / offline setup still
   works (same-origin, no pairing needed on-host — today's loopback behavior).
5. **Transport**: REST + ONE multiplexed `/v1/events` WebSocket per daemon connection (current
   design, kept). All payloads validated by `packages/protocol` zod schemas on both ends;
   `x-pitwall-version` skew detection kept.

## 5. Pairing & security (req 3 + 5)

Model: adapted from diene `concepts/deferred-login.md` (opaque single-use nonce, redeem-time
minting, revoke-on-failure) with the carrier swapped for QR/short-code. Today's "loopback = full
admin token in index.html" model is retired for remote clients; loopback keeps working unchanged
so on-host UX never regresses.

**Identities & tokens**

- Daemon mints an Ed25519 keypair at install; `daemonId` = pubkey fingerprint.
- Each paired client gets its own **device token** (256-bit random, **hashed at rest**,
  GitHub-PAT style) with metadata `{name, platform, createdAt, lastSeenAt}` in
  `~/.pitwall/daemon/devices.json`. Revocable per device from PWA/CLI (`pitwall devices`).
- The admin token never leaves the host. Warden capability-scoping and `x-…-stop-capability`
  survive as-is.

**Pairing flow (one flow, every surface)**

```
host$ pitwall pair --name "Ernest's phone"
  daemon mints { code: 7F3K-Q2ND, ttl: 120 s, single-use }
  CLI renders the QR IN the terminal (works over ssh on headless boxes),
  prints the code + link URL, and opens the loopback pairing page
  (http://127.0.0.1:<recorded port>/pair — big QR + copy button) when a display exists.

QR encodes:  https://app.pitwall.dev/pair#v1;url=https://box.tailXXXX.ts.net;code=7F3K-Q2ND;fp=<daemon-fp>
  → scanning with the phone's NORMAL camera app opens the PWA pre-filled. Zero typing.

PWA (scan or paste): POST {daemonUrl}/v1/pair { code, deviceName }
  daemon: constant-time compare, atomic single-use consume, ≤5 attempts then the code dies
  → { deviceToken, daemonId, daemonName, capabilities }
PWA stores the connection (url, daemonId, fp, token) in IndexedDB → connects.
```

**Why it's safe**

- Code: 120 s TTL, single-use, rate-limited, never in a query string (URL **fragment** only —
  fragments don't reach servers or logs).
- Confidentiality/integrity in transit comes from TLS on the link (ts.net cert or Cloudflare) —
  the code is never sent in cleartext.
- **Fingerprint pinning**: the QR carries the daemon's key fingerprint out-of-band; the pair
  response is signed by the daemon key, so a MITM at the tunnel provider is detected (hardening
  step, phase P3).
- **WS auth without header support**: browsers can't set `Authorization` on WebSockets, and
  putting the device token in `?token=` leaks it into access logs. Instead:
  `POST /v1/ws-ticket` (device token) → 30 s single-use ticket → `wss://…/v1/events?ticket=…`.
- Onboarding is never blocked (req 5): pairing is per-daemon, additive, and each surface (CLI
  terminal QR, loopback web page, PWA scanner, manual paste) is a complete path on its own.

## 6. Links: tailnet + Cloudflare tunnel with Access (req 4)

The **link** is the daemon's public URL, stored per connection in the PWA. Two first-class
adapters, both wired by one command:

- **`pitwall link tailscale`** → drives `tailscale serve --https=443 127.0.0.1:<recorded port>`.
  URL `https://<host>.<tailnet>.ts.net`, TLS by tailscale, reachability limited to the tailnet
  (ACLs = outer wall). Device tokens still required — defense in depth, and it's what makes
  "one PWA, many daemons" uniform across link types.
- **`pitwall link cloudflare`** → configures a `cloudflared` tunnel + prints the Access app
  checklist. With **Cloudflare Access** in front:
  - The PWA origin ≠ daemon origin, so the daemon grows a real **CORS layer** (exact-match origin
    allowlist in daemon config, `Vary: Origin`, `Authorization` allowed; today kteam has zero CORS).
  - Access auth for a browser is cookie-based on the daemon origin: the PWA detects an Access
    redirect, pops a top-level window to the daemon origin to establish the `CF_Authorization`
    cookie, then retries with `credentials: 'include'`. WebSocket upgrades carry that cookie
    automatically, so `/v1/events` works through Access.
- Anything else that terminates TLS (ssh -L, Caddy, nginx) keeps working — the daemon only ever
  sees HTTP; links are configuration, not code paths, except for the two managed adapters.

## 7. What we copy from diene (per your follow-up)

Source of truth: **branch `bun-cli` of `~/Workspace/atomi/diene/diene.all`** (the `bun-cli/`
folder is a stale v1.0.0 snapshot). Read with `git -C …/diene.all show bun-cli:<path>`.

Copied structurally (per package):

- **Composition-root skeleton** `bin/<name>.ts`: `createProgram()` / `buildWorld()` /
  `registerDomain()` fences, `import.meta.main` guard, cleanups in `finally` each in own
  try/catch. Commander v15; one command = one controller class returning an exit code; zod parses
  raw args at the controller boundary.
- **Three-layer DI**: `src/lib` (pure domain) / `src/adapters` (all IO) / composition root, with
  the arch probe that fails the build on console calls in `lib/`.
- **Terminal port layer** verbatim: `ICliIo`/`ISpinner`/`IProgressBar`/`IPrompt`/`IShellRunner`
  (chalk, ora, cli-progress, inquirer, Bun `$`); never prompt off a TTY.
- **Test pyramid**: `bunfig.{unit,int,sit}.toml` scoped-coverage ledgers; **dual-driver SIT**
  (compiled-binary black box + in-process instrumented driver running identical journeys).
- **Release machinery**: `bun build --compile` (linux-x64-baseline / linux-arm64 / darwin-arm64),
  GoReleaser v2 with the Go-stub + binary-swap shim, Homebrew cask, curl|bash installer with
  checksum verify, `publish.sh --snapshot` offline dry run, 3-platform smoke matrix.
- **Repo hygiene**: nix flake (fixed-output deps derivation) + direnv, Taskfile (`pls`),
  pre-commit via nix, prettier formats / biome lints / knip (incl. `.llm.json` agent variants),
  `scripts/validate/*` invariants, **probes/** (`gate`/`smoke`/`presence` self-verification),
  semantic-release with the scope taxonomy (re-branded personal, not `atomi_release`/`sg` —
  their `tools/releaser` approach is the model).
- **Docs/skills**: ship `.claude/skills/` in-repo (cli-authoring, testing, three-layer doctrine),
  CLAUDE.md as a pure index.

Deliberate deviations: bun-workspaces monorepo (diene: one package per repo); we keep websocket +
PWA code diene doesn't have; Cloudflare tunnel stays (diene retired it for CI previews — our use
case is different); personal branding/namespace throughout, no AtomiCloud org references.

## 8. Dependency map — what moves, what must be untangled

_(= the answer to "is there anything else that this set depends on?")_

**Moves into the new repo**: `modules/kteam-ts` (daemon+cli+ui), `modules/kfleet-ts`, the
`kfleet/` asset tree (config.yaml, CLAUDE\*.md, templates, 14 skill pairs, statusline).

**Hard couplings to break in the split** (all found in survey):

- wrapper-script grepping + `(claude|codex)-auto-*` name grammar + hardcoded model allowlist +
  hardcoded warden account → fleet manifest (§4.3).
- `kfleet serve :47318` usage feed → daemon-internal collector.
- `~/.secrets` sourcing (home-manager convention) → configurable secrets file path.
- learning-miner patch targets hardcoded to repo-relative `kfleet/CLAUDE*.md` → target the new
  config home.

**Stays behind but must be re-pointed** (they call kteam/kfleet, not the reverse):

- `kloop` (PATH, kteam dispatch, `/usage` endpoint), `kautopilot` (kteam writer sessions, deep
  links, reads `~/.kfleet/skills/kautopilot/visual.md` at runtime), `khost` (Grafana scrapes
  :47318), `kloge` (supplies the CLI-proxy pool + `~/.kloge/management-key` — stays a separate
  tool; the fleet usage collector keeps probing it).
- home-manager: `home-template.nix` (links, `kfleet apply` activation, packages, `ki()`, aliases),
  `modules/default.nix` bun-wrapper derivations, `Taskfile.yaml` `box:login`, `scripts/box/up.sh`
  OAuth port-forward.
- Host binaries assumed: `tmux` (hard), `git`, `jq` (wrapper autotrust), Chrome/Xvfb/x11vnc
  (browser feature), `systemd`/`launchd`, `tailscale`/`cloudflared` (new, optional).
- sops secrets (`ZAI_API_KEY_*` etc.) baked into wrappers at apply time — unchanged mechanism,
  new home.

**Left to die**: `modules/agent-config` (already deprecated, imported by nothing).

**Compat**: `kteam`/`kteamd`/`kfleet` shim wrappers that exec the new binaries for one
transition period, so kloop/kautopilot/skills/muscle memory don't break on day one.

## 9. Migration phases

- **P0 — scaffold**: new repo `kirinnee/pitwall` from diene bun-cli conventions (nix, Taskfile,
  pre-commit, release, probes), empty packages wired, CI green on hello-world.
- **P1 — lift & rename**: kteam-ts src → `packages/daemon`+`cli`, ui → `packages/pwa`,
  kfleet-ts → `packages/fleet`; extract `packages/protocol`; behavior-preserving; shims in
  home-manager; `ui-dist` stops being checked in (CI builds it).
- **P2 — de-couple**: fleet manifest replaces wrapper-grep/allowlists; usage collector folded in;
  secrets/learning paths configurable.
- **P3 — remote access**: device tokens + pairing + ws-tickets + CORS + devices management UI;
  loopback behavior preserved.
- **P4 — links + brand**: `pitwall link tailscale|cloudflare`, PWA deployed to central origin,
  new logo/theme, per-connection branding.
- **P5 — cutover**: home-manager consumes the flake input; delete `modules/kteam-ts`,
  `modules/kfleet-ts`, `kfleet/`; re-point kloop/kautopilot/khost; remove shims when green.

Each phase = its own PR train in the new repo; the daemon keeps running throughout (P1–P2 are
invisible to the fleet).

## 10. Open questions for Kirin

1. **Name** — Pitwall? (or Rookery / Drover / Conn / your own)
2. **PWA hosting** — Cloudflare Pages/Workers on which personal domain?
3. **Repo visibility** — public or private? (affects install channels: Homebrew tap, curl|bash)
4. Fold fleet into the `pitwall` CLI as `pitwall fleet …` (proposed) or keep a separate binary?
5. Monorepo (proposed) vs diene-style multi-repo — confirm the deviation is acceptable.
