# Updating the daemon

How a machine learns that a newer Ferretry exists, and how it gets onto it — by one click, by one
command, or by the steps its install method needs. Read this before changing anything under
`fy daemon update`, `/v1/daemon/update` or Settings › Machines › _machine_ › About.

## The one-sentence version

**The daemon works out how it was installed, asks GitHub for the latest release at boot and at most
every six hours, and updates itself only where its install method can be updated without `sudo` and
without rewriting somebody's configuration — every other method gets the exact steps instead.**

## Install methods

The daemon and `fy` classify the same facts with the same pure function
(`classifyInstallMethod` in `packages/protocol/src/lib/daemon-update.ts`), so `fy daemon status` and
the app can never disagree about what a machine is.

The facts are: the path the daemon was **launched as** (what the unit file or `PATH` names), the same
path with **symbolic links resolved**, the **chain of links between the two**, the user's home, the
platform, the nix profile element that holds a store path on that chain (from `nix profile list
--json`), and whether a system package manager owns the file.

**Read the chain, not just the end of it.** The `ferretry` flake package is a symlink join:
`~/.nix-profile/bin/fyd` → `/nix/store/<hash>-ferretry/bin/fyd` → `/nix/store/<hash>-fyd-<version>/bin/fyd`.
The profile element holds the OUTER path, which the fully resolved file is not under — so an element is
matched against every store path the launched path passes through, never against the resolved file
alone. The `home-manager-path` element is home-manager's own generation; it is never "the element".

**How home-manager is told apart from a system install.** home-manager always builds a package
environment named `<hash>-home-manager-path`, and every executable it installs is linked through it.
Walking the launched path's links therefore shows it (`passes through home-manager-path`) with no
`sudo` and no command: a single `readlink` per component. That one fact separates the two things
`/etc/profiles/per-user/<user>/bin` can be:

- **home-manager inside nix-darwin or NixOS** (`home-manager.useUserPackages = true`): the chain
  passes through `home-manager-path`. Reported as **home-manager (via nix-darwin|NixOS)**.
- **a package the system itself puts in the user's profile** (`users.users.<u>.packages`), and
  anything under `/run/current-system/sw/bin` (`environment.systemPackages`): no `home-manager-path`
  on the chain. Reported as a **nix-darwin** or **NixOS** module.

| method           | how it is recognised                                                              | update                                                            |
| ---------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `homebrew`       | the resolved path is under `…/Caskroom/<product>/`                                | **self**: `brew update`, `brew upgrade --cask <product>`, restart |
| `nix-profile`    | a store path reached through the user's nix profile, held by a profile element    | **self**: `nix profile upgrade <element>`, then restart           |
| `nix-shell`      | the launched path is itself a `/nix/store/…` path (an ephemeral `nix shell`)      | **switch**: offer a nix profile install; never silently           |
| `nix-module`     | a store path reached through home-manager, nix-darwin or NixOS (see above)        | **manual**: bump the flake input, then switch                     |
| `system-package` | `dpkg` or `rpm` owns the file (`/usr/bin/<daemon>` from the deb/rpm)              | **manual**: the exact `sudo apt`/`sudo dnf` command               |
| `standalone`     | a release archive or `install.sh` binary anywhere else                            | **self**: download, verify the signature, swap, keep a rollback   |
| `unknown`        | a development build (`bun …/fyd.ts`) or anything the rules above do not recognise | **manual**: none — said so                                        |

Two things deliberately do NOT self-update:

- **A home-manager / nix-darwin / NixOS module** is pinned by the flake input in someone's own
  configuration. Changing that pin is changing their configuration, which is theirs. The app shows
  `nix flake update <input>` and the one switch command for that flavour. When home-manager runs
  inside nix-darwin or NixOS the switch is the **system** rebuild (`darwin-rebuild switch --flake .` /
  `sudo nixos-rebuild switch --flake .`) — there is no separate `home-manager switch`, and the
  step says so. Standalone home-manager uses `home-manager switch --flake .`.
- **A deb or rpm** needs `sudo`, and the daemon never asks for root. The app shows the command.

## Why the nix profile, and never a store path

`nix shell github:kirinnee/ferretry` puts a `/nix/store/<hash>-ferretry/bin` directory on `PATH`.
A unit file must record an absolute path, so it records that store path — and the next
`nix-collect-garbage` can delete it (the GC root `fy` takes is a mitigation, not a fix). Updating
means running `nix shell` again and reinstalling the unit by hand.

