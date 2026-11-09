---
id: linting
title: Linting
---

# Linting

Every repository gate is declared in `nix/pre-commit.nix` and runs in the nix environment, so
the same hooks and the same pinned tool versions run on a laptop and in CI.

## Commands

```bash
task lint                                        # local: every gate
pre-commit run --all-files                       # identical, one layer down
nix develop .#ci -c ./scripts/ci/pre-commit.sh   # the whole gate in one process (CI runs the hooks as per-hook buckets)
```

`task lint` is `pre-commit run --all-files`. The CI script adds dependency installation and
`--show-diff-on-failure`, so a formatting failure prints the patch instead of just a red X.

In CI the same hooks run split by where they are cheapest (`scripts/ci/gate-hooks.ts` discovers them from
the generated config, so there is no second inventory): Quick runs `treefmt` over every file plus every
other hook as its own bucket, in parallel; the `Full Gates` job runs `a-deadcode`, `a-deadcode-production`
and `a-route-agreement` serially (Knip needs more than 4GB). `treefmt` runs in Quick only.
`scripts/test/ci-sets.ts` proves the two sets together are exactly the configured hooks.

## Hook inventory

| Hook                        | What it enforces                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `treefmt`                   | formatting: Biome (TS/JS/JSON/CSS), prettier (Markdown/YAML/HTML), actionlint, nixfmt, shfmt                                                  |
| `a-biome`                   | Biome lint on TS/JS (Biome formats through `treefmt`, configured in the same `biome.json`)                                                    |
| `typecheck`                 | `tsc --noEmit` across the workspace, one run per machine at a time (see below)                                                                |
| `a-deadcode`                | Knip, repository view (`knip.json`) — includes tests                                                                                          |
| `a-deadcode-production`     | Knip, production view (`knip.production.json`) — from the bin entry                                                                           |
| `a-shellcheck`              | shellcheck on every `*.sh` and `scripts/host/ferretry-loopback-firewall`                                                                      |
| `a-enforce-exec`            | tracked shell scripts are executable                                                                                                          |
| `a-action-pins-trusted`     | trusted GitHub Actions pin a major tag                                                                                                        |
| `a-action-pins-non-trusted` | everything else pins a 40-char SHA plus its tag in a comment                                                                                  |
| `a-cli-contracts`           | the release/architecture invariants in [Contracts](../contracts/README.md)                                                                    |
| `a-conflict-markers`        | marker shapes appear only in declared teaching documents                                                                                      |
| `a-contract-registry`       | executable, documented and wired contract inventories agree                                                                                   |
| `a-fetch-binding`           | the PWA never stores a `fetch` builtin or calls the network past the carrier                                                                  |
| `a-git-hooks-worktree`      | commit linting works from a linked worktree, concurrently and repeatedly                                                                      |
| `a-macos-policy`            | the darwin smoke is advisory on PRs, required and retried on main and a tag; free `macos-15` only                                             |
| `a-migration-isolated`      | the v4 -> v5 converter stays outside the product (workspaces, imports, release paths)                                                         |
| `a-no-fy-render-in-docs`    | `fy-render` fence openers appear only in their three teaching files                                                                           |
| `a-no-legacy-state`         | package code cannot reference predecessor state or identifiers                                                                                |
| `a-no-pattern-kill`         | test code never kills processes by pattern (`pkill`, `killall`)                                                                               |
| `a-no-sync-io`              | daemon code declares every synchronous file call in `scripts/validate/sync-io-allowlist.txt`                                                  |
| `a-no-raw-yaml`             | product code parses YAML only through the kernel's bounded reader, or a file `scripts/validate/raw-yaml-allowlist.txt` names with its reason  |
| `a-pending-tags`            | every `@pending`/`@public`, knip `ignore` and other keep-alive knip key is tied to an open gap, a kept row, a surface or an allow-list reason |
| `a-hosted-app-origin`       | the hosted app's origin has one owner and every build route asks one script for it                                                            |
| `a-release-guards`          | only main can tag, publish a release, touch Casks/ or run semantic-release; the preview deploys from rebuild/5.0 alone                        |
| `a-pages-config`            | the PWA build and the Pages deployment publish the same directory                                                                             |
| `a-relay-config`            | relay code, bindings, discovery and deployment configuration agree                                                                            |
| `a-rebuild-checks`          | the Ferretry 5.0 checks (redesign §7.9) through their one entry, `scripts/gen/check.ts`                                                       |
| `a-test-tiers`              | tier placement and budgets; complete groups; Quick/Full event, verdict and run-all contracts                                                  |
| `a-job-ceilings`            | every workflow job states `timeout-minutes`, so a wedged job fails in minutes                                                                 |
| `a-commit-msg`              | conventional commit subject (`commit-msg` stage)                                                                                              |

