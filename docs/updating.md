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
- **When**: once at boot, then at most every six hours. A version compare only — nothing is
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
2. **Wait for idle**, or ask: a daemon with a ferret mid-turn is not restarted without consent (see
   below).
3. **Upgrade** with the method's own tool (`brew`, `nix profile`) or, for a standalone binary, by
   downloading and verifying the release archive.
4. **Restart** through the service manager, exactly as `fy daemon restart` does.
5. **Health check**: `/healthz` must report the target version within 30 seconds.
6. **Roll back** when it does not: `nix profile rollback`, or putting the previous standalone binary
   back, then restart again and confirm the previous version serves.
7. **Report** the outcome. The new daemon reads the report file and shows it in the app.

Homebrew keeps no previous cask version, so a failed Homebrew update cannot be rolled back
automatically. That is a declared GAP: the outcome says so and names `fy daemon logs`.

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

- **Never mid-turn.** The daemon knows which ferrets are mid-turn (`turnState: working`). An update
  asked for `now` while any is refuses with the count; the person chooses **Update when idle**
  (the daemon waits, then starts it) or **Update anyway** (`confirmMidTurn`). `fy daemon update` asks
  the same question at a terminal, and `--when-idle` waits.
- **Remote devices** may start an update or change the update setting only with the `fleet`
  capability's `configure` axis **and** a passkey step-up, like loosening a configuration file. A
  remote update downloads and runs new code on the machine, which is at least as much as the acts that
  rule already covers. `fy` at the machine is ungoverned, as everywhere ([grants.md](grants.md)).
- **No auto-update by default.** _Install updates automatically when idle_ is off until somebody turns
  it on. When on, the daemon starts the update only when no ferret is mid-turn, and only for a method
  that can self-update.
- **One update at a time.** A second request while one is running answers `409 update_in_progress`.

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
| `fy daemon install`                    | on a `nix-shell` daemon, offers the nix profile install  |
| `GET /v1/daemon/update`                | the `DaemonUpdateView`                                   |
| `POST /v1/daemon/update`               | start an update (`now` / `when-idle`)                    |
| `PATCH /v1/daemon/update/settings`     | turn automatic install on or off                         |

## Declared GAPs

- Homebrew updates cannot be rolled back automatically (Homebrew keeps no previous cask).
- The standalone path refuses until the owner sets up the release key above.
- `apt`/`dnf` and module installs show steps; they never self-update.
