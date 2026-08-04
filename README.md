<!-- The wordmark ships in two inks and GitHub picks by the reader's theme: a
     single image would be near-invisible for half of them. Both files are
     committed under `docs/brand/fleet-grid/` — no external image host. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/fleet-grid/png/wordmark-dark-960.png">
  <img src="docs/brand/fleet-grid/png/wordmark-960.png" alt="Ferretry" width="360">
</picture>

# ferretry

Personal agent-orchestration product: a per-host daemon, one PWA, and a single CLI binary
(**`fy`**; the daemon will be `fyd` later). This repo is a Bun-workspaces monorepo scaffolded
from the diene `bun-cli` conventions.

> **Two-name model.** The PRODUCT name (`ferretry`) lives in the root `package.json` `name`
> field; the BINARY name (`fy`) lives in the `bin` key of `packages/cli/package.json`. Taskfile
> vars, compile, goreleaser shim, and smoke scripts all derive the binary name with
> `jq -r '.bin | to_entries[0].key'`. To change either, run
> `scripts/local/rename.sh --product <name>` and/or `--bin <name>`; nothing else hardcodes them.

## Layout

| Path                | What                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `packages/cli`      | The CLI binary (commander composition root, three-layer dirs)                  |
| `packages/protocol` | Placeholder — zod schemas + typed client SDK (P1)                              |
| `packages/daemon`   | Placeholder — the per-host daemon (P1)                                         |
| `packages/fleet`    | Placeholder — fleet management library + subcommands (P1)                      |
| `packages/pwa`      | Placeholder — the web app (P1)                                                 |
| `packages/relay`    | Rendezvous protocol + the metered hosted Workers relay (and a self-hosted one) |
| `scripts/release`   | Compile, GoReleaser shim, publish, smoke, installer, bump                      |
| `scripts/validate`  | Repo invariants run by pre-commit                                              |
| `Casks/`            | Homebrew cask, committed in-repo by GoReleaser on release                      |

## Development

Everything runs inside the nix devshell (direnv loads it automatically):

```bash
task setup          # install locked dependencies
task check          # typecheck
task lint           # every pre-commit gate
task test           # unit + integration + SIT (compiled binary)
task compile        # the 3 standalone binaries into dist/bin/
task preview -- --help
```

## Connecting to a daemon

The browser tries a **direct** connection first and falls back to Ferretry's **hosted relay** when
the daemon has no inbound route. Neither is a question anyone is asked during setup, and the live
carrier is always named on screen. [docs/relay-protocol.md](docs/relay-protocol.md) is the wire
contract and the disclosure of what a relay operator can and cannot observe.

Running a relay of your own is supported but is an **expert opt-in path**, not part of setup:
[docs/cloudflare-relay-self-hosting.md](docs/cloudflare-relay-self-hosting.md) is the runbook.

## Releasing

- CI green on `main` → `release.yaml` runs semantic-release → tags `vX.Y.Z`.
- The tag triggers `cd.yaml` → GoReleaser publishes the GitHub release, archives, checksums,
  the curl|bash installer, and commits the Homebrew cask into `Casks/` in this repo.
- Offline dry run of the whole pipeline: `./scripts/release/publish.sh --snapshot`.

See [INSTALLATION.md](INSTALLATION.md) for the user-facing install channels.
