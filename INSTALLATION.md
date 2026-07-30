# Installing the CLI

The CLI ships as a standalone binary (no Bun/Node runtime required). Supported targets:
linux amd64, linux arm64, macOS arm64 (no Intel mac).

> **macOS caveat — unsigned binaries.** The binaries are not code-signed. On macOS, Gatekeeper
> quarantines them on first run. The Homebrew cask clears the quarantine attribute automatically;
> for manual installs run:
>
> ```bash
> xattr -d com.apple.quarantine "$(command -v pitwall)"
> ```

## Homebrew (macOS)

The cask lives in this repo (no separate tap repository):

```bash
brew tap kirinnee/pitwall https://github.com/kirinnee/pitwall
brew install --cask pitwall
```

## GitHub release (one-line installer)

Downloads the right archive for your OS/arch, verifies the checksum, and installs to
`~/.local/bin` (override with `BIN_DIR`):

```bash
curl -fsSL --connect-timeout 30 --max-time 600 https://github.com/kirinnee/pitwall/releases/latest/download/install.sh | bash
```

Or grab a specific archive manually from the
[releases page](https://github.com/kirinnee/pitwall/releases) — `pitwall_<os>_<arch>.tar.gz` —
verify it against `checksums.txt`, and extract the binary onto your `PATH`.

## Verify

```bash
pitwall --version
pitwall --help
```
