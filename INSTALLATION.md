# Installing the CLI

The product is **ferretry**; it ships the **`fy`** CLI and **`fyd`** per-host daemon as
standalone binaries (no Bun/Node runtime required). Supported targets: linux amd64, linux arm64,
macOS arm64 (no Intel mac).

> **macOS caveat — unsigned binaries.** The binaries are not code-signed. On macOS, Gatekeeper
> quarantines them on first run. The Homebrew cask clears the quarantine attribute automatically;
> for manual installs run:
>
> ```bash
> xattr -d com.apple.quarantine "$(command -v fy)"
> ```

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

The cask lives in this repo (no separate tap repository) and installs both `fy` and `fyd`:

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

## Which daemon runs

Ferretry runs the `fyd` this host has installed. `fy daemon install`, `start` and `restart` resolve it
— `FY_DAEMON_BIN` first, then `PATH` — and record that absolute path in the systemd unit or launchd
agent. Upgrading is your package manager's job; `fy daemon restart` picks the new one up. Rolling back
is the same operation in reverse: install the version you want and restart.

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
(Claude Code) or `codex` first, and `tmux`, which runs each session.

1. **Start the daemon.**

   ```bash
   fy daemon start
   ```

   Starting the daemon sets nothing up by itself. A new machine is **not set up** until you choose
   what to bring in, and the start ends with one line saying so. `fy doctor` checks what else the
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
