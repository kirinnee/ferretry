# Workspace agent guide

Use the repository's nix shell for every command (`direnv exec . <cmd>` or the loaded devshell).
This file is a pure index — the linked documents own their subjects.

## Non-negotiable invariants

- **Name single-sourcing (two-name model)**: the PRODUCT name (`ferretry`) is the root
  `package.json` `name`; the BINARY name (`fy`) is the `bin` key in `packages/cli/package.json`.
  Scripts, Taskfiles, and tests derive the binary name (`jq -r '.bin | to_entries[0].key'`).
  Renames go through `scripts/local/rename.sh --product <name> | --bin <name>` — never
  hand-sprinkle either name. See [Architecture](docs/standards/architecture/index.md).
- **No `@semantic-release/github`**: GoReleaser owns the GitHub release (`cd.yaml` on the `v*.*.*` tag).
  See [Semantic Release](docs/standards/semantic-release/index.md).
- **The Homebrew cask is committed into this repo** under `Casks/` — there is no separate tap repo.

## Engineering doctrine

`docs/standards/` is the living doctrine — keep it current as decisions are made.

| Subject                                                                          | Owns                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------- |
| [Software Design Philosophy](docs/standards/software-design-philosophy/index.md) | Why every other rule exists — start here            |
| [SOLID Principles](docs/standards/solid-principles/index.md)                     | Dependency management, coupling, cohesion           |
| [Functional Practices](docs/standards/functional-practices/index.md)             | Immutability, pure/total functions, railway results |
| [Domain-Driven Design](docs/standards/domain-driven-design/index.md)             | Ubiquitous language, domain modelling               |
| [Three-Layer Architecture](docs/standards/three-layer-architecture/index.md)     | `src/lib` / `src/adapters` / `bin` seams and ports  |
| [Stateless OOP with DI](docs/standards/stateless-oop-di/index.md)                | Constructor injection, no hidden state              |
| [Architecture](docs/standards/architecture/index.md)                             | Two-name model, package layout, repo-wide machinery |
| [Validation](docs/standards/validation/index.md)                                 | Parse-don't-validate at boundaries (zod)            |
| [Datetime](docs/standards/datetime/index.md)                                     | Instants, timezones, durations                      |
| [Utilities](docs/standards/utilities/index.md)                                   | Shared helpers and what belongs in one              |
| [Testing](docs/standards/testing/index.md)                                       | Unit / integration / SIT tiers and coverage ledgers |
| [Contracts](docs/standards/contracts/README.md)                                  | The `scripts/validate/` repo invariants             |
| [Linting](docs/standards/linting/index.md)                                       | Generated pre-commit gates                          |
| [Nix](docs/standards/nix/index.md)                                               | Flake, devshells, pinned toolchain                  |
| [Taskfile](docs/standards/taskfile/index.md)                                     | Task surface and authoring rules                    |
| [Shell Scripts](docs/standards/shell-scripts/index.md)                           | Script conventions and safety                       |
| [CI/CD](docs/standards/ci-cd/index.md)                                           | Workflows, jobs, action pinning                     |
| [Conventional Commits](docs/standards/conventional-commits/index.md)             | Commit grammar and the commit-msg gate              |
| [Semantic Release](docs/standards/semantic-release/index.md)                     | Versioning and the release pipeline                 |
| [Contributor Docs](docs/standards/contributor-docs/index.md)                     | How to write documentation in this repo             |

Parked subjects (deliberately stubbed, read before reviving):
[Docker](docs/standards/docker/index.md) · [Authorization](docs/standards/authorization/index.md).

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

## Migration context

Mission and phase order: [docs/PROMPT.md](docs/PROMPT.md). Architecture, pairing, and security
design: [docs/design/split-proposal.md](docs/design/split-proposal.md). Feature backlog:
[handover.md](handover.md).

## Migration state

Resuming or continuing the kteam→Ferretry migration (including on a new machine):
[docs/migration/HANDOFF.md](docs/migration/HANDOFF.md) — current state, the `port/*` branch map,
the restart sequence, and the kickoff prompt. Unit briefs live in `docs/migration/units/`, source
surveys in `docs/migration/surveys/`.
