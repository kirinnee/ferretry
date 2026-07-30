# Workspace agent guide

Use the repository's nix shell for every command (`direnv exec . <cmd>` or the loaded devshell).
This file is a pure index — the linked documents own their subjects.

## Non-negotiable invariants

- **Name single-sourcing**: the `bin` key in `packages/cli/package.json` is the only place the
  product name is written. Scripts, Taskfiles, and tests derive it (`jq -r '.bin | to_entries[0].key'`).
  Renames go through `scripts/local/rename.sh <new-name>` — never hand-sprinkle the name.
- **No `@semantic-release/github`**: GoReleaser owns the GitHub release (`cd.yaml` on the `v*.*.*` tag).
- **The Homebrew cask is committed into this repo** under `Casks/` — there is no separate tap repo.

## CLI authoring

See [.claude/skills/cli-authoring/SKILL.md](.claude/skills/cli-authoring/SKILL.md) — composition
root shape, three-layer architecture, terminal ports, test tiers, and release machinery doctrine.

## Task surface

See [Taskfile.yaml](Taskfile.yaml) (`task --list`). Tests: `task test` (unit + int + SIT);
coverage variants `task test:coverage`.

## Releasing

See [README.md](README.md#releasing) and [INSTALLATION.md](INSTALLATION.md).
Repo invariants live in [scripts/validate/](scripts/validate/) and run from pre-commit.

## Layout

Bun workspaces monorepo — see [README.md](README.md#layout). Only `packages/cli` is real at P0;
`protocol`, `daemon`, `fleet`, and `pwa` are placeholders for the P1 lift.
