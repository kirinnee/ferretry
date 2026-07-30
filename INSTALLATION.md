# Installing the CLI

The product is **ferretry**; the CLI binary is **`fy`**. It ships as a standalone binary
(no Bun/Node runtime required). Supported targets: linux amd64, linux arm64, macOS arm64
(no Intel mac).

> **macOS caveat — unsigned binaries.** The binaries are not code-signed. On macOS, Gatekeeper
> quarantines them on first run. The Homebrew cask clears the quarantine attribute automatically;
> for manual installs run:
>
> ```bash
> xattr -d com.apple.quarantine "$(command -v fy)"
> ```

## Debian / Ubuntu (apt)

Releases push `.deb` packages to the `kirinnee` Gemfury repository:

```bash
echo "deb [trusted=yes] https://apt.fury.io/kirinnee/ /" | sudo tee /etc/apt/sources.list.d/fury.list
sudo apt update
sudo apt install fy
```

## Fedora / RHEL / CentOS (yum)

The same releases push `.rpm` packages to the matching Yum repository:

```bash
sudo tee /etc/yum.repos.d/fury.repo <<'EOF'
[fury]
name=Gemfury kirinnee
baseurl=https://yum.fury.io/kirinnee/
enabled=1
gpgcheck=0
EOF
sudo dnf install fy
```

## Homebrew (macOS)

The cask lives in this repo (no separate tap repository); the `ferretry` cask installs the `fy`
binary:

```bash
brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry
brew install --cask ferretry
```

## GitHub release (one-line installer)

Downloads the right archive for your OS/arch, verifies the checksum, and installs `fy` to
`~/.local/bin` (override with `BIN_DIR`):

```bash
curl -fsSL --connect-timeout 30 --max-time 600 https://github.com/kirinnee/ferretry/releases/latest/download/install.sh | bash
```

Or grab a specific archive manually from the
[releases page](https://github.com/kirinnee/ferretry/releases) — `fy_<os>_<arch>.tar.gz` —
verify it against `checksums.txt`, and extract the `fy` binary onto your `PATH`.

## Verify

```bash
fy --version
fy --help
```
