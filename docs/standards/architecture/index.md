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

## A feature is a file, not an edit to the composition root

A plugin's daemon `build()` keeps composition (stores, ports, the service, shared guards) and **loses
the per-feature wiring**: where many features would each add a route, a socket, a job or a port
member to one big file, the plugin has a folder of feature files instead. A new feature adds ONE file
and edits no shared one. Ferrets is the first plugin on this shape
(`packages/core/ferrets/daemon/features/`):

- **One file per feature**, named `<name>.feature.ts`, default-exporting `{ id, register(f) }`
  (`FerretsFeature`). `register` builds the feature from the shared composition `f`
  (`FerretsContext`: the kernel, the registry, the service, the session store and the shared guards
  such as `pathFerret` and `mayAct`), adds its jobs through `f.kernel.jobs`, and returns what it
  serves: `{ routes, sockets, port }`.
- **No list to edit.** `scripts/gen/registries.ts` lists every `daemon/features/*.feature.ts` (or
  `daemon/features/<f>/<f>.feature.ts`) into the
  git-ignored `daemon/generated/features.ts` (the same generator that writes the plugin registries,
  re-run by install, build, test and typecheck), and `build()` registers that list through
  `registerFeatures`, which is the plugin kit's `composeFeatures<Ctx, Port>(label, …)` from
  `@ferretry/kernel/manifest` labelled `ferrets` (every plugin composes its features the same way). A route, a socket or a port member two features both serve, or two features with
  one id, throws at boot naming both; `tests/unit/daemon/features/registration.test.ts` pins that the
  features serve exactly the routes and sockets the manifest declares.
- **A feature never imports another.** Something two features share, or something the service's ports
  call lazily, goes in `FerretsContext` (built once in `index.ts`) or in `LateBindings` (a value a
  feature assigns and the composition reads when a call is made).
- **Features register in file-name order**, so a feature may not depend on another's registration
  side effects, and two jobs started by the same boot have no order between them.

Other plugins adopt the same folder when a feature there would otherwise edit its root; the generator
picks up any package with a `daemon/features/*.feature.ts`.

## One feature, one folder

**IMPORTANT.** One feature lives in its own plugin folder. Touching a shared or cross-plugin file (another plugin,
`packages/core/*`, `packages/app`, root configs, scripts) is the exception: the PR body must name each such file and say
why.

Why: parallel work collides on shared files. In one week of merges into `rebuild/5.0-after`, `ports-pending.json` was
touched by 53 PRs, `knip.production.json` by 15, the core ferrets daemon `index.ts` by 12 and its `service.ts` by 11. Each
of those is a merge conflict waiting for the next PR. Splitting `ports-pending.json` into one file per owning package took
it to zero, and a file per open line (`ports-pending/<slug>.txt`, closed by `git rm`) removed the last conflict: two PRs
deleting adjacent lines of one list still conflict. Prefer that shape: when a shared list keeps growing, give each item
its own file and let one reader compose them.

Enforced on every pull request into `rebuild/5.0-after` by `scripts/ci/one-folder.ts` (the `One Folder` workflow, `.github/workflows/one-folder.yaml`):

- The PR's own diff (merge-base, so a merge from the base never counts) is split into the home package, which is the one
  with the most changed lines, or the ones on a `Home: <package>[, <package>]` line of the body, and everything else.
- Every other file must appear under a `## Outside files` heading of the PR body, by path or glob, with a reason:
  `- packages/core/kernel/src/x.ts: the new port has to be registered here`.
- Never needs a reason: `bun.lock`, `nix/ferretry.nix` and `nix/bun-deps.inputs` when a `package.json` changed, generated
  registries.
- Editing the body re-runs the job, so fixing the body clears it. The PR template carries the empty section.

## A feature adds files and lines; it never rewrites shared code

**The rule.** A new feature lands as new files in its own folder. It does not change code that other features share:
a manifest literal, a wiring `index.ts`, a big service class, a state machine. The one shared thing a feature MAY touch
is a **registry**, and only by adding its own line to it.

This holds at both levels:

- **Between plugins:** a plugin's code lives in its own package folder (the One Folder rule).
- **Inside a plugin:** each feature of the plugin lives in its own folder (`<plugin>/<side>/features/<feature>/`), and the
  plugin's manifest, wiring and contract barrel are assembled from registries of those features. A plugin is not a
  second place for a big shared file to grow.

**A registry is merge-safe by construction.** So two features added at the same time never collide:

1. One entry per line, and nothing else on that line.
2. Entries are sorted, so two new entries land in different places.
3. No shared closing line to edit: no trailing separator that the next entry must change, no `]` or `}` that moves.
   (Every entry ends with its own comma, or the list is a plain list of imports.)
