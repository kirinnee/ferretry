# START HERE — resume the Ferretry migration on this machine

You are the **migration lead** for Ferretry (`github.com/kirinnee/ferretry`). Work was stopped
mid-flight on another machine. You are **resuming, not starting over** — ten branches of real work
already exist on `origin`.

Your prompt gave you the path to the kteam source. Everything else is in this repository.

---

## 0. Set the three paths, then verify them

```bash
export FY_REPO="$(git rev-parse --show-toplevel)"
export KTEAM_SRC="<the path given in your prompt>"          # e.g. ~/.config/home-manager/modules/kteam-ts
export KFLEET_SRC="$(dirname "$KTEAM_SRC")/kfleet-ts"       # usually a sibling; verify

test -d "$KTEAM_SRC/src"  && echo "kteam OK: $(find "$KTEAM_SRC/src" -name '*.ts' | wc -l) ts files"
test -d "$KFLEET_SRC/src" && echo "kfleet OK" || echo "kfleet MISSING — ask the human for its path"
```

Expect roughly **260** `.ts` files under `$KTEAM_SRC/src` and a `$KTEAM_SRC/ui` directory. If the
counts are wildly different you have the wrong path — stop and ask.

Docs in `docs/migration/` refer to `${KTEAM_SRC}`, `${KFLEET_SRC}` and `${FY_REPO}`. Substitute the
real values; **do not commit absolute machine paths back into these files.**

## 1. Bootstrap a bare box

```bash
cd "$FY_REPO"
direnv allow .            # nix devshell; every command below assumes it, or prefix `direnv exec . `
task setup                # locked workspace dependencies
gh auth status            # must show a login; PRs cannot be opened without it
```

If `direnv`/`nix` are missing, that is a host-provisioning problem — report it rather than working
around it. `kteam` is only needed if you fan work out to teammates; a single-agent run does not
require it.

## 2. Prove the baseline is green BEFORE changing anything

```bash
direnv exec . pre-commit run --all-files
direnv exec . task test
direnv exec . nix develop .#releaser -c ./scripts/release/publish.sh --snapshot
```

All three must pass. If any fails on a clean `main`, fix that first and report it — every later
judgement depends on this baseline.

## 3. Read these, in this order

1. **`docs/migration/HANDOFF.md`** — the state of the work, the ten-branch map, and §4–§5: the
   failure modes and the plan errors already caught. Reading §4 will save you hours.
2. **`docs/design/migration-plan.md`** — the binding execution contract.
3. **`docs/PROMPT.md`** — mission and locked decisions.
4. **`CLAUDE.md`**, `docs/standards/architecture/index.md`, `.claude/skills/cli-authoring/SKILL.md`.
5. **`handover.md`** (repo root) — the 48-item phase-3 backlog. Item numbers are **stable; never
   renumber them.** This is not the migration handoff; do not confuse the two.

## 4. Your mandate, in short

**Migrate _and_ fully refactor** kteam (609 files, 219k lines) and kfleet (45 files, 6.9k) into
`packages/{protocol,daemon,fleet,cli,pwa}`.

- **Port the capability, not the code.** kteam has plenty of bugs — fix them, never reproduce them,
  and never write a test that pins broken behaviour.
- **Conform to `docs/standards/`**: `src/lib` pure, `src/adapters` for all IO, composition root
  wires them, constructor injection, tiered tests.
- **No backward compatibility.** `FY_*` env only, no `~/.kteam` reads, no shims.
- **Ferretry starts empty.** No import tool, exactly one on-disk format.

**Safety, non-negotiable:** if this machine runs a live `kteamd`, never write under `~/.kteam`,
never start it, never kill tmux sessions you did not create, never bind its ports. Tests always use
a temporary `FY_HOME`. `kloge` and `loctl` stay external and out of scope.

**Merge gate, all four, every time:** `pre-commit run --all-files`, `task test`,
**`task test:gate`**, and the snapshot publish. The coverage gate is the one that bites — CI
enforces **100%** (`src/lib/**` from the unit tier, `src/adapters/**` from the integration tier) via
`scripts/ci/test.sh`. Neither `task test` nor `task test:coverage` enforces it — both exit 0 while
coverage is short — so `task test:gate` is the only local command that reproduces CI. **Never weaken a
gate to make something pass** — no blanket knip ignores, no `|| true`, no `@ts-ignore`, no loosened
tsconfig, no shrinking a coverage ledger. This refactor has no original to diff against, so the
gates and the tests are its only oracle.

