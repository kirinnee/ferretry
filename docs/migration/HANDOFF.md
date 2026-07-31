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

### Updated 2026-07-31 — 57 units merged, all ten original branches landed

The table above is the state at the stop-work order. Since resuming, **24 PRs have merged** and
every one of the ten branches in §2 is landed and deleted. Also on `main` now:

| Landed since resuming                                         | Where                                          |
| ------------------------------------------------------------- | ---------------------------------------------- |
| protocol wire schemas + typed client SDK                      | `packages/protocol/**`                         |
| state home, journal, storage, paths                           | `packages/daemon/src/{lib,adapters}/…`         |
| fleet provisioner, manifest, usage collector                  | `packages/fleet/**`                            |
| tmux controller, worktrees, names, Git adapter                | `packages/daemon/**`                           |
| tasks, task boards, attention, analytics, learning, pins/push | `packages/daemon/**`                           |
| warden supervision, browser control + transport, terminal     | `packages/daemon/**`                           |
| session lifecycle, daemon runtime, migrate-preflight          | `packages/daemon/**`                           |
| core recommender + usage feed, transcript ingestion           | `packages/daemon/**`                           |
| isolated E2E harness (real tmux on a private socket)          | `tests/e2e/**`, `scripts/test/**`              |
| **`task test:gate`** — reproduces CI's 100% coverage gate     | `Taskfile.yaml`, `scripts/ci/test.sh`          |
| **composition-reachability gate** + enumerated allowlist      | `scripts/validate/composition-reachability.sh` |

**Honest progress: ~62k of ~167k lines (~37%).** The denominator matters: the daemon+CLI source is
67,861 lines but the kteam UI is a further 98,956, so any percentage quoted against the daemon alone
is wrong. The daemon and CLI are substantially complete — the daemon binds, serves an authenticated
API with /usage and /metrics, supervises sessions with a warden, and the CLI drives all of it.

Remaining: the PWA (~4.8k of ~99k ported — the dominant cost from here), the ~30 unwired modules
below, and the STT unit (see §12).

**Four gates now, not three:** `pre-commit run --all-files`, `task test`, **`task test:gate`**, and
the snapshot publish. `task test` and `task test:coverage` both exit 0 while coverage is short —
only `task test:gate` reproduces CI. And the reachability gate runs **only** under `pre-commit`, so
after any rebase BOTH must be re-run, on the rebased head. Merging on a stale CI run once put nine
unwired modules on `main` and turned it red.

**~75 modules are built, tested, and NOT wired into the composition root.** They are enumerated in
`scripts/validate/reachability-allowlist.txt`, each naming the PR that must wire it. That list is a
work schedule and can only shrink. Until an entry is deleted, that capability does not exist in the
running product however green its tests are.

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

**The shared daemon barrel conflicts on every single merge.** `packages/daemon/src/lib/index.ts`
(and `src/adapters/index.ts`) collect one `export *` line per unit, so every rebase after every
merge conflicts there. Resolving by hand is both tedious and dangerous — taking one side silently
deletes another unit's export. Resolve by **union**: keep every `export * from` line from both
sides, sorted. This is mechanical and worth scripting; the lead did, after hitting it four times.

**Nothing local reproduced the CI coverage gate, and it cost three red PRs.** CI enforces a 100%
ledger through `scripts/ci/test.sh`, but `task test` _and_ `task test:coverage` both exit 0 while
coverage is short — the latter prints percentages without enforcing them. `task test:gate` now
delegates to the same script CI runs. Never trust a green `task test` alone.

**Never remove a merged unit's worktree without checking for a live agent in it.** An agent whose
cwd disappears mid-turn dies. A running session's cwd is in `~/.kteam/<id>/config.json`.

**Composition roots conflict on EVERY merge, and mechanical union resolution corrupts them.** Every
unit appends to `bin/fyd.ts` or `bin/fy.ts`, so both conflict constantly. Stripping conflict markers
to "keep both sides" is right for barrels (append-only export lists) and WRONG for structured code —
it silently duplicated a declaration and resurrected a deliberately-deleted import, twice. Two fixes
that worked: resolve those files by hand and run `biome lint` on the file BEFORE continuing the
rebase; and restructure the CLI root into a `DOMAIN_REGISTRARS` list so adding a group is a one-line
append that merges like a barrel. Do the same for `fyd.ts` if it keeps costing round-trips.

**Hand a semantic conflict back to the unit that wrote the code.** When two units both rewrote
`registerDomain`, deciding how one group obtains its client is a judgement about intent, not a
merge. Aborting and relaunching the unit with the specific decision spelled out worked every time;
resolving it myself corrupted the file three times.

**Sweep worktrees for uncommitted work — but check for a live agent first.** Four times a unit died
mid-turn (context exhaustion, hard quota limit) with 6–10 uncommitted files, and a `git status`
sweep saved the work as a labelled `--no-verify` preservation commit. Once the agent was still
running in that worktree, so committing under it would have corrupted its state: map a session to
its cwd via `~/.kteam/<id>/config.json` before touching anything.

**Never run gate checks and `gh pr merge` in the same command block.** The merge executes regardless
of what the checks printed. That is exactly how nine unwired modules landed on `main` and turned it
red, and it nearly happened twice more.

