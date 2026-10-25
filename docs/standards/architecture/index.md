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
├── fleet/      the account model library: runtimes, credentials, profiles
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

## The app ships before the daemon

The PWA deploys from `main` the moment a change merges (`pwa-pages.yaml`). A machine's daemon changes
only after the release cut **and** the owner's `fy daemon update`. So the app in front of an owner is
routinely newer than the daemon behind it — version skew is the normal case, not an edge case. PR #789
raised the Pack idea limit from 500 to 4,000; the new app sent a 794-character idea to a 4.84.0 daemon
and the owner read `the request body is invalid — idea: Too big: expected string to have <=500
characters`.

**The rule.** A change that raises a limit, adds a request field, or leans on a route or response field
an older daemon lacks must **gate the app on the daemon's own report**, not on the app's version:

1. Name the feature in `DAEMON_FEATURES` (`packages/protocol/src/lib/daemon-features.ts`). The daemon
   reports the list on `GET /v1/health` › `features` (`runtime/mounts/health.ts`); a daemon from before
   the list reports none.
2. The app reads it (`useDaemonHealth`) and asks `machineOffers` / `machineLacks`
   (`packages/pwa/src/lib/daemon-health.ts`) before it enables the feature or the raised limit.
3. Without the feature the app **keeps the older behaviour** (the idea field stops at
   `LEGACY_MAX_IDEA_CHARS`, 500) and, only when the machine answered and lacks it, says so beside the
   control: _This machine needs an update for this — run “fy daemon update” (Settings › Machine › About &
   updates)._ A read that is still going or failed says nothing: the app cannot tell an old machine from
   a slow one, so it keeps the older behaviour quietly.
4. A test with a fake health that lacks the feature proves the older behaviour and the note.

**Why a list and not a version comparison.** A feature appears in a release, which the owner may or may not
have installed; a daemon built from a branch, or a downgraded one, has the version it has and the features
it has. Only the daemon knows which it can do. The list is strings, not an enum, so a feature a newer
daemon adds does not fail an older app, and `HealthViewSchema` is a lenient object so the added key is
not a wire break. (These are _features_, not the grant `DAEMON_CAPABILITIES`, which say what a caller may
do.)

**When the gate is missed anyway.** A `400 invalid_request` the daemon answers is said in plain words
(`packages/pwa/src/lib/request-refusal.ts`): known field limits become a sentence, the daemon's own text
stays behind a Details disclosure, and when the app's version is newer than the one in the daemon's
`x-fy-version` header the sentence adds that the machine may be on an older version and how to update.
Add a field's label to `FIELD_LABELS` there when a new bounded field ships.

## Repo-wide machinery

- `scripts/ci/` — workflow entry points; only GitHub workflows call these.
- `scripts/local/` — multi-step local logic invoked from Taskfiles.
- `scripts/release/` — compile, GoReleaser shim, publish, smoke, installer, bump.
- `scripts/validate/` — repo invariants run by pre-commit ([Contracts](../contracts/README.md)).
- `Casks/` — the Homebrew cask, committed into this repo by GoReleaser on release; there is
  no separate tap repository.
