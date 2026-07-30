# Migration handoff — resume on any machine

Written 2026-07-30 on a stop-work order, so the migration can continue on a different box.
Everything needed is in this repository or on `origin`; nothing important is left on the original
machine except the one file noted in §7.

Read `docs/design/migration-plan.md` first — it is the binding contract. This file is only the
_state_ of the work and the operational knowledge that is expensive to rediscover.

## 1. What is merged and green on `main`

| Landed                                              | Where                                  |
| --------------------------------------------------- | -------------------------------------- |
| Engineering doctrine, 53 files                      | `docs/standards/**`                    |
| The migration plan                                  | `docs/design/migration-plan.md`        |
| Four workspace packages made real (PR #1)           | `packages/{protocol,daemon,fleet,pwa}` |
| Architecture gate, parameterized per package        | `scripts/validate/cli-contracts.sh`    |
| `no-legacy-state` gate (blocks `KTEAM_`/`.kteam`/…) | `scripts/validate/no-legacy-state.sh`  |
| Daemon composition root                             | `packages/daemon/bin/fyd.ts`           |
| Probes removed (Kirin's decision)                   | —                                      |

All three gates pass on `main`: `pre-commit run --all-files`, `task test`,
`nix develop .#releaser -c ./scripts/release/publish.sh --snapshot`.

**Honest progress: roughly 1% of the program.** `packages/` holds almost no ported production code
yet. What is done is the enabling work — plan, gates, surveys, unit decomposition — plus the ten
branches below.

## 2. The ten unit branches on `origin`

Every branch is pushed. Branches whose worktree had uncommitted work carry a final
`wip(...)` commit made with `--no-verify` by the lead purely to preserve it: **those commits are not
gate-verified and are not intended to merge as-is.**

| Branch                    | Commits | WIP tail | Unit                                                 |
| ------------------------- | ------: | :------: | ---------------------------------------------------- |
| `port/s2-protocol`        |       7 |    no    | wire schemas + typed client SDK                      |
| `port/an1-analytics`      |      10 |    no    | analytics ingestion, model cost                      |
| `port/t2-task-boards`     |       8 |   yes    | tree-scoped shared board                             |
| `port/a1-attention`       |       6 |   yes    | attention lifecycle                                  |
| `port/f3-foundation`      |       5 |    no    | state home, paths, storage                           |
| `port/t1-tasks`           |       5 |   yes    | task records and stores                              |
| `port/e1-e2e-harness`     |       2 |   yes    | E2E harness                                          |
| `port/d1-transcripts`     |       1 |   yes    | Claude/Codex transcript parsers                      |
| `port/d2-names-worktrees` |       1 |   yes    | names pool, worktrees, git adapter                   |
| `port/fl1-fleet`          |       0 |   yes    | fleet + manifest (**all work is in the WIP commit**) |

`port/s2-protocol` is the critical path: T1, T2, A1 and AN1 all import `@ferretry/protocol`. It was
gate-verified green by the lead (11+ test files, adapter committed, exports map correct) and was
about to be merged when work stopped. **Merging it first is the highest-value next action.**

## 3. Resuming on a new box

```bash
git clone <repo> && cd ferretry && direnv allow .
task setup
git fetch origin '+refs/heads/port/*:refs/remotes/origin/port/*'

# one worktree per unit you want to continue
git worktree add ../ferretry-wt-s2 port/s2-protocol
cd ../ferretry-wt-s2 && direnv allow .
```

Unit briefs are in `docs/migration/units/`; surveys in `docs/migration/surveys/`. Launch a unit by
pointing an agent at `docs/migration/units/UNIT-CONTEXT.md` plus its `UNIT-<id>.md`. Review a PR with
`docs/migration/units/REVIEWER.md`.

Worktree paths inside the briefs were generalized to `<your-worktree>` — substitute the real path.

## 4. Operational knowledge that cost real time to learn

**Agents drift into analysis when they read too much source.** Four units produced findings or
plans instead of code; one delivered a six-part audit and zero lines. The mechanism is **context
exhaustion**: an agent that reads its whole source tree first has no room left to write, so a
summary is the only artifact it can still emit. The fix is in `UNIT-CONTEXT.md` — implementation
first, then _read only what the next module needs, write it with tests, commit, repeat._ Committed
code survives context exhaustion; an uncommitted understanding does not.

**Detect it in flight, not at completion.** `git status --porcelain | wc -l` per worktree plus
`kteam status <name>` context-% while still on turn 1 catches a drifting unit early. Waiting for a
terminal state costs a whole unit's budget to learn nothing.

**Units routinely stop at "committed locally".** Five did. The PR step is now item 1 of the
definition of done, and it still happens — treat "resume it to ship" as routine.

**Self-review works; trust it, then verify it.** One unit's self-review found three real defects,
including a hidden file (`src/lib/.probe.ts`) that bypassed the architecture gate entirely because
`rg` skips hidden descendants by default. Verifying reported findings is much cheaper than hunting
from scratch.

**A dependency and its first use must land in the same PR.** Adding `@ferretry/protocol` to a
manifest centrally fails knip as an unused dependency. So each unit declares its own package's deps.

**Two repo gates pull in opposite directions.** The arch gate forbids `src/lib` importing
`src/adapters`; production dead-code analysis requires reachability from the package entry. Any
package with adapters therefore needs a composition root outside both directories, and knip's entry
must point at it — that is why `packages/daemon/bin/fyd.ts` exists.

**Worktrees share one `.git`.** A unit can rebase directly onto another unit's branch for real
types instead of writing shims. Because branches are squash-merged, replay only your own commits:
`git rebase --onto main port/<dep-branch>`. A plain rebase would replay the dependency's commits and
conflict.

**A `kteam send` cannot re-task an agent.** Teammates correctly refuse role changes from a peer
session. To change what an agent is _for_, stop it and start a fresh one whose prompt states the new
role. `send` is only for steering within an assignment.

## 5. Plan errors already caught — do not reintroduce them

1. `migrate-preflight.ts` (1,036 lines) is **not** history migration; it is the safety gate that
   refuses a destructive session migration. It ports.
2. The two import cycles do **not** dissolve by porting the type layer: `ScratchPlan`
   (`session-manager.ts:334`) and `AgentUsage` (`core.ts:87`) are declared in implementation
   modules, so their units must extract them deliberately.
3. The tree-scoped shared board **already exists** (`task-boards.ts`); items 47/48/67 build on a
   port, not a new design.

## 6. Decisions locked in

Port capabilities not behavior · conform to `docs/standards/` while porting · **no backward
compatibility** · **Ferretry starts empty**, no import tool · worktree + PR per unit, lead may merge
· the live `~/.kteam` installation is never touched · `kloge`/`loctl` stay external.

Still open: PWA hosting origin/domain (needed only for phase 3 pairing and CORS).

## 7. The one artifact deliberately not committed

The kfleet coupling survey (40 coupling sites with `file:line`) names ~22 live fleet accounts, and
this repository is public. Its load-bearing conclusions are already quoted in
`docs/design/migration-plan.md` §7.1–§7.2 (two wrapper-text readers with four call sites, four
duplicate model tables, wrapper filename used as the join key across five subsystems, and the
`/usage` + `/metrics` dual contract with kloop and khost as external consumers). If the full survey
is wanted, sanitize the account names first or keep it outside the repo.

Two live defects it found in the **current** kteam installation, worth fixing there regardless of
this migration:

- `kfleet/config.yaml:66-70` declares Fable down on the loge pool, but `fleet-inventory.ts:42-47,67`
  still offers it and `core.ts:361-369` still ranks it the default recommendation.
- Nothing was listening on `:47318`, so kloop's usage gate is failing open and khost's `kfleet`
  Prometheus scrape is dark.

## 8. Prerequisites on the new machine

The migration reads kteam and kfleet source directly, so the new box needs them present.

| Needed                         | Default location                                  | Notes                                     |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| kteam source (read-only)       | `~/.config/home-manager/modules/kteam-ts`         | 609 files. Adjust briefs if path differs. |
| kfleet source (read-only)      | `~/.config/home-manager/modules/kfleet-ts`        | 45 files.                                 |
| kfleet assets (read-only)      | `~/.kfleet/` + `kfleet/` in the home-manager repo | Only unit FL1 needs these.                |
| nix + direnv                   | —                                                 | `direnv allow .` in every worktree.       |
| `gh` authenticated             | —                                                 | `gh auth status` must show a login.       |
| `kteam` daemon (for teammates) | —                                                 | `kteam daemon status`; only for fan-out.  |

If the source paths differ on the new box, fix them **once** in
`docs/migration/units/UNIT-CONTEXT.md` and in the affected `UNIT-*.md` files, then commit — do not
let each agent guess.

**Safety note that still applies:** if the new box also runs a live `kteamd`, the rule that no unit
may touch `~/.kteam`, its tmux sessions, or its ports remains in force. If the new box has **no**
live installation, the rule costs nothing — keep it anyway so briefs stay portable.

## 9. Exact restart sequence

```bash
# 1 — clone and enter the environment
git clone git@github.com:kirinnee/ferretry.git && cd ferretry
direnv allow .
task setup

# 2 — confirm the baseline is green BEFORE adding anything
direnv exec . pre-commit run --all-files
direnv exec . task test
direnv exec . nix develop .#releaser -c ./scripts/release/publish.sh --snapshot

# 3 — fetch every unit branch
git fetch origin '+refs/heads/port/*:refs/remotes/origin/port/*'
git branch -r | grep port/

# 4 — merge the critical path FIRST (S2 unblocks four units)
git worktree add ../ferretry-wt-s2 -B port/s2-protocol origin/port/s2-protocol
cd ../ferretry-wt-s2 && direnv allow .
direnv exec . pre-commit run --all-files && direnv exec . task test
git rebase origin/main
git push -u origin port/s2-protocol
direnv exec . gh pr create --base main --title "feat(protocol): add wire schemas and the typed client SDK" --body "See docs/migration/HANDOFF.md"
# once CI is green:
direnv exec . gh pr merge <n> --squash

# 5 — then F3 (independent of S2), same shape
git worktree add ../ferretry-wt-f3 -B port/f3-foundation origin/port/f3-foundation

# 6 — then the branches carrying a wip(...) tail. For each, review that commit
#      before trusting it: it was preserved un-gated.
git log --oneline origin/main..origin/port/t1-tasks
git show <wip-sha> --stat
```

**Dependent branches were stacked on `port/s2-protocol`.** After S2 is squash-merged, replay only a
unit's own commits — a plain rebase would replay S2's commits and conflict:

```bash
git rebase --onto main port/s2-protocol       # inside that unit's worktree
```

## 10. The prompt to restart the work

Paste this into a fresh agent session opened at the repository root on the new machine. It is
written to be self-sufficient.

---

> You are the migration lead for **Ferretry** (`github.com/kirinnee/ferretry`), continuing work that
> was stopped mid-flight on another machine. You are resuming, not starting over.
>
> **Read these in order before doing anything:**
>
> 1. `docs/migration/HANDOFF.md` — the state of the work, the ten unit branches, and the operational
>    knowledge that cost real time to learn. Sections 4 and 5 will save you from repeating known
>    mistakes.
> 2. `docs/design/migration-plan.md` — the binding execution contract.
> 3. `docs/PROMPT.md` — the mission and the locked-in decisions.
> 4. `CLAUDE.md`, `docs/standards/architecture/index.md`, `.claude/skills/cli-authoring/SKILL.md`.
> 5. `handover.md` at the repo root — the 48-item product backlog for phase 3. Item numbers are
>    stable; never renumber them.
>
> **What this work is:** a migrate **plus full refactor** of kteam (609 files, 219k lines) and kfleet
> (45 files, 6.9k lines) into `packages/{protocol,daemon,fleet,cli,pwa}`. Port the _capability_, not
> the code: kteam has plenty of bugs, so fix them rather than reproducing them, conform to
> `docs/standards/` (three-layer, stateless OOP with DI, tiered tests), and write tests that assert
> **correct** behaviour. There is **no backward compatibility** — `FY_*` env only, no `~/.kteam`
> reads, no shims — and **Ferretry starts empty**, so there is no import tool and exactly one on-disk
> format.
>
> **Non-negotiable safety:** if this machine runs a live `kteamd`, never write under `~/.kteam`, never
> start it, never kill tmux sessions you did not create, never bind its ports. Tests always use a
> temporary `FY_HOME`. `kloge` and `loctl` stay external.
>
> **The merge gate**, all three green, always: `pre-commit run --all-files`, `task test`, and
> `nix develop .#releaser -c ./scripts/release/publish.sh --snapshot`. **Never weaken a gate to make
> something pass** — no blanket knip ignores, no `|| true`, no `@ts-ignore`, no loosened tsconfig. The
> gates are the only oracle this refactor has.
>
> **Do this, in order:**
>
> 1. Verify prerequisites (§8) and confirm the three gates are green on a clean `main`.
> 2. Fetch the ten `port/*` branches (§9) and read `git log origin/main..origin/port/<x>` for each so
>    you know what already exists. Do not re-do work that is already on a branch.
> 3. **Merge `port/s2-protocol` first.** It is the critical path — T1, T2, A1 and AN1 all import
>    `@ferretry/protocol`. It was verified green before the stop.
> 4. Then land `port/f3-foundation`.
> 5. Then work the remaining branches. Six carry an un-gated `wip(...)` preservation commit: review it
>    before trusting it, and expect to finish tests, wire adapters into `packages/daemon/bin/fyd.ts`,
>    and open the PR.
> 6. Then continue the queue in `docs/design/migration-plan.md` §8: tmux controller, terminal,
>    browser, stt, learning + skills, pins + push, attachments + pdf, warden, the five
>    `session-manager` sub-units, `api-server`, the CLI command groups, and the PWA (including its 56
>    single-daemon assumption sites).
> 7. Only after the migration is complete, start phase 3 from `handover.md`, honouring each item's
>    hard dependencies.
>
> **How to run the work:** one unit = one git worktree = one branch = one PR, merged when CI is green
> (you are permitted to merge). Run **wide** — 12–16 concurrent units is the target, not 6. Brief each
> unit with `docs/migration/units/UNIT-CONTEXT.md` plus its `UNIT-<id>.md`, and review each PR with
> `docs/migration/units/REVIEWER.md`. Write new unit briefs in the same shape: short and specific, with
> the shared context carrying the common rules.
>
> **Failure modes you will hit — they are documented in HANDOFF.md §4, and they are not hypothetical:**
> agents drift into writing analysis instead of code when they read too much source first (context
> exhaustion); units stop at "committed locally" without opening the PR; a dependency added without
> its first use fails the dead-code gate. Detect drift in flight by sampling per-worktree
> `git status --porcelain | wc -l` and the agent's context-% while it is still on its first turn —
> waiting for a terminal state wastes the whole unit.
>
> **Never end a turn with a pending action that has no watcher.** Arm a monitor on both agent state
> and open-PR CI status so a green PR wakes you to merge it. On the previous machine a PR sat green
> and unmerged for six and a half hours because nothing was watching, and a human had to intervene.
>
> **Report honestly.** State progress as a measured percentage, not a feeling; say when a gate fails;
> say when a unit produced nothing. Verify your own claims against the source before they enter a
> plan — three plan errors were caught that way and each would have silently degraded the result.
>
> Begin by reading the documents above, then report the state you find and your first three actions.

---

## 11. Surveys and briefs included in this repository

`docs/migration/surveys/`

- `daemon-deps.tsv` — all 132 non-test daemon files: LOC, exports, internal import edges, and
  per-file `fs`/`proc`/`net`/`sqlite`/`env`/singleton-state flags. This is the input to the unit
  decomposition; regenerating it is expensive.
- `daemon-notes.md` — import cycles, hub in-degrees, leaf files, the test map, and observed
  duplication and mixed-concern files.
- `pwa-shape.md` — the PWA's structure, largest files, routing, state, theming, and the 56
  single-daemon assumption sites with `file:line`.
- `api-surface-notes.md` — the HTTP/WS surface findings, including that the surveyed source uses no
  zod and casts generic JSON syntactically.

`docs/migration/units/` — `UNIT-CONTEXT.md` (the shared rules every unit gets), one `UNIT-*.md` per
unit, and `REVIEWER.md` (the mechanical PR review checklist).