**A green PR can still break `main`, through ordering.** One PR widened biome and the arch gate to
`.tsx`; another landed the first `.tsx` files with CI green from _before_ that widening. Each was
fine alone; together they put four error-severity findings on `main`. After merging anything that
widens a gate's scope, re-verify `main` itself.

**Probe results are a snapshot, not a fact.** `kfleet`/`kteam` reported an account as
"credentials rejected — run kfleet login"; it was a transient probe failure and the account was
usable minutes later. Re-probe before escalating anything account-related to the human.

**Obeying a linter can break a feature.** Biome flagged a transcript auto-scroll effect's deps as
"unnecessary" because the body reads only refs — but those deps are the TRIGGER, and removing them
stops the viewport following new entries. The fix was a narrow suppression with the reason written
down, not a code change. Read what an effect is FOR before satisfying a rule about it.
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

Still open: nothing. **PWA hosting was answered 2026-07-31: Cloudflare Pages, public site** — see
`docs/design/migration-plan.md` §12.1 for the constraints that follow (static-only, pairing-supplied
daemon URL, no identifying data in the bundle, loopback mixed-content path proven in E2E).

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
unit's own commits — a plain rebase would replay S2's commits and conflict.

**Corrected in practice (2026-07-31):** the recipe below does **not** work as written, because the
dependent branches carry _copies_ of the protocol commits with **different SHAs** than S2's
(`d5fb2ec…` on the units vs `d2af642…` on S2). `port/s2-protocol` is therefore not their ancestor
and `--onto main port/s2-protocol` finds nothing to replay. Use each branch's **own** base — the
last commit before its first unit commit:

```bash
git rebase --onto origin/main <sha-before-your-first-own-commit>   # inside that unit's worktree
```

The copies were verified byte-identical to S2's `src/lib`, so units could safely build against them
before S2 landed; only the client adapter differed.

## 10. The prompt to restart the work

The entry point is [`START-HERE.md`](START-HERE.md), which carries the full lead mandate, the
bootstrap steps, the work order, and the cleanup instructions. The prompt handed to a fresh agent
is deliberately two lines — see that file. Do not duplicate the mandate here; it drifts.

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

## 13. Agents die to the OOM killer, and the pane lies about why

**Symptom:** a teammate dies abruptly, `kteam` shows `failed`, and the pane's last line is
`Pane is dead (signal 15, ...)`. Signal 15 is SIGTERM, which reads like a deliberate external kill.

**Cause:** it is the Linux OOM killer. The authoritative record is the systemd journal, not the pane:

```bash
journalctl --user --since "2 hours ago" | grep -E "oom-kill|Failed with result"
# kteam-agent-<id>-<hash>.scope: A process of this unit has been killed by the OOM killer.
# kteam-agent-<id>-<hash>.scope: Failed with result 'oom-kill'.
```

**Measured on 2026-07-31: 10 of 88 agent scopes were OOM-killed in a single day (~11%).**

**Why it happens:** the box has 30 GB total and `launch.sh` gives each scope
`MemoryMax≈27.7 GB` — nearly the whole machine — so the per-session ceiling does not protect
against several agents at once. Add the PWA visual harness (Chrome per screenshot run) and memory
goes fast.

**Why it fooled the lead for six attempts:** one unit was retried across four accounts, two models,
two worktrees and two brief sizes, all dying identically, while a _trivial_ probe in the same
worktree survived — because a trivial probe barely allocates. That pattern reads as "this worktree
is cursed" and is really "real work allocates, and memory was contended." Five diagnostic rounds
were spent before anyone ran `journalctl`.

**Mitigations:**

- Cap concurrent units at ~4 on a 30 GB box; more is not faster if a fraction get reaped.
- Lower `MemoryMax` per session in the kfleet config so one agent cannot take the whole machine
  (this is the human's call — it is fleet configuration, not repo configuration).
- Brief UI units to close the browser and dev server in teardown; a leaked Chrome is a leaked GB.
- **Check `journalctl` FIRST when an agent dies with no error.** It is usually this.

## 14. The PWA has no application yet — this is deliberate

`packages/pwa` holds components, features, hooks, shell chrome, styles and the data layer, all
tested and daemon-scoped. It has **no `index.html`, no Vite config, no router mount and no build**,
so there is nothing to deploy and nothing to visit. The only `index.html` in the package belongs to
`harness/`, the screenshot rig — a component gallery, not the app.

**Decided by Kirin 2026-07-31: keep porting components; assemble the application later.**

The tradeoff that decision accepts: integration defects — routing, the pairing flow, a real daemon
connection, service-worker and offline behaviour — cannot be found by component tests and will all
surface at once when the app is finally assembled, against a much larger surface than if it had been
assembled early. Budget for that; it is deferred work, not absent work.

Note for whoever assembles it: the harness is easy to mistake for a working app because it renders
real components at both viewports and screenshots them. It does not exercise routing, data fetching,
pairing or the daemon connection. Do not treat a green harness as evidence the app works.

Hosting is already settled — Cloudflare Pages, public site — see `docs/design/migration-plan.md`
§12.1 for the constraints that follow from it.
