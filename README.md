# pitwall (working name)

Personal agent-orchestration product: a per-host daemon, one PWA, and a single CLI binary.
This repo is a Bun-workspaces monorepo scaffolded from the diene `bun-cli` conventions.

> **The name is a placeholder.** The `bin` key in `packages/cli/package.json` is the ONLY
> source of the product name — Taskfile vars, compile, goreleaser shim, and smoke scripts all
> derive it with `jq -r '.bin | to_entries[0].key'`. To rename the product, run
> `scripts/local/rename.sh <new-name>` and rename the repo; nothing else hardcodes it.

## Layout

| Path                | What                                                          |
| ------------------- | ------------------------------------------------------------- |
| `packages/cli`      | The CLI binary (commander composition root, three-layer dirs) |
| `packages/protocol` | Placeholder — zod schemas + typed client SDK (P1)             |
| `packages/daemon`   | Placeholder — the per-host daemon (P1)                        |
| `packages/fleet`    | Placeholder — fleet management library + subcommands (P1)     |
| `packages/pwa`      | Placeholder — the web app (P1)                                |
| `scripts/release`   | Compile, GoReleaser shim, publish, smoke, installer, bump     |
| `scripts/validate`  | Repo invariants run by pre-commit                             |
| `probes/`           | Self-verification probe definitions (gate/smoke/presence)     |
| `Casks/`            | Homebrew cask, committed in-repo by GoReleaser on release     |

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

## Releasing

- CI green on `main` → `release.yaml` runs semantic-release → tags `vX.Y.Z`.
- The tag triggers `cd.yaml` → GoReleaser publishes the GitHub release, archives, checksums,
  the curl|bash installer, and commits the Homebrew cask into `Casks/` in this repo.
- Offline dry run of the whole pipeline: `./scripts/release/publish.sh --snapshot`.

See [INSTALLATION.md](INSTALLATION.md) for the user-facing install channels.
