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

A `nix shell` leaves the executables in the Nix store with nothing holding them. The daemon runs from
a copied snapshot outside the store, but that binary can still name a Nix-store ELF interpreter,
RPATH, or script interpreter. `fy daemon install`, `start`, and `restart` therefore read the verified
snapshot manifest and pin the Nix output containing its `sourceBinary`. The indirect root lives at
`$XDG_STATE_HOME/ferretry/nix/fyd` (`~/.local/state/…` when that is unset), and `fy daemon uninstall`
releases it. This is a per-user operation and needs no `sudo`. If `nix-store` is unavailable, the
daemon still starts and `fy` warns that garbage collection may remove runtime dependencies; a
Homebrew or release-archive source is outside the store and is left alone.

Ferretry currently holds one Nix root per daemon, not one per retained snapshot. Promotion leaves
that root on the running version until restart, then moves it to the newly selected version. An older
Nix-backed snapshot therefore keeps its copied executable but not necessarily its interpreter and
runtime closure after a later garbage collection. Reliable post-GC rollback of those older snapshots
remains a gap until roots are retained per snapshot.

## Daemon snapshots

The daemon never launches the executable currently being edited or replaced on `PATH`. Ferretry
copies it into a daemon-keyed, content-addressed store at
`$XDG_STATE_HOME/ferretry/daemon-snapshots/fyd` (`~/.local/state/…` by default), verifies the complete
copy and a strict manifest, makes both read-only, and atomically points `current` at the selected
snapshot. `fy daemon install` and any start or restart that needs an executable build and promote the
first snapshot only when that pointer has never existed. Malformed, dangling, or digest-damaged state
is an error and is never treated as a fresh store.

Build and inspect a candidate without changing the next daemon launch:

```bash
fy daemon snapshot build
fy daemon snapshot list
fy daemon snapshot list --json
```

Promote a verified candidate, then restart when you are ready to roll it out:

```bash
fy daemon snapshot promote sha256-<digest>
fy daemon restart
```

Promotion is atomic and does not alter the process already running. Rollback uses the same path:
promote an older ID shown by `snapshot list`, then restart. Restart verifies the promoted artifact
before stopping the incumbent, so damaged snapshot state fails without manufacturing downtime.

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
