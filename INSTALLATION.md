# Installing the CLI

The product is **ferretry**; it ships the **`fy`** CLI, the **`fyd`** per-host daemon and the daemon's
**`fyd-browser-worker`** as standalone binaries (no Bun/Node runtime required). Supported targets: linux amd64, linux arm64,
macOS arm64 (no Intel mac).

> **macOS caveat — unsigned binaries.** The binaries are not code-signed. On macOS, Gatekeeper
> quarantines them on first run. The Homebrew cask clears the quarantine attribute automatically;
> for manual installs run:
>
> ```bash
> xattr -d com.apple.quarantine "$(command -v fy)"
> ```

## Quick start

Install with the method you already use, then run `fy setup`. It installs the daemon as a user
service (launchd on macOS, systemd on Linux), checks its health, version, updates and relay, and ends
by offering the QR code for your phone. It is safe to run again: a daemon already running under its
service manager is left alone.

Homebrew (macOS):

```bash
brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry
brew install --cask ferretry
fy setup
```

nix profile (macOS or Linux):

```bash
nix profile install github:kirinnee/ferretry
fy setup
```

Home Manager or nix-darwin: add the flake input and the package to your configuration (pass `inputs`
to Home Manager through `extraSpecialArgs` if you have not already), then rebuild:

```nix
inputs.ferretry.url = "github:kirinnee/ferretry";
home.packages = [ inputs.ferretry.packages.${pkgs.stdenv.hostPlatform.system}.default ];
```

```bash
home-manager switch --flake .
fy setup
```

On nix-darwin, rebuild with this instead (it asks for your password):

```bash
darwin-rebuild switch --flake .
```

The one-line installer (any Mac or Linux) puts both programs in `~/.local/bin`:

```bash
curl -fsSL --connect-timeout 30 --max-time 600 https://github.com/kirinnee/ferretry/releases/latest/download/install.sh | bash
PATH="$HOME/.local/bin:$PATH" fy setup
```

### What `fy setup` does

| Flag      | Effect                                                                             |
| --------- | ---------------------------------------------------------------------------------- |
| (none)    | Asks before installing the daemon, then offers the pairing QR at the end.          |
| `--yes`   | Installs without asking. Required when there is no terminal. Shows no QR.          |
| `--check` | Changes nothing: reports what is there and what setup would do.                    |
| `--json`  | Prints a summary an agent can read (`ready`, `daemon`, `update`, `relay`, `next`). |

Exit status: `0` ready, `1` not running, `2` waiting for you (no terminal and no `--yes`, or you said
no). It never updates or restarts a running daemon; it names `fy daemon update` when a release is
out. The JSON has no field for a pairing code or a token: pairing is always `fy pair`, run by a
person in their own terminal.

```bash
fy setup --check
fy setup --yes
PATH="$HOME/.local/bin:$PATH" fy setup --yes
```

### Setting up with an agent