4. Where the file is nothing but entries, `.gitattributes` marks it `merge=union`.
5. Each registry has a test that makes two independent one-line adds on two branches and proves they 3-way merge and
   rebase cleanly.

A registry may be written by hand or generated (`scripts/gen/registries.ts`, `folderRegistry`). Generation is a
convenience, not a requirement. Either way, adding a feature is a new folder plus at most one new line per registry.

**Why.** This is the Open/Closed Principle applied to the files themselves: the code is open to new features and closed
to edits of what is already there. When features share a file, unrelated work collides in it: merge conflicts,
re-reviews of code nobody changed, and one feature's mistake breaking another. We measured it on the 5.0 rebuild:

| Window                                                      | PRs | Edited a shared file | Edited one of the four biggest shared files |
| ----------------------------------------------------------- | --- | -------------------- | ------------------------------------------- |
| Before (40 merges to 2026-11-15 11:28pm PST)                | 40  | 22                   | 10 (25%)                                    |
| After the core split (14 merges from 2026-11-16 7:06am PST) | 14  | 2                    | 2 (14%)                                     |
| After the guard (to be measured)                            |     |                      |                                             |

The old standard already described OCP. It did not prevent this, because nothing checked it, and the shared lists were
ordinary code, so the easy path was to edit them anywhere.

**What enforces it.**

1. **Registry tests** prove each registry takes two independent adds without a conflict.
2. **One Folder** (CI): a PR names its home package folder; files outside it must be explained under `## Outside files`.
3. **Composition guard** (CI, U9): every package declares its composition files (registries and the few hand-written
   seams that remain). A PR that edits one fails unless its body has a `## Contract change` section that names each
   file and says why. Exempt: a pure one-line ADD to a registry. The pending ledger needs no exemption: closing a line is deleting its own file.
4. **Size and churn check** (CI, H6, `scripts/ci/size-churn.ts`, in the One Folder job): a source file (`.ts`/`.tsx`,
   not a test or generated) that the PR changes fails if it has more than 1,500 lines, or if 6 or more of the last 80
   merges edited it (one merge is one PR). The way out is a split, or an `oversize` row (limit, expiry date, reason) in
   the package's `composition.tsv`: the file may not grow past the limit, and once the date passes, any PR touching it
   fails until it is split or renewed. A `registry` file is exempt from churn. `bun scripts/ci/size-churn.ts --all`
   judges the whole tree; `--replay [ref] [count]` shows what the rule would have flagged on past merges.
5. **Rebase before pushing.** Before every push, rebase your own branch onto the latest base and push it with
   `--force-with-lease`. Never rewrite a shared branch (`main`, a release or integration branch, or a branch another PR
   stacks on): bring the base into it with a merge instead. A pre-push hook refuses a branch that does not contain its
   base's tip. Conflicts are met by the author, at their desk, not by the reviewer.

**The honest exception.** A real change to a contract (a new port member, a new state file shape) still edits the
contract. That is allowed. Say so under `## Contract change`, keep it to the contract file, and put the behaviour in the
feature folder.

**How to add a feature.**

1. Make a folder under the plugin's `features/`, with the feature's manifest fragment, wiring and code.
2. Add one line for it to each registry it belongs in (or run `bun scripts/gen/registries.ts`).
3. Do not edit the plugin's `manifest.ts`, `daemon/index.ts` or any other feature's files.
4. Rebase onto the base branch, then push.

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

1. Name the feature in `DAEMON_FEATURES` (`packages/protocol/src/lib/daemon-features/index.ts`). The daemon
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

**A read for a whole new route.** A `404 unknown_route` is the daemon saying it has no such route — a
version, not a fault. The Context rail's MCP, Skills and SKILL.md reads (routes new in 4.82) turn it into
_This machine needs an update to show MCP here_ plus `UPDATE_MACHINE_WHERE`
(`outdatedMachine` in `features/context-rail/context-rail-parts.tsx`). No `DAEMON_FEATURES` entry
backs those reads: daemons 4.82–4.85 have the routes and report no list, so a feature gate would
call them old. Any other failure keeps the plain failure with its details.

## Repo-wide machinery

- `scripts/ci/` — workflow entry points; only GitHub workflows call these.
- `scripts/local/` — multi-step local logic invoked from Taskfiles.
- `scripts/release/` — compile, GoReleaser shim, publish, smoke, installer, bump.
- `scripts/validate/` — repo invariants run by pre-commit ([Contracts](../contracts/README.md)).
- `Casks/` — the Homebrew cask, committed into this repo by GoReleaser on release; there is
  no separate tap repository.