## 5. Order of work

```bash
git fetch origin '+refs/heads/port/*:refs/remotes/origin/port/*'
git branch -r | grep port/
for b in $(git branch -r | grep 'origin/port/'); do echo "== $b"; git log --oneline origin/main.."$b"; done
```

1. **Merge `port/s2-protocol` first.** It is the critical path — T1, T2, A1 and AN1 all import
   `@ferretry/protocol`. It was gate-verified green before the stop.
2. Then `port/f3-foundation` (independent of S2).
3. Then the six branches carrying an un-gated `wip(...)` commit. **Review that commit before
   trusting it** — it was preserved, not verified. Expect to finish tests, wire adapters into
   `packages/daemon/bin/fyd.ts`, and open the PR.
4. Then the queue in `docs/design/migration-plan.md` §8: tmux controller, terminal, browser, stt,
   learning + skills, pins + push, attachments + pdf, warden, the five `session-manager` sub-units,
   `api-server`, the CLI command groups, and the PWA including its 56 single-daemon assumption sites.
5. **Only after the migration is complete**, start phase 3 from `handover.md`, honouring each item's
   hard dependencies.

Do not redo work that already exists on a branch. Read its log first.

## 6. How to run the work

One unit = one git worktree = one branch = one PR, merged when CI is green (**you are permitted to
merge**). Run **wide — 12 to 16 concurrent units, not 6**; the lead is the usual bottleneck.

```bash
git worktree add ../ferretry-wt-<id> -B port/<branch> origin/port/<branch>
cd ../ferretry-wt-<id> && direnv allow .
```

Brief each unit with `docs/migration/units/UNIT-CONTEXT.md` **plus** its `UNIT-<id>.md`. Review each
PR with `docs/migration/units/REVIEWER.md`. Write new briefs in the same shape: short and specific,
with the shared context carrying the common rules.

**After `port/s2-protocol` is squash-merged**, a branch stacked on it must replay only its own
commits — a plain rebase would replay S2's and conflict:

```bash
git rebase --onto main port/s2-protocol
```

## 7. Failure modes — all observed, all documented in HANDOFF.md §4

- **Agents drift into writing analysis instead of code** when they read too much source first. The
  mechanism is context exhaustion: fill the window reading, and a summary is the only artifact left.
  Units must read only what the next module needs, write it with tests, commit, repeat.
- **Units stop at "committed locally"** without opening the PR. Five did. Treat "resume it to ship"
  as routine.
- **A dependency added without its first use fails the dead-code gate**, so each unit declares its
  own package's dependencies.
- **Detect drift in flight**, not at completion: sample per-worktree `git status --porcelain | wc -l`
  and the agent's context-% while it is still on turn 1.
- **Never end a turn with a pending action that has no watcher.** Arm a monitor on agent state _and_
  open-PR CI so a green PR wakes you to merge it. On the previous machine a PR sat green and unmerged
  for 6h26m because nothing was watching and a human had to intervene.

**Report honestly:** measured percentages rather than impressions, failed gates plainly, units that
produced nothing. Verify your own claims against source before they enter a plan — three plan errors
were caught that way, each of which would have silently degraded the result.

## 8. Cleaning up the transient migration scaffolding

`docs/migration/` is **scaffolding, not product documentation.** It exists to carry this migration
across machines and should be deleted when the migration is done. Same for the branches and
worktrees.

**During the work** — after a unit's PR is merged:

```bash
git worktree remove ../ferretry-wt-<id>          # add --force only if you accept losing changes
git worktree prune
git branch -d port/<branch>                      # -D if it was squash-merged
git push origin --delete port/<branch>
```

Check for stray worktrees at any time with `git worktree list`. Anything under
`../ferretry-wt-*` that no unit is using is litter.

**When the migration is complete** (all units merged, phase 2 done):

```bash
git rm -r docs/migration                         # briefs, surveys, HANDOFF, this file
# then remove the "Migration state" section from CLAUDE.md, and
# drop the docs/migration references from docs/PROMPT.md if any remain
git commit -m "docs: remove migration scaffolding now the port is complete"
```

Keep `docs/design/migration-plan.md` and `docs/design/split-proposal.md` — those are the historical
design record. Keep `docs/standards/**` — that is living doctrine. Keep root `handover.md` until
every backlog item is closed.

**Do not** commit machine-specific paths, `/tmp` scratch files, or agent transcripts into the repo
at any point.

---

Begin by doing §0 through §3, then report the state you found and your first three actions.
