---
id: architecture
title: Repository Architecture
---

# Repository Architecture

Ferretry is one product in one Bun-workspaces monorepo. This page owns the two repo-wide
structural rules: the two-name model and the package layout. The shape _inside_ a package is
owned by [Three-Layer Architecture](../three-layer-architecture/index.md).

## Two-name model

The repository carries exactly two names, each with a single authoritative home:

| Name    | Value      | Single source                            |
| ------- | ---------- | ---------------------------------------- |
| PRODUCT | `ferretry` | root `package.json` `name` field         |
| BINARY  | `fy`       | `bin` key in `packages/cli/package.json` |

The product name brands the repo, the GoReleaser `project_name`, the Homebrew cask, and the
installer. The binary name is what users type and what the compile, shim, and smoke scripts
emit. Everything else — scripts, Taskfiles, tests, workflows — derives them:

```bash
jq -r '.name' package.json                                    # product name
jq -r '.bin | to_entries[0].key' packages/cli/package.json    # binary name
jq -r '.bin | to_entries[0].value' packages/cli/package.json  # entry file
```

Never hardcode either name. The few static files that must carry them (GoReleaser config,
cask, installer, docs) are rewritten by `scripts/local/rename.sh --product <name>` /
`--bin <name>`, and `scripts/validate/cli-contracts.sh name-single-source` gates the
invariant from pre-commit. See [Contracts](../contracts/README.md).

## Package layout

```
packages/
├── cli/        the fy binary — commander composition root, three-layer dirs (real today)
├── protocol/   zod schemas + typed client SDK shared by cli & pwa
├── daemon/     the per-host daemon (fyd)
├── fleet/      fleet provisioning library + subcommands
└── pwa/        the installable web app
```

Every directory is a real workspace member. The non-CLI packages begin with a minimal public
entry and grow through the migration described in `docs/design/migration-plan.md`. Every package
follows the same internal conventions (three layers, test tiers, lint gates) — the monorepo is a
deliberate deviation from the upstream diene template's one-repo-per-package rule, because
Ferretry is one product, not a template fleet.

## The PWA renders on the client only

`packages/pwa` is client-rendered. Its app root, when it is assembled, **must mount with
`createRoot`, never `hydrateRoot`**, and nothing may prerender its markup.

This is a constraint, not a preference. PR #155 removed the `getServerSnapshot` argument from the
side-pane's `useSyncExternalStore` calls on the grounds that it is unreachable in a static
Cloudflare Pages deployment. That is true of a client-rendered app — and React throws
_"Missing getServerSnapshot"_ the moment anything hydrates server-rendered content instead. So a
prerendered shell, added later for first-paint speed, would fail at runtime rather than at build
time, in a component far from the change that caused it.

If prerendering is ever wanted, restore `getServerSnapshot` on every `useSyncExternalStore` in
the package first — several still pass it, so the codebase is currently mixed — and change this
section in the same commit.

## Repo-wide machinery

- `scripts/ci/` — workflow entry points; only GitHub workflows call these.
- `scripts/local/` — multi-step local logic invoked from Taskfiles.
- `scripts/release/` — compile, GoReleaser shim, publish, smoke, installer, bump.
- `scripts/validate/` — repo invariants run by pre-commit ([Contracts](../contracts/README.md)).
- `Casks/` — the Homebrew cask, committed into this repo by GoReleaser on release; there is
  no separate tap repository.
