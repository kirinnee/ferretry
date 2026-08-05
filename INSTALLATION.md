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

Ferretry currently holds one Nix root per daemon, not one per retained snapshot. That root can
protect at most one Nix-backed snapshot source closure. Promotion alone leaves it unchanged; a
managed `install`, `start`, or `restart` that actually launches a Nix-backed snapshot repoints it,
while a non-Nix launch leaves any older root in place until uninstall. An older Nix-backed snapshot
therefore keeps its copied executable but not necessarily its interpreter and runtime closure after a
later garbage collection. Reliable post-GC rollback of those older snapshots remains a gap until
roots are retained per snapshot.

Independent lifecycle commands are not yet guarded by a daemon-keyed interprocess lock. Do not run
`install`, `start`, or `restart` concurrently: their service-definition update and the single GC-root
update can otherwise interleave. Serializing those commands remains part of handover item #31.

## Daemon snapshots

The daemon never launches the executable currently being edited or replaced on `PATH`. Ferretry
copies it into a daemon-keyed, content-addressed store at
`$XDG_STATE_HOME/ferretry/daemon-snapshots/fyd` (`~/.local/state/…` by default), verifies the complete
copy and a strict manifest, makes the artifact, manifest, and containing snapshot directory read-only,
and atomically points `current` at the selected snapshot. A managed launch captures that verified
snapshot and executes its exact canonical artifact path, so a later promotion cannot change the
process being started. `fy daemon install` and any start or restart that needs an executable build and
promote the first snapshot only when both `current` and the durable promotion marker are absent. Once
promotion has occurred, a missing pointer is damaged state, not a fresh store; malformed, dangling,
mutable, or digest-damaged evidence likewise fails closed. An explicit promotion of a verified
retained ID repairs a lost pointer without live `fyd`.

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

Promotion is atomic and does not alter the process already running. The selected artifact is used by
the next managed launch; rollback uses the same path: promote an older ID shown by `snapshot list`,
then restart. Listing, promotion, and launches from a retained snapshot do not require the original
source executable. Restart verifies the promoted artifact before stopping the incumbent, so damaged
snapshot state fails without manufacturing downtime.

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