The [Get started](https://ferretry.pages.dev/get-started) page has a prompt for Claude Code or Codex.
The agent only **looks** (`uname -sm`, `command -v …`, `fy setup --check --json`), recommends one
install method, and hands **you** each command to run — in Claude Code by typing it after `!` in the
chat, in Codex in your own terminal. It never installs, updates or uses `sudo` itself, so Claude
Code's auto-mode safety checks and Codex's sandbox never block it halfway: those checks exist to stop
an agent changing your system on its own, and here it does not. Pairing (`fy pair`) always runs in
your own terminal so the code never reaches the agent.

## Debian / Ubuntu (apt)

Releases push `.deb` packages to the `kirinnee97` Gemfury repository:

```bash
echo "deb [trusted=yes] https://apt.fury.io/kirinnee97/ /" | sudo tee /etc/apt/sources.list.d/fury.list
sudo apt update
sudo apt install fy
```

## Fedora / RHEL / CentOS (yum)

The same releases push `.rpm` packages to the matching Yum repository:

```bash
sudo tee /etc/yum.repos.d/fury.repo <<'EOF'
[fury]
name=Gemfury kirinnee97
baseurl=https://yum.fury.io/kirinnee97/
enabled=1
gpgcheck=0
EOF
sudo dnf install fy
```

## Homebrew (macOS)

The cask lives in this repo (no separate tap repository) and installs `fy`, `fyd` and `fyd-browser-worker`:

```bash
brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry
brew install --cask ferretry
```

## Nix

The default flake package installs both executables:

```bash
nix profile install github:kirinnee/ferretry
```

Running straight from an ephemeral shell is also supported:

```bash
nix shell github:kirinnee/ferretry
```

A `nix shell` leaves the executables in the Nix store with nothing holding them, and a user service
has to record an absolute path — so the path a unit file names is exactly the path a later
`nix-collect-garbage` can delete, after which the service stops launching at login with nobody there
to read the error. `fy daemon install`, `start`, and `restart` therefore resolve the installed `fyd`,
classify what it really points at, and pin the Nix output containing it. The indirect root lives at
`$XDG_STATE_HOME/ferretry/nix/fyd` (`~/.local/state/…` when that is unset). This is a per-user
operation and needs no `sudo`. If `nix-store` is unavailable, the daemon still starts and `fy` warns
that garbage collection may remove runtime dependencies; a Homebrew or release-archive install is
outside the store, is left alone, and releases any root an earlier Nix installation left behind.

`fy daemon uninstall` does NOT release the root. Removing supervision does not uninstall the daemon,
and `fy daemon start` still runs that same executable as a direct child; the message names the root
so you can remove it by hand if you are uninstalling Ferretry entirely.

## The browser worker and Chrome

The browser pane and the agents' browser tools run a real Chrome, driven by `fyd-browser-worker`.
Every channel above installs the worker **beside `fyd`** (the archive, the cask, the deb/rpm packages,
the installer and the Nix package all carry it), and the daemon looks for it there — next to the path
it was started from and next to that path with symlinks resolved. A daemon with no worker beside it
says so in one sentence and names the fix: reinstall or upgrade Ferretry.

Chrome itself is not bundled. The daemon finds Google Chrome or Chromium in the usual install
locations, `/snap/bin`, and on its own `PATH`; when there is none, the browser refuses with the one
install command for this machine, for example:

```text
Chrome is not installed on this machine: install it with `brew install --cask google-chrome`, or set FY_CHROME_BIN to its path.
```

`FY_CHROME_BIN` in the daemon's environment points it at any other Chrome; otherwise a real Google
Chrome is preferred over Chromium. The agent browser runs headless by default, so no display server is
required. Browser mode "Real window" ([docs/browser-mode.md](docs/browser-mode.md)) runs it as a real
window instead — for an owner who browses and signs in through it — and on Linux that needs **Xvfb**
(`sudo apt-get install -y xvfb`), which the daemon starts privately on first use.

## cloudflared and the tunnel carrier

The daemon can also be reached through a Cloudflare Tunnel that Ferretry's hosted service provisions
for it ([docs/relay-protocol.md](docs/relay-protocol.md) §15). **The tunnel is opt-in, per machine:** a
daemon runs none until you turn it on, with `fy daemon tunnel on` or in the app under Settings ›
Connection. It applies at once, without a restart; `fy daemon tunnel off` turns it off and releases it,
and `fy daemon tunnel status` (or `fy daemon status`) shows where it is. The daemon runs
**`cloudflared`** for that, and `cloudflared` is a **dependency, never a download**: Ferretry never
fetches a binary itself.

| Install route      | How `cloudflared` arrives                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Homebrew cask      | The cask depends on the `cloudflared` formula, so `brew install --cask ferretry` installs it.                                                                      |
| Nix                | The `fyd` package names the store's own `cloudflared` through `FY_CLOUDFLARED`; nothing to install.                                                                |
| deb / rpm          | Recommended, not required: neither distribution ships it by default. Add [Cloudflare's package repository](https://pkg.cloudflare.com/) and install `cloudflared`. |
| One-line installer | Install `cloudflared` yourself (your package manager, or Cloudflare's releases) so it is on the daemon's `PATH`, or point `FY_CLOUDFLARED` at it.                  |

The daemon looks at `FY_CLOUDFLARED` first (an absolute path to the binary, in the daemon's own
environment — for a service, the unit's or plist's environment) and otherwise searches its `PATH`. A
`FY_CLOUDFLARED` that names nothing runnable is reported as such; the daemon does not fall back to
`PATH` behind your back. Without `cloudflared` the tunnel carrier is simply off — direct and relay
sessions are unaffected — and both the boot log and `fyd --check` say so in one line with the remedy:

```text
tunnel       off — cloudflared is not on this daemon’s PATH, so this daemon has no tunnel carrier — install cloudflared (…) or set FY_CLOUDFLARED to its path, then restart. Ferretry never downloads it itself.
```

`fy daemon tunnel on|off` writes `{ "kind": "tunnel", "source": "discovery", "enabled": true|false }`
into the `carriers` list in `config/daemon.json` for you; it needs the daemon running, and adds nothing
else to the file. A daemon updated from a release where the tunnel came on by itself, and whose file
names no tunnel, releases the tunnel it held on its first boot and says how to turn it back on.

## Updating

```bash
fy daemon update --check   # how this host installed Ferretry, the latest release, what updating takes
fy daemon update           # update the way it was installed, restart, and roll back if it does not come up
```

Homebrew and nix profile installs, and standalone binaries, update themselves: `fy daemon update`
runs `brew update` then `brew upgrade --cask ferretry`, or `nix profile upgrade`, restarts the daemon, and checks that the
new version serves within 30 seconds — rolling back the nix profile or the previous binary when it does
not. A daemon running from a temporary `nix shell` is offered a switch to a nix profile install, which
fixes updates for good (`fy daemon update --switch-to-profile`; `fy daemon install` offers the same).
home-manager, nix-darwin, NixOS and apt/dnf installs are shown the exact steps instead: their version
is pinned by your own configuration, or needs `sudo`.

If a Homebrew update does not land the latest version, refresh the tap and upgrade by hand:

```bash
brew update && brew upgrade --cask ferretry && fy daemon restart
```

If the tap is wedged, remove it and install again:

```bash
brew untap kirinnee/ferretry && brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry && brew reinstall --cask ferretry
```

`fy daemon status` says how the daemon was installed and when an update is available, and the app
shows the same under Settings › Machines › About with a one-click Update. The whole design, including
the standalone signing setup, is [docs/updating.md](docs/updating.md).

## Which daemon runs

Ferretry runs the `fyd` this host has installed. `fy daemon install`, `start` and `restart` resolve it
— `FY_DAEMON_BIN` first, then `PATH` — and record that absolute path in the systemd unit or launchd
agent. Upgrading is your package manager's job; `fy daemon restart` picks the new one up. Rolling back
is the same operation in reverse: install the version you want and restart. `fy daemon update` does
both for you where the install method allows it (see [Updating](#updating)).

```bash
fy daemon which           # installed and running identities, and whether they agree
fy daemon which --json
```

`fy daemon start` and `fy daemon status` say so when the daemon already serving is an older version
than the installed one, and never act on it — a `start` that killed a working daemon to apply an
upgrade nobody asked for is a worse surprise than the stale version.

`FY_DAEMON_BIN` must be an absolute path. A relative one is refused when you type the command rather
than at the next boot, because `systemd` fails such a unit with 203/EXEC and `launchd` behaves the
same way.

### One owner per host

Once a systemd unit or launchd agent is installed, it is the only thing that runs `fyd`. A daemon
answering for the state home that the service manager did not start — typically one `fy daemon start`
spawned before the first `fy daemon install` — holds the state home's lock, so the manager's own
daemon exits at once (systemd marks the unit `failed`, status 78) while the stray serves unsupervised.

`fy daemon status` reports that as serving **outside** systemd or launchd and names the remedy.
`install`, `start`, `restart` and `stop` hand it over: they stop the stray the way a direct child is
stopped (only once it is proved to hold this state home's lock) and then let the manager own the
daemon. On systemd, `fy daemon restart` is one `systemctl --user restart` after rewriting the unit.

```bash
fy daemon status          # "serving, but OUTSIDE systemd" when a stray holds the state home
fy daemon restart         # stops the stray, then systemd starts its own
```

### Upgrading from a release with the daemon snapshot store

Earlier releases copied `fyd` into a content-addressed store under
`$XDG_STATE_HOME/ferretry/daemon-snapshots/fyd` and launched the copy, with `fy daemon snapshot
build|list|promote` to manage it. Every property that store added — content addressing, verification,
immutability, an atomic pointer, rollback — is one `/nix/store` already provides for a Nix
installation and one your package manager owns for every other, so it is gone, and so are those three
verbs.

Nothing you have to do. The first `fy daemon install`, `start`, `restart` or `uninstall` after the
upgrade records the installed executable's absolute path, and only then removes the store and its
per-snapshot Nix roots — roughly 100MB on a host that used it. It says what it removed. If the removal
fails it says that too, names the directory, and carries on: nothing reads it any more, so it is safe
to delete by hand.

## GitHub release (one-line installer)

Downloads the right archive for your OS/arch, verifies the checksum, and installs both `fy` and
`fyd` to `~/.local/bin` (override with `BIN_DIR`):

```bash
curl -fsSL --connect-timeout 30 --max-time 600 https://github.com/kirinnee/ferretry/releases/latest/download/install.sh | bash
```

Or grab a specific archive manually from the
[releases page](https://github.com/kirinnee/ferretry/releases) — `fy_<os>_<arch>.tar.gz` —
verify it against `checksums.txt`, and extract both binaries onto your `PATH`.

## Daemon credential

On first boot, `fyd` issues a local API token at `${FY_HOME:-~/.ferretry}/api-token` with
owner-only permissions. `fy` reads that token automatically for local commands. Set `FY_TOKEN`
to explicitly override it for a remote daemon or CI; `FY_HOME` changes the local token path for
both programs.

## Verify

```bash
fy --version
fy --help
fyd --version
```

## First run

A few commands take you from a fresh install to a phone watching an agent work. Install `claude`
(Claude Code) or `codex` first, and `tmux`, which runs each session — 3.7 or newer. tmux 3.6 and older
can crash their whole server, ending every session at once, when one session ends; `fy doctor` says
which release you run. To move to a newer tmux, install it and let the running server end on its own
(after the last session, or at the next restart): never kill it to switch.

1. **Start the daemon.**

   ```bash
   fy setup
   ```

   This installs a user service (launchd on macOS, systemd on Linux), starts the daemon under it, and
   brings it back after a restart, then checks it (see [What `fy setup` does](#what-fy-setup-does)).
   It runs `fy daemon install` for you; `fy daemon start` runs the daemon once without a service
   instead.

   Starting the daemon sets nothing up by itself. A new machine is **not set up** until you choose
   what to bring in. `fy doctor` checks what else the
   host is missing, and says what each missing program stops.

2. **Set the machine up.** Ferretry asks, one question at a time, whether to use what it found:

   > We found Claude Code on _this machine_. Use your login and setup? **Import** · **Skip**

   Import brings in your own instructions, settings, MCP servers and skills, shares your existing
   login in place (it is never copied), and creates one **runtime** for each tool you import,
   `claude-default` and `codex-default`. Skip both and nothing is set up; you can come back any time.

   Answer it in whichever place suits you:
   - **In the app.** Pair your phone (step 4) and the app opens these questions by itself. A tool
     that is installed but not signed in offers **Sign in now** right there.
   - **In the terminal.** `fy daemon setup` asks the same questions.
   - **In a script**, with no questions: `fy daemon import claude` or `fy daemon import codex`. Add
     `--name <runtime>` to name the runtime yourself.

   `fy runtimes` lists what was made.

3. **Check the logins.**

   ```bash
   fy credentials
   ```

   This shows each login's status (**Ready**, **Refresh due**, **Needs sign-in** or **Checking**)
   and its usage, without running a model, so it costs nothing. Your own `claude` and `codex` logins
   are shared with Ferretry rather than copied: signing out in one signs out the other. **Refresh
   due** needs nothing from you; the login renews itself the first time it is used.

   A login that shows **Needs sign-in** is fixed with one command, such as
   `fy credential signin <id>`. That one sign-in covers every runtime that uses the login. You can
   do the same from the browser: Settings → **Machines** → your machine → **Credentials**.

4. **Pair your phone.**

   ```bash
   fy pair
   ```

   Scan the QR code with your phone's camera. The code lasts two minutes and works once. The phone
   does not need to reach this machine directly: when it cannot, it pairs through Ferretry's hosted
   relay, which never sees the code or anything you send. There is no password to set first: the phone
   registers a passkey, and the dangerous acts it can do later ask for that passkey. If the machine is not set up yet, the app
   asks step 2's questions as soon as the phone is paired.

   `fy pair` waits up to two minutes for the scan. From a script or an agent, `--no-wait` prints the
   QR code and the link and exits instead:

   ```bash
   fy pair --no-wait
   ```

   When you are sitting at this machine, add `--open` to hand the link to its browser too:

   ```bash
   fy pair --open --no-wait
   ```

5. **Start a session** on an agent runtime (the ones the setup made are):

   ```bash
   fy start --agent claude-default "your task"
   fy ps
   ```

   Add `--mode interactive` for a session you drive yourself, and `fy attach <id>` to open it in this
   terminal. A runtime that is not an agent runtime cannot run sessions; asking for it says so. Make one
   with `fy runtime set <name> --agent`.

The hosted app at `https://ferretry.pages.dev` is the only browser origin a daemon accepts by default.
If you serve the PWA yourself, add that page's origin to `corsOrigins` in
`${FY_HOME:-~/.ferretry}/config/daemon.json` and restart the daemon, or the browser's requests are
refused.

## Troubleshooting

Whether the daemon is serving, and what supervises it:

```bash
fy daemon status
```

It says one of:

- **serving**: everything answers. A recent event-loop stall is shown with the work it happened during,
  and where the code spent the time.
- **starting**: the daemon is booting. It names the step and how long that step has taken. A step
  that runs for minutes is called stuck, with the restart command.
- **busy**: its liveness check answered but its full health report did not in time.
- **wedged**: the process exists but answered nothing. Run `fy daemon restart`. A daemon whose event
  loop stops for five minutes also ends itself, so systemd or launchd can start a fresh one.
  (`FYD_WATCHDOG_SECONDS` changes that limit; `0` switches it off.) A computer that was asleep does
  not count as a stopped loop.
- **stopped**: no daemon process is running.

The same facts without the CLI: `curl -s -m 2 http://127.0.0.1:7431/healthz`. It answers from the
moment the daemon binds its address, with HTTP 503 and the boot step while starting, and 200 after.

The daemon's log (add `--follow` to keep streaming it). It names every boot step, and every stall
longer than a quarter of a second with the work that was running and the code it was in:

```bash
fy daemon logs
```

Two settings for the daemon's environment:

- `FYD_BACKGROUND_DELAY_SECONDS`: how long after it starts serving the daemon waits before its
  background work (analytics, usage refresh, cleaning up finished terminals). The default is `120`.
  That work then runs one job at a time.
- `FYD_STACK_SAMPLER=0`: stop sampling where stalls happen. Sampling costs a few percent of CPU, and
  only while the daemon is busy.

macOS refuses to open `fy` or `fyd`: the binaries are not code-signed. The Homebrew cask clears the
quarantine flag for you; after any other install, clear it once:

```bash
xattr -d com.apple.quarantine "$(command -v fy)"
```

`fy attach` refuses with "the live pane no longer matches the daemon attach proof": the message lists
which check failed (tmux session, pane id, pid, or process start identity). If the session is running
and you just need its terminal, attach to the daemon's private tmux server yourself. Its socket is
`tmux.sock` in the state home and the tmux session is `fy-` followed by the session id:

```bash
tmux -S "${FY_HOME:-$HOME/.ferretry}/tmux.sock" attach -t fy-<session-id>
```

Detach with `Ctrl-b d`, which leaves the agent running.

Start over completely. This removes ALL of Ferretry's data on this machine — configuration, sessions
and transcripts, stored secrets and paired devices — after listing what will go and asking first:

```bash
fy daemon reset
```

The landing page's `/get-started` guide (`packages/pwa/get-started/index.html`) shows commands from
this document, and its "Let your agent set it up" prompt is assembled from those same lines in the browser. Every command it shows must appear here, in a fenced block, exactly as written —
`scripts/validate/cli-contracts.sh installation-parity` refuses one that does not, so change a
command here first.
