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

Five commands take you from a fresh install to a phone watching an agent work. Install `claude`
(Claude Code) or `codex` first, and `tmux`, which runs each session.

1. **Start the daemon.**

   ```bash
   fy daemon start
   ```

   If `claude` or `codex` is on your `PATH`, this first start also creates two accounts for each:
   `claude-default` is for using Claude yourself in a terminal, and `claude-auto-default` is the one
   Ferretry runs sessions on (`codex-default` / `codex-auto-default` likewise). `fy fleet ls` lists
   them. `fy doctor` checks what else the host is missing, and says what each missing program stops.

2. **Answer the password question.** At a terminal, the first start offers to set an **operator
   password**. It is not your system or `sudo` password; it is a Ferretry-only secret. Using this
   machine locally never needs it. Pairing a phone or another device does, because a paired device
   can change this machine's settings, so press Enter to skip it for now if you like. With no
   terminal (a script, for example) nothing is asked, and the start prints the command instead. Set
   or replace it at any time with:

   ```bash
   fy daemon password set
   ```

3. **Check the accounts are signed in.**

   ```bash
   fy fleet health
   ```

   This checks every account without running a model, so it costs nothing. If you were already
   signed in to `claude` or `codex` on this machine, the first start copied that login into the new
   accounts. The report then reads like this, leaving out the line under each row that says which
   install its login was copied from:

   ```text
   4 accounts on 2 logins · 4 ready · checked just now

     ○ Codex (default)   READY  renews itself the first time it's used
       this login also covers Codex (default, auto)
     ○ Claude (default)  READY  renews itself the first time it's used
       this login also covers Claude (default, auto)
   ```

   `READY` needs nothing from you. The copied login's short-lived token has usually already expired,
   and it **renews itself the first time it's used**: the first session on that account renews it
   with no browser. Accounts that share a login are shown as one row. A copied Codex login adds one
   more line, `first use signs your own Codex out on this machine — sign it back in once`, because
   that renewal signs out the `codex` you use yourself. Claude shows no such line.

   An account with no login to copy shows `NEEDS LOGIN` and one command to run, such as
   `sign in: fy fleet login <account id>`. That one sign-in covers every account on the same login.

4. **Pair your phone.**

   ```bash
   fy pair
   ```

   Scan the QR code with your phone's camera. The code lasts two minutes and works once. The phone
   does not need to reach this machine directly: when it cannot, it pairs through Ferretry's hosted
   relay, which never sees the code or anything you send.

5. **Start a session** on the account marked `auto`:

   ```bash
   fy start --agent claude-auto-default "your task"
   fy ps
   ```

   Add `--mode interactive` for a session you drive yourself, and `fy attach <id>` to open it in this
   terminal. `claude-default` cannot run sessions; asking for it names the account to use instead.

The hosted app at `https://ferretry.pages.dev` is the only browser origin a daemon accepts by default.
If you serve the PWA yourself, add that page's origin to `corsOrigins` in
`${FY_HOME:-~/.ferretry}/config/daemon.json` and restart the daemon, or the browser's requests are
refused.