A nix profile gives a **stable** path: `~/.nix-profile/bin/<daemon>` is a link that moves when the
profile moves. `fy daemon install` records the path it finds on `PATH` without resolving it, so a
profile install's unit names the profile link, and `nix profile upgrade` plus a restart is the whole
update. `fy daemon install` on a `nix-shell` daemon therefore offers to run
`nix profile install github:kirinnee/ferretry` first (it asks; `--yes` does not answer it for you).

`fy daemon update` on a `nix-shell` daemon explains this and offers the same switch; it changes
nothing unless asked (`--switch-to-profile`, or answering yes). The app's button for it is labelled
as a switch, not as an update.

## Knowing the latest version

- **Source**: the GitHub releases API, `GET /repos/<owner>/<product>/releases/latest` — the same
  release GoReleaser publishes (see [Semantic Release](standards/semantic-release/index.md)). Drafts
  and prereleases never count. The changelog link is the release page.
- **When**: once at boot, then at most every six hours — at the daemon's first look after that, which is
  never more than fifteen minutes late. A version compare only — nothing is
  downloaded until somebody asks for the update.
- **Cache**: `<state home>/state/update/latest.json` (beside it: `config.json`, the setting; `report.json`, the last outcome; `update.log`, the client's output), so a restart inside the six hours does not ask again.
- **Failure**: the check never fails a boot and never retries in a loop. A failed check is reported
  as such ("could not reach GitHub"), and the last good answer, if any, stays on screen with its age.
- **Off**: a development build run from source never asks (it has no release to compare with), and
  `FY_UPDATE_CHECK=off` in the daemon's environment switches the check off — which is also how a
  suite that boots a real daemon stays off the network.

## Applying an update

`fy daemon update` is the one implementation. The app's **Update** button asks the daemon, which
starts `fy daemon update --yes --to <version> --report <file>` (the `fy` beside the daemon
executable) as a detached process and answers at once. Both service managers let that process
survive the daemon's own restart: the systemd unit uses `KillMode=process` and the launchd agent
`AbandonProcessGroup`, for the same reason the session panes do.

Every self-update is the same transaction:

1. **Check** the target is newer than what runs, and the method can self-update.
2. **Say what happens to ferrets mid-turn** — they keep running (see
   [Ferrets keep running](#ferrets-keep-running)) — or, with `--when-idle`, wait until none is.
3. **Upgrade** with the method's own tool (`brew`, `nix profile`) or, for a standalone binary, by
   downloading and verifying the release archive.
4. **Restart** through the service manager, exactly as `fy daemon restart` does.
5. **Health check**: the installed version must be the target **or newer**, and `/healthz` must report that installed version within 30 seconds. A package manager can build something newer than the release that was offered (semantic-release tags before the GitHub release, the cask and the archives catch up, and `nix profile upgrade` builds the flake's `main`); that is a healthy update, reported as `updated 4.46.0 → 4.47.1 (newer than the 4.47.0 release you were offered)`. An older, unchanged, pre-release-of-the-target or unreadable version is still rolled back. A nix install is offered the newest stable tag rather than only the latest release, so the prompt names the version it will get; Homebrew and standalone installs download release assets, so they are offered the release.
6. **Roll back** when it does not: `nix profile rollback`, or putting the previous standalone binary
   back, then restart again and confirm the previous version serves.
7. **Report** the outcome. The new daemon reads the report file and shows it in the app.

Homebrew keeps no previous cask version, so a failed Homebrew update cannot be rolled back
automatically. That is a declared GAP: the outcome says so and names `fy daemon logs`.

### An up-to-date daemon on a stale service definition

`install`, `start` and `restart` rewrite the service definition every time, but a daemon its service
manager respawned onto a newer executable never passed through any of them. The one such definition
that matters is a launchd plist with no `ProcessType`, which macOS answers by throttling the daemon's
CPU and I/O — and every agent's, because children inherit it. The plist now declares `Interactive`,
`fy daemon status` names the job's `ProcessType` and warns "macOS is throttling the daemon — run
`fy daemon update`" when it is anything else, and `fy daemon update` on an up-to-date daemon with
such a plist restarts it (behind the same `--yes` or prompt an update asks for) so the plist is
rewritten. A stopped daemon is left alone: its next start rewrites the plist.

### Homebrew refreshes its tap first

Homebrew only auto-updates its taps about once a day (and never with `HOMEBREW_NO_AUTO_UPDATE`), so a
bare `brew upgrade --cask` can answer "already up to date" or install an old cask. The update therefore
prints a progress line and runs `brew update` first (tapping `kirinnee/ferretry` again if the tap has
gone missing), then `brew upgrade --cask`, then proves the installed version is the target. A failure
at any step names the manual recovery. The cask clears macOS quarantine in its own `postflight`.

By hand:

```bash
brew update && brew upgrade --cask ferretry && fy daemon restart
# if the tap is wedged:
brew untap kirinnee/ferretry && brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry && brew reinstall --cask ferretry
```

### The standalone binary

The release carries `checksums.txt` (GoReleaser) and `checksums.txt.sig`, an Ed25519 signature over
`ferretry-daemon-release-v1\n` followed by the exact bytes of `checksums.txt`. The prefix is what
keeps a signature made for this file from meaning anything anywhere else. The update:

1. downloads `fy_<os>_<arch>.tar.gz`, `checksums.txt` and `checksums.txt.sig`;
2. verifies the signature against a key compiled into `fy` (`packages/cli/src/lib/update/release-keys.ts`);
3. verifies the archive's SHA-256 against its line in `checksums.txt`;
4. unpacks `fy`, `fyd` and `fyd-browser-worker` next to the current ones as `*.new`;
5. renames each current binary to `*.previous` and each `*.new` into place (a rename is atomic on one
   filesystem);
6. restarts and health-checks; on failure renames `*.previous` back.

**No key, no self-update.** A build that carries no release key refuses the standalone update and
prints the `install.sh` command, which verifies checksums only. Signing is set up once by the owner:

```bash
openssl genpkey -algorithm ed25519 -out daemon-release-key.pem
openssl pkey -in daemon-release-key.pem -pubout -outform DER | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

Put the private PEM in the `DAEMON_RELEASE_SIGNING_KEY` secret of the `daemon-release` environment,
add the printed public key to `release-keys.ts`, and delete the local PEM. `cd.yaml` signs when the
secret is present; `scripts/ci/sign-daemon-release.sh` refuses a key whose public half is not listed.

## Safety

- **Mid-turn is not a reason to refuse.** The daemon knows which ferrets are mid-turn
  (`turnState: working`) and the app and `fy` say so in one line, but an update asked for `now` goes
  ahead: ferrets keep running through the restart (below). **Update when idle** (`when: 'when-idle'`,
  `--when-idle`) is still there for whoever would rather wait for every turn to end.
- **Remote devices** may start an update or change the update setting only with the `fleet`
  capability's `configure` axis **and** a passkey step-up, like loosening a configuration file. A
  remote update downloads and runs new code on the machine, which is at least as much as the acts that
  rule already covers. `fy` at the machine is ungoverned, as everywhere ([grants.md](grants.md)).
- **Automatic installs still wait for idle.** Nobody chose that moment, so an automatic update starts
  only when no ferret is mid-turn.
- **No auto-update by default.** _Install updates automatically when idle_ is off until somebody turns
  it on. When on, the daemon starts the update only when no ferret is mid-turn, and only for a method
  that can self-update.
- **One update at a time.** A second request while one is running answers `409 update_in_progress`.

## Ferrets keep running

**A daemon restart — an update, `fy daemon restart`, or the service manager bringing a crashed daemon
back — no longer interrupts a ferret mid-turn.** "Update now" goes ahead with one line saying so.

What survives the restart, and why:

| piece                | where it lives                                | after the restart                                                                                                                |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| the ferret itself    | the daemon's tmux server                      | still running; the service managers keep it (`KillMode=process`, `AbandonProcessGroup`) and the new daemon adopts its pane again |
| its turn state       | the session's state document, on disk         | unchanged; the turn watcher's next look confirms it (`lib/session/turn/service.ts`)                                              |
| a message sent to it | the send ledger, one file per send            | the tracker re-derives every open send from the transcript at boot and re-types nothing (`lib/session/send/tracker.ts`)          |
| its Ferretry calls   | `fy` and `fy mcp serve`, in the ferret's pane | **wait for the daemon to come back**, below                                                                                      |

### Calls made while the daemon is down

`fy` (every command group but `fy daemon …`) and the MCP tools server wait out a restart instead of
failing (`packages/protocol/src/lib/daemon-restart.ts`):

- **Who waits.** A ferret always does (`FY_SESSION_ID` is set): it only exists because a daemon ran
  it, so a daemon that refuses it is restarting. A person waits only while a restart is known to be
  underway — `fy daemon restart` (and so every update) leaves `<state home>/restarting.json`, which
  expires on its own after two minutes — so `fy list` against a daemon somebody _stopped_ still fails at
  once. `fy daemon …` itself never waits: those verbs are the restart.
- **How long.** Up to 60 seconds from the first failure, looking again after 250 ms, 500 ms, 1 s, then
  every 2 s. It says `fy: daemon restarting, retrying for up to 60s…` once, on stderr (never on the MCP
  server's stdout).
- **What is sent again.** A request the daemon **refused** never reached it, so it is always sent again.
  One it **dropped** mid-request may already have been applied: `fy`'s client sends it again under the
  same `x-fy-request-id`, the logical id the daemon applies a send or a start once by; the MCP
  tools, which carry no such id, repeat only the tools that change nothing (`terminal.list|read|wait`,
  `browser.list|read|screenshot`, `config.read|validate`). A dropped `terminal.send` is never typed
  twice; it fails with the original error.
- **`fy wait`** is a loop of short reads, so it simply resumes: the read that met the restart waits, and
  the loop goes on.
- **A timeout, a cancellation and any HTTP answer are never waited on.** The daemon answered, or the
  caller left.

### Declared GAPs

- **Event streams are not resumed.** `fy stream` ends with an error when the
  daemon goes down; run them again (`fy stream <id> --after <n>` resumes a session from its cursor).
  The app reconnects its own streams.
- A daemon that comes back on a **different port** (its preferred one was taken) is not followed by a
  call already waiting; the next `fy` invocation finds it.
- A browser waits through a restart with its own "restarting" state; it does not use this client policy.

## After the host restarts: auto-resume

A daemon restart leaves the ferrets running (above). A **host** restart — a reboot, a crash, a logout
that tears down the user's processes — does not: the daemon's tmux server goes with it, and every pane
is gone while the session records still say they were running. **Auto-resume brings those ferrets back
with their conversation intact.** It is a per-machine setting, **on by default**: Settings › Machine ›
_Auto-resume after restart_, or `fy machine set auto-resume on|off` (`fy machine` shows it, and the last
pass).

- **What counts as "was running".** The daemon's FIRST self-check after boot settles every session whose
  terminal is gone. Those it settles because the pane vanished — not a pane that exited with a status, not a
  session a person stopped or that finished — are written to `<state home>/auto-resume.json` _before_
  anything is attempted, so a second power cut mid-pass loses nothing. A pane that dies on a daemon that
  stayed up is an ordinary crash and is not auto-resumed.
- **How.** After the daemon is serving, never before. It uses the revive a send uses
  (`--resume <id>` / Codex resume; the bound conversation travels with it), two at a time, four
  seconds apart. Each entry is removed from the ledger when it has been dealt with, and an entry older than
  24 hours is dropped rather than revived.
- **What the ferret is told.** Nothing, unless it was mid-turn: then one short Ferretry notice that the
  machine restarted and the turn could not be checked (the same rule as a daemon restart). An idle
  interactive ferret is relaunched without a first message.
- **What is left alone.** A session someone stopped, one that finished, or one already revived by hand
  stays as it is: only a session still `failed` is resumed.
- **What is skipped, and said.** A session whose runtime or login is unavailable is not resumed; its
  journal gets `couldn't auto-resume: <reason>` (a `session.auto_resume_skipped` event), and so does a
  revive that failed. A resumed one gets `session.auto_resumed`.
- **Where it shows.** The Machine tab shows "Resumed 5 ferrets after restart" with the skipped ones and
  their reasons, from `lastAutoResume` on the machine view (`<state home>/auto-resume-summary.json`).
- **Turned off** it resumes nothing and clears the ledger, so turning it on later does not revive a
  reboot from days ago.

## Updating from an agent

An agent (Claude Code, Codex) never runs the update itself. Claude Code's auto-mode safety checks
block `brew update`, `brew upgrade`, package installs and service changes, and Codex's sandbox has
no network and no write access outside the project — both on purpose, and Ferretry does not try to get
around either. The agent hands the person the command instead:

- **Claude Code**: type `! fy daemon update` in the chat. A `!` command runs as you, not as the
  agent, so nothing blocks it, and its output lands in the conversation for the agent to read.
- **Codex**: run `fy daemon update` in your own terminal.
- **Either**: press **Update** in the app.

`fy setup` and `fy setup --check --json` report an available update (`update.available`,
`update.command`) but never apply one: an update restarts the daemon, which is its own decision. The
[Get started](https://ferretry.pages.dev/get-started) prompt tells the agent all of this.

## The app

- Settings › Machines › _machine_ › Machine › **About**: this machine's version, how it was installed,
  the latest release and when it was checked, **Update available vX → vY** with the changelog, the
  Update button or the steps, the automatic-install setting, and the last update's outcome.
- A small dot on the machine menu when that machine has an update.
- The app's own version beside the machine's, with a warning when they differ (a different version
  is a different protocol, see `version-skew.ts`).
- **App updated**: after the signed service worker swaps to a new release, the next load says
  "Ferretry updated to vX" once ([pwa-release-signing.md](pwa-release-signing.md)).

## Surface

| surface                                | what                                                     |
| -------------------------------------- | -------------------------------------------------------- |
| `fy daemon status`                     | adds the install method and, when known, the update line |
| `fy daemon update [--check] [--yes] …` | check, or apply the update for this install method       |
| `fy daemon restart [--when-idle]`      | restart now (ferrets keep running), or once all are idle |
| `fy daemon install`                    | on a `nix-shell` daemon, offers the nix profile install  |
| `fy setup [--check] [--json]`          | reports the update and its command; never applies it     |
| `GET /v1/daemon/update`                | the `DaemonUpdateView`                                   |
| `POST /v1/daemon/update`               | start an update (`now` / `when-idle`)                    |
| `PATCH /v1/daemon/update/settings`     | turn automatic install on or off                         |

## Declared GAPs

- Homebrew updates cannot be rolled back automatically (Homebrew keeps no previous cask).
- The standalone path refuses until the owner sets up the release key above.
- `apt`/`dnf` and module installs show steps; they never self-update.

## Updating Claude Code and Codex

How a machine shows, and updates, the `claude` and `codex` its ferrets run. Read this before changing
`GET`/`POST /v1/harnesses/update`, `fy harness`, or Settings › Machines › _machine_ › Machine ›
**Agent CLIs**.

### The one-sentence version

**The daemon finds the exact file a runtime launches for each harness, works out how that file was
installed with the daemon's own rules, asks npm for the newest version only when somebody looks, and
updates it with that install method's own tool — never past the version Ferretry verified without an
explicit yes, and never on a timer.**

### Which file, and how it was installed

- **Which file** is the ONE harness resolution rule ([harness-paths.md](harness-paths.md)):
  `FY_CLAUDE_BIN` / `FY_CODEX_BIN`, `harness.paths`, the declared search paths, then `PATH`. It is the
  file the wrapper `exec`s, so it is the one a new ferret runs; the panel names the rule that chose it.
- **How it was installed** reuses the daemon's own detection, not a copy of it: the same link-chain
  walk (`executableNixFacts` in `packages/daemon/src/adapters/update/install-facts.ts`), the same
  `nix profile list --json` reading, the same store-path rule (`classifyNixStorePath`) and the same
  module steps (`nixModuleUpdate`) in `packages/protocol/src/lib/daemon-update.ts`.
  `classifyHarnessInstall` (`packages/protocol/src/lib/harness-update.ts`) adds only what a harness has
  and the daemon does not.

| method             | recognised by (on the resolved path unless said)                                      | update                                                              | rollback                         |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Homebrew cask      | `…/Caskroom/<cask>/`                                                                  | **self**: `brew update`, `brew upgrade --cask <cask>`               | none (declared GAP)              |
| nix profile        | a store path reached through the user's profile, held by a profile element            | **self**: `nix profile upgrade --refresh <element>`                 | `nix profile rollback`           |
| nix shell          | the launched path is itself a store path                                              | **manual**: `nix profile install nixpkgs#<attr>`                    | —                                |
| Nix module         | home-manager / nix-darwin / NixOS, told apart exactly as for the daemon               | **manual**: `nix flake update nixpkgs`, then the ONE switch command | —                                |
| npm global         | `…/lib/node_modules/<package>/` — the prefix is reported, and nvm/fnm/asdf/mise named | **self**: `<prefix>/bin/npm install -g --prefix <prefix> <pkg>@<v>` | the same install of the previous |
| pnpm / Bun / Volta | `pnpm/global`, `.bun/install/global`, or a launched path under `.volta`               | **self**: `pnpm add -g`, `bun add -g`, `volta install` `<pkg>@<v>`  | the same install of the previous |
| Homebrew formula   | `…/Cellar/<formula>/`                                                                 | **self**: `brew update`, `brew upgrade <formula>`                   | none                             |
| Claude installer   | `~/.local/share/claude/…` (Claude Code only)                                          | **self**: `claude update`, or `claude install <v>` for a chosen one | `claude install <previous>`      |
| standalone         | anything else                                                                         | **manual**: Claude's `install.sh`, or Codex's release / npm         | —                                |

**A store path is asked before the npm layout**, because nixpkgs' `claude-code` is itself a
`lib/node_modules/@anthropic-ai/claude-code` inside the store. A module install reports the flake
steps and never runs them: the pin is in somebody's own configuration. The package names are spelled
once, in `HARNESS_PACKAGES`, which the tool install (`fleet/tool-install.ts`) reads too.

### Verified versions

**Verified** means the harness contract guard (`packages/fleet/tests/contract`) measures that exact
version in every build — the `claude-code` and `codex` of the flake's locked nixpkgs.
`VERIFIED_HARNESS_VERSIONS` in `packages/protocol/src/lib/harness-update.ts` is the owner, and
`run.sh pinned` fails when what it measured is not that constant, so a `flake.lock` bump that moves the
pin moves the constant in the same change. Codex 0.163, for example, is newer than the 0.145.0 pin and
changed the trust screens (#621): it reads **Not yet verified by Ferretry**, with a link to the guard's
README.

- An update **past** the verified version needs an explicit yes: a second question in the app
  ("Update anyway"), `--allow-unverified` for `fy harness update` (**`--yes` never implies it**), and
  `confirmUnverified: true` on the route, which otherwise answers `409 harness_update_unverified` with
  both versions.
- A method that installs a chosen version (npm, pnpm, Bun, Volta, Claude's installer) is offered the
  verified version as the primary button, beside the newest. Homebrew and nix install what they have,
  so they get one Update — and when Ferretry cannot know what that will be, it asks the same question.

### Knowing the newest version

- **Source**: npm's `latest` dist-tag for `@anthropic-ai/claude-code` / `@openai/codex`, where both
  publish first. Homebrew and nixpkgs follow it, sometimes days later, which a result says
  ("This install method does not have 0.163.0 yet").
- **When**: only when somebody looks — `GET /v1/harnesses/update` (the panel opening, the Machines
  list's update dot on a Settings visit, `fy harness status`). An answer is reused for five minutes.
  **There is no timer and no boot check**, and `FY_UPDATE_CHECK=off` switches the ask off.
- **The installed version** comes from running the located file's `--version` with a throwaway `HOME`
  and every proxy pointed at a port nothing listens on, so it can read no login and reach no network.
  This is the one place the daemon runs a harness outside a session, and only on a look.

### Applying an update

The daemon runs it **in-process**: replacing a harness restarts nothing, so there is no restart to
outlive. One update per harness at a time (`409 harness_update_in_progress`).

1. **Check** the method can update itself, the target is newer, and — past the verified version — the
   yes was given.
2. **Run** the method's commands with the package manager this daemon can find (an npm prefix's own
   `npm` first), no stdin and no `sudo`; a manager that needs admin rights is handed back with its
   command.
3. **Verify**: the located file's `--version` must read, and `--help` must exit 0 offline. A pinned
   method must have installed at least the version asked for; a newer one is accepted and said.
4. **Roll back** where the method allows: the previous version through the same tool, or
   `nix profile rollback`, then verify again.
5. **Report** honestly: `succeeded`, `unchanged` (the method had nothing newer), `rolled-back` or
   `failed`, in one sentence that always says **running ferrets keep the version they started with
   until they are restarted**.

### Surface

| surface                                                                               | what                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `fy harness status [--json]`                                                          | each harness: path and rule, method, version, verified, newest |
| `fy harness update [claude\|codex] [--to <v>\|verified] [--yes] [--allow-unverified]` | update one or both, waiting for the outcome                    |
| `GET /v1/harnesses/update`                                                            | the `HarnessUpdateView`; asks npm when the last answer is old  |
| `POST /v1/harnesses/update`                                                           | start one harness's update                                     |
| Settings › Machine › **Agent CLIs**                                                   | the same, with the update dot on the machine list              |

Governance is the daemon update's own (`ownerOnly`): `fleet` `use` to read, `configure` plus a passkey
step-up from a remote device to start, and never a ferret. The start is audited as `security.changed`
(`harness-update`).

### Declared GAPs

- Homebrew keeps no previous version, so a broken Homebrew harness update cannot be rolled back.
- The last outcome lives in memory: a daemon restart forgets it (the update itself is unaffected).
- A Homebrew or nix update cannot be pinned to the verified version; it installs what that source has.
- Codex standalone binaries are shown steps, not updated: Ferretry does not download harness binaries.