The root `typecheck` project does not include `scripts/test/**`, and the E2E harness project does,
under the same strictness plus `strict`. `task test:e2e` typechecks that project before running any
journey, so a type error in a fixture such as `ci-sets.ts` used to pass Quick and then fail every E2E
shard in seconds (E2E is advisory, so the PR still went green). `a-e2e-harness-typecheck` runs the exact
command `scripts/test/run-e2e.sh` runs, in Quick's parallel buckets, so it fails first.

Two Knip passes exist on purpose: the production view starts from the binary entry point and
therefore catches files that only tests reach, which the repository view considers used.

Neither Knip pass can see a module that a barrel re-exports but nobody uses, because loading a file
counts as using it. `a-composition-reachability` closes that hole — see
[Contracts](../contracts/README.md#composition-root-reachability).

**One typecheck at a time.** A `tsc` over this workspace peaks at about 4.5 GB (measured 2026-11-06, Linux
x64), and a machine running many agents commits from many worktrees at once. `typecheck.sh` therefore
takes a per-user `flock` in a directory only the user can write (`$XDG_RUNTIME_DIR`, else
`${XDG_CACHE_HOME:-$HOME/.cache}/ferretry`, created `0700`, used only if it is a real directory that user owns
and no one else can write — otherwise the check runs unlocked and says why) and a second run queues behind the
first. The lock is opened append-only (`exec 9>>"$lock"`), the script writes nothing into the directory, and a
lock path that is a link or not a regular file is refused. The directory check is best effort: someone who
owns a parent directory (in practice only root or the user) can swap it after the check. At worst that defeats
serialization (two checks at once, as before the lock), leaves an empty file created, or puts a FIFO in place so
the open itself blocks — before the bounded wait below applies, so that commit hangs until interrupted. It can
never truncate or write to an existing file. A check started from inside a locked one inherits
descriptor 9; when that descriptor is the same file as the lock it reuses it (`flock -n 9` succeeds at once,
because the lock belongs to the open file description) instead of waiting on its own ancestor, and a
descendant that closed descriptor 9 waits like anyone else. The wait on the lock lasts at most `TYPECHECK_LOCK_WAIT` seconds (600)
and then checks anyway, so a stuck neighbour cannot block a commit. CI never takes the lock (`CI` is
set and each job runs one check), and a machine with no `flock` runs unlocked as before.

`prettier` skips `Changelog.md` and `Changelog.old.md` — semantic-release owns those files and
reformatting them would churn the release commit.

**Biome formats code, prettier formats prose.** `nix/fmt.nix` hands TypeScript, JavaScript, JSON(C) and
CSS to the workspace's own `node_modules/.bin/biome` (the version `a-biome` lints with) and leaves
Markdown, YAML and HTML to prettier. The formatter options in `biome.json` mirror `.prettierrc` (120
columns, single quotes, trailing commas, `arrowParens: avoid`); Biome formats the repository in ~2 s
against prettier's ~40 s on 32 cores. Its few known differences from prettier were applied once, in
one reformat commit.

## Configuration rules

- Add custom hooks in `nix/pre-commit.nix` with an `a-` prefix. (`treefmt` and `typecheck` are
  the two hooks without it.)
- Use nix-provided tool paths or the repository's `validator` wrapper, which pins an explicit
  `PATH`. Hooks must never depend on a host-installed binary. JS/TS gates go through the
  `bun-tool` wrapper (`./node_modules/.bin/<tool>`), which requires `task setup` first.
- Give each independent enforcement mechanism its own hook, with a `files:` pattern narrow
  enough that unrelated commits do not pay for it.
- Policy enforcers are shell scripts under `scripts/validate/`, not inline nix strings — see
  [Contracts](../contracts/README.md) and [Shell Script Conventions](../shell-scripts/index.md).

## Diagnosing a failure

```bash
pre-commit run a-cli-contracts --all-files        # one hook, whole tree
pre-commit run a-shellcheck --files scripts/ci/test.sh
```

The `commit-msg` hook is not part of `--all-files`; drive it with the stage flags:

```bash
pre-commit run a-commit-msg --hook-stage commit-msg --commit-msg-filename .git/COMMIT_EDITMSG
```

> `pre-commit run` stashes unstaged changes for the duration of the run. Finish or stage
> in-flight edits before running it if anything else is writing to the tree.

## `.pre-commit-config.yaml` is generated

Nix writes `.pre-commit-config.yaml` from `nix/pre-commit.nix`, and it is gitignored. Never
edit it and never treat it as the source of configuration — the next `direnv reload` overwrites
it. The hooks are installed into `.git/hooks` by the devshell's `shellHook`
([Nix](../nix/index.md)).

## Hook installation across worktrees

Work in this repository happens in mandatory linked worktrees, and `direnv exec` runs the
devshell's `shellHook` before **every** command in **every** one of them. Installation is
therefore a concurrent write to shared state, and it is designed as one:

**`nix/git-hooks.nix` is the single owner.** `checks.pre-commit-check.shellHook` is deliberately
not sourced into the devshell — it calls `pre-commit install` without `-f`, which engages
migration mode against whatever occupies the hook path, and it rewrites the shared
`core.hooksPath` on every entry. The check itself is untouched and still runs under
`nix flake check`; only installation moved.

**The same launchers are installed in two places, and both are load-bearing.**

- The common directory's `hooks/` is the **baseline**. `hooks/` lives in the _common_ Git
  directory, so `git rev-parse --git-path hooks` from a linked worktree resolves to the main
  checkout's `.git/hooks` — which means a worktree nobody has ever opened a devshell in, including
  every worktree `packages/daemon` creates, has working hooks the moment it exists.
- A private `<worktree gitdir>/ferretry-hooks`, selected by a **worktree-scoped**
  `core.hooksPath`, is what makes _this_ worktree's linting survive its neighbours. The
  measurement below is why it is not optional.

**The launcher names no worktree and no revision.** Not the worktree: `--config` stays relative,
and pre-commit resolves it against the working tree Git handed the hook, so every checkout lints
at _its own_ revision of the generated config. Not the revision: a `/nix/store` path in the
launcher — an interpreter, or the shebang `writeShellScript` would emit — differs between two
worktrees sitting on two `flake.lock`s, and each entry would then rewrite what the other just
installed. That is last-writer-wins moved from the config to the launcher, so the launcher
resolves `pre-commit` from `PATH` (which in a devshell is already the pinned one) and falls back
to a GC-rooted `ferretry-pre-commit` link in the common directory, written only when it is
missing or dangling.

**Nothing is written once the state is right.** `nix/git-hooks/install.sh` compares before it
writes and exits before taking a lock. Only a genuine repair serialises on a `mkdir` lock in the
common directory, stages the launcher under a temporary name and `mv`s it into place — a commit
in another worktree can `exec` that exact path mid-install, and half a launcher fails a commit
for the wrong reason.

**`core.hooksPath` is written once per scope, never unset and reset.** The previous
installation's unset/set pair on every entry was a window in which a concurrent worktree saw no
hooks path at all. The worktree-scoped value names this worktree's private directory; the shared
value is pinned to the absolute common hooks directory, because the previous installation writes
it relative to whichever worktree ran it and a relative `.git/hooks` names a _file_ in a linked
worktree, so every worktree reading it resolves no hooks at all.

**A hook this repository did not generate is kept**, moved to `<hook>.legacy`, which the launcher
still runs. A `.legacy` that is itself a generated launcher is deleted: that is the
self-referential pair pre-commit's migration mode creates, and it fails _every_ commit —
including one whose subject the gate has just reported as `Passed`.

### Why a worktree needs its own hooks directory

A worktree on a branch cut before this change still runs the previous `shellHook`, whose
`pre-commit install` demotes whatever occupies the shared hook path on **every** entry. Sharing
one hooks directory with those worktrees was tried first and measured on this repository rather
than argued about: sampling `.git/hooks/commit-msg` twice a second for a minute recorded **twenty
takeovers**, with the shared launcher owned by a stale worktree in **96 of 120 samples**. In that
state every commit fails — valid subject and invalid subject alike, the valid one after the gate
has printed `Passed` — so a commit from a fixed worktree succeeded roughly one time in five. A
commit attempted while writing this was refused twice in a row for exactly that reason.

"Fail-closed and self-healing" is true of that design and still unusable. So each worktree gets
its own hooks directory, selected by a worktree-scoped `core.hooksPath` — which needs
`extensions.worktreeConfig`, the one repository-level setting this installer writes. It works at
`core.repositoryFormatVersion` 0, and it takes nothing away from any other worktree: a worktree
without a scoped value keeps reading the shared value and the shared launchers.

Two consequences are deliberate:

- **The shared install stays.** A per-worktree hooks path on its own would leave every worktree
  `packages/daemon` creates — none of which ever enters a devshell — with no hooks at all, which
  is fail-_open_. The baseline is what prevents that, and `a-git-hooks-worktree` proves it with a
  worktree the proof never installs into.
- **Enabling the extension is skipped, not forced, where it would change meaning.** Git reads
  `core.bare` and `core.worktree` from the shared config for every worktree once
  `extensions.worktreeConfig` is on. Neither is set in an ordinary clone of this repository;
  where one _is_ set, migrating it is the repository owner's call rather than a `shellHook`'s, so
  isolation is skipped, the reason is printed, and the shared baseline carries that worktree.

**Residual exposure, stated rather than hidden:** a stale worktree still demotes the _shared_
launchers, so a worktree that has never entered a devshell is broken until the next entry from any
updated one reclaims them. That window is fail-closed — every commit is refused, loudly, with
pre-commit naming the remedy — and the proof pins both the refusal and the recovery. It closes for
good once no checkout runs the previous `shellHook`.

To undo the extension: `git config --unset extensions.worktreeConfig`, then
`git worktree list` and remove each `ferretry-hooks` directory.

Because the JS/TS hooks use the workspace's `node_modules` rather than a nix-built tooling
derivation, `nix flake check` cannot run them hermetically. `pre-commit run --all-files` inside
the devshell is the real gate.
