---
id: ci-cd
title: CI/CD Workflows
---

# CI/CD Workflows

GitHub Actions supplies triggers, permissions, runners, and secrets. Repository logic lives in
executable `scripts/` files and runs inside the matching nix shell, so every job is a one-liner
and every job is reproducible on a laptop.

```yaml
- run: nix develop .#ci -c ./scripts/ci/pre-commit.sh
```

If a workflow step contains repository logic beyond that shape, the logic is in the wrong place
— move it into a script ([Shell Script Conventions](../shell-scripts/index.md)).

## Runners

**Quick Checks runs on every PR push; the full set runs before merge.** Both run on
`main` and manual dispatch. A PR opts into the full set with the `full-ci` label;
every subsequent push with that label runs it again, proving the exact head SHA.
Adding any other label is a no-op and uses its own concurrency group, so it cannot
cancel a running set.

| Set / job                                                | PR runner           | Other events                          | Work                                                        |
| -------------------------------------------------------- | ------------------- | ------------------------------------- | ----------------------------------------------------------- |
| Quick Checks                                             | Namespace 8x16      | Namespace 4x8 on main; dispatch picks | units first, then format/gates/build; complete unit ledger  |
| Integration Tests                                        | Namespace 8x16      | Namespace 8x16                        | six isolated groups, then the integration ledger            |
| Full Gates                                               | Namespace 4x8       | GitHub                                | both Knip checks and route agreement (Knip needs >4GB)      |
| Compile Binaries + SIT                                   | Namespace 2x4       | GitHub                                | cross-compile, upload the binaries, then SIT on those bytes |
| E2E shards                                               | Namespace 2x4       | GitHub                                | journeys and advisory policy as before                      |
| PWA Settings / Gallery                                   | Namespace 2x4 / 4x8 | GitHub                                | existing geometry assertions and evidence                   |
| Realworld Tests (advisory, nightly only)                 | not run             | Namespace 8x16 (nightly, dispatch)    | machine budgets on a quiet dedicated VM                     |
| Linux smoke and macOS jobs                               | GitHub              | GitHub                                | stock platform proofs; existing macOS policy                |
| Full CI Pending, Full CI, PWA/E2E relevance, E2E summary | GitHub              | GitHub                                | seconds of API/shell work, no Nix                           |

The owner's **2026-11-06 direction (Go given)** supersedes the Oct 30 prohibition
on processes inside a job for **Quick Checks and Integration Tests only**: consolidate
onto larger machines, share setup once, and run their existing parts as processes. The same
direction permits the one new job `Full Gates` (below), which keeps Knip and the route check out
of the compile job's critical path.
No check, group or shard is dropped. Other jobs retain their existing runner choices
and `vars.CI_RUNNER_POOL` escape hatch; this change does not alter repository variables.
Quick and Integration deliberately always use Namespace with the cache volume.

The Oct 30 per-job table is historical: two pre-commit runners (2x4/4x8), a 2x4
build runner, three 2x4 unit runners, six 2x4 integration runners and two ledger runners
attached separately. Measurements through Nov 6 found about 136 unit-minutes per PR
push, with runner queues and repeated pushes dominating the bill. The consolidated
Quick and label-triggered Full sets replace that shape; PR CI runs supply the new timings.

- **One shared Nix cache.** Every Namespace job retains `-with-cache`, tag
  `ferretry-nix`, `nscloud-cache-size-10gb` and
  `nscloud-cache-allow-commit-from-main`. The cache action mounts `/nix`
  **before** installing Nix. Only `main` commits the volume; Quick Checks now owns
  its prune step (`scripts/ci/nix-store-hygiene.sh`), preserving both the dev shell
  and documented install bundle. The label requests 10 GB but measurements and the
  provider's minimum show a roughly 20 GB volume; it does not halve snapshot charges.
- **One install before parallel work.** Quick and Integration enter the dev shell once
  (including hook setup), run locked workspace setup once, and set
  `FY_CI_SETUP_DONE=1` for their children. PWA and Worker builds reuse those links.
  Coverage, configs, logs and pre-commit caches are separate per part. Format checks
  run on an independent tracked-file snapshot: treefmt rewrites files even when
  reporting a formatting failure, so it must not alter inputs under the other parts.
  Integration's
  `swept.sh` creates a unique short `/tmp/fyt.*` root and sealed HOME for every
  process; fixtures place Chrome profiles and tmux sockets there and request ports
  from the OS. Chrome warms once before the six groups start.
  Format-checking **all files** runs in Quick only (it is in the verdict's needs, so the full set
  cannot pass without it on the same SHA); the full-only `Full Gates` job does not repeat it.
  Changed-file-only formatting was declined by the owner; a separate formatter change can
  improve its speed later.
- **Every part reports.** `scripts/ci/parallel.sh` captures each part's log and exit
  status, waits for all parts even after a failure, and writes per-part durations to
  the job summary and `coverage/ci/<set>/results.tsv`. Each tier's 100% ledger runs
  in the same job after its groups; a missing or failed group keeps the job red.
  Quick finishes all unit groups first, then runs format/gates/build under
  `nice -n 10`. The first 8x16 run doubled the archive unit test from 3.819 seconds
  on its separate runner to 8.371 seconds, so the owner/lead contention rule requires
  this ordering rather than a timeout increase. Its summary names each group's
  slowest test and duration from JUnit, with `unit-timings.tsv` in the part artifact.
- **Parallel read-only hooks.** Quick discovers hooks from the generated pre-commit
  configuration and runs four at a time on PRs (two on main), each with its own output, duration and
  temporary pre-commit cache. Their scripts do not write checkout files; the hook
  installation proof writes only to its own temporary repositories. Treefmt is the
  writing hook and stays isolated in the format snapshot. Locally hook concurrency
  is one, so `task ci:quick` still bounds heavy work to two parts.
  Knip's two hooks and route-agreement run serially in the `Full Gates` job (`full-gates.sh`),
  not in Quick and not in `compile`; the complete Quick + Full hook union, with every hook's
  stages checked against a known set, is validated. Because `quick.sh` exports
  `FY_CI_QUICK_GATES=1`, a local `task ci:quick` does **not** run Knip or route agreement;
  run `task lint` for those.
- **Incremental typechecking, same checks.** Quick mounts `~/.cache/ferretry-tsc`
  through the same Namespace cache action as `/nix`. `typecheck.sh` keeps one
  `tsbuildinfo` per project there when `FY_TSC_CACHE_DIR` is set (`quick.sh` derives it from
  `${HOME}` in CI, the one spelling that matches the cache path, and empties it first on `main`
  so main always re-seeds from a clean non-incremental proof); TypeScript still
  checks every project, including tests. Quick runs on Namespace on `main` too,
  and only `main` commits this volume, so PRs reuse main's cache without publishing
  their own. Local typechecks keep their ordinary non-incremental default.
  The Quick summary records the cache action's exact hit/miss output (or unknown),
  so partial/missing cache paths remain visible rather than inferred from speed.
  Main's Quick uses Namespace 4x8, with up to three parts and two gate hooks at once;
  Knip is outside Quick, and units finish before builds/typechecks start, limiting
  memory overlap. A `workflow_dispatch` input `quick_shape` (8x16 default, or 4x8) lets a branch
  measure main's 4x8 shape before merge; pull requests and main ignore it.
- **Measure instances, not just step time.** One unit-minute is one vCPU with 2 GB RAM
  for a billed minute, with a one-minute minimum per instance. Namespace instance
  lifetime includes boot/teardown; cache snapshots bill attached GB × instance-hours.
  Use `nsc instance report --start <RFC3339> --out <file>` and sum units × billed
  minutes per instance. GitHub job durations alone exclude that overhead.
- **The pinned toolchain remains required.** The image's Node never runs builds:
  `scripts/validate/pinned-toolchain.sh` holds Node and Bun to `/nix/store`.

## macOS jobs on a pull request

macOS runs on GitHub only, is free for a public repository, and **only 5 macOS jobs run at once across
the whole account**. Every run used 4 of them (Containment, Sandbox Shell (Safari), Harness Contract
`macos-15`, Smoke `darwin-arm64`), so two overlapping runs queued: the p90 wait was 6 minutes and the
worst 74. The queue, not the work, held pull requests up, and there is no paid pool to buy out of it
(Namespace macOS is ten times a Linux unit's price, ~$600 a month at this pace).

Within a PR’s full set, **Smoke always runs** (unless the owner’s macOS switch skips it); the three realworld proofs run **only when their inputs change**. The Realworld timing tests (`Realworld Tests`) do not run on a pull request at all: they run nightly and on dispatch ([Realworld workflow](#realworld-workflow)).
`main`, a manual dispatch and any doubt run all four, so a path list that missed an input shows up
one merge later. Smoke stays in `ci.yaml` (as the `smoke-darwin` call into the reusable `smoke-darwin.yaml`, [below](#macos-runner-shortage)). The other three, and the job that decides them, are the
realworld tier's: they live in `realworld.yaml`, so a macOS queue never holds up a pull request or a
release, and a failure on `main` files an issue ([Realworld workflow](#realworld-workflow)).

| Job (check name)              | On a pull request, when this changes                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Smoke darwin-arm64`          | every full set: it runs the shipped binary                                                                                                                                                                              |
| `Containment (macOS)`         | the daemon's file viewer, pinner, git, process inventory, pane identity and file-event code; `fy attach`'s tmux reader; the protocol's process incarnation; their integration tests; `scripts/ci/darwin-confinement.sh` |
| `Sandbox Shell (Safari)`      | `packages/pwa/harness/fy-render-safari/`, `packages/pwa/scripts/`, `public/_headers`, the `fy-render` library and journey fixture; `scripts/ci/safari-render-proof.sh`                                                  |
| `Harness Contract (macos-15)` | `packages/fleet/**`, the daemon contract suite and transcript conversion, `VERIFIED_HARNESS_VERSIONS`. The nightly `Harness Contract (latest)` covers upstream drift in between                                         |

All three also run when anything in the **toolchain or the pipeline** changes: `flake.lock`,
`flake.nix`, `nix/**`, `.github/workflows/realworld.yaml`, `.github/actions/**`, `bun.lock`, a manifest,
a bunfig or tsconfig, or `setup.sh`. (`ci.yaml` is not on the list: it no longer defines any of the three.) The Linux leg of `Harness Contract` always runs; only its `macos-15` leg is added
to the matrix.

- **A job, not a `paths` filter** — for the reason `E2E Relevance` gives. `macOS Relevance`
  (`changes` in `realworld.yaml`, `scripts/ci/macos-relevance.sh`) lists the pull request's files through the API
  and writes one output per job. A job it leaves out is **skipped, and a skipped check counts as
  passed**, so no stub check and no branch-protection change is needed (and nothing in branch
  protection names them anyway). It fails open: an unreadable or
  empty file list runs all three.
- **The lists are generous on purpose** and held to the scripts, not to memory:
  `scripts/validate/macos-relevance.sh` (`a-macos-relevance`, and `test.sh`) extracts every test path
  `darwin-confinement.sh` runs, every file the Safari probe and the contract suite import, and the
  `VERIFIED_HARNESS_VERSIONS` file, and fails unless each one selects its job. It also fails if a
  docs-only change selects any job, if `flake.lock` or a workflow does not select all three, or if
  `realworld.yaml` stops gating them, `ci.yaml` starts gating Smoke or defines one of them again, or
  `realworld.yaml`'s `pull_request` `paths:` stop covering an input. Adding a path to a job's script therefore
  fails pre-commit until the list covers it.
- **Why the Harness matrix is data.** A job-level `if:` cannot read `matrix`, so the `macos-15` leg is
  in or out through `fromJSON(needs.changes.outputs.harness_os)`; the check keeps its name,
  `Harness Contract (macos-15)`, when it runs and is absent when it does not.

## macOS runner shortage

**GitHub's macOS pool can have no runner to give.** When it does, the job waits about 15 minutes and
GitHub **cancels** it with "job not acquired by Runner": no step ran, so nothing failed and nothing was
proved. On 2026-11-02 that cancelled `Smoke darwin-arm64`, `Harness Contract (macos-15)` and
`Containment (macOS)` on pull request after pull request and turned them red. `timeout-minutes` cannot help (it
bounds a job that has a runner, not the queue), and there is no paid pool to buy out of it, so the policy is
about **how a missing runner is read**, never about spending: every macOS job asks for the free standard
`macos-15`, never a larger, a Namespace or a self-hosted macOS runner.

| Where                       | A macOS job that ran and failed                                                    | A macOS job that never got a runner                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Pull request**            | red for `Smoke darwin-arm64`; the realworld macOS proofs are masked (never gating) | **advisory**: a warning and the job-summary line `macOS runner not available; advisory on PRs` |
| **`main` push**             | red; `Smoke darwin-arm64` holds `Release` back, the realworld proofs file an issue | smoke: re-queued up to 3 times, then red; realworld proofs: one attempt, not reported          |
| **Release tag** (`cd.yaml`) | red; nothing is published                                                          | re-queued up to 3 times, then red, saying the runner was unavailable                           |

The Linux jobs are never softened: `Smoke linux-x64-baseline`, `Smoke linux-arm64`, `Unit`/`Integration`
Tests and SIT (a step of `Compile Binaries + SIT`) stay required within every full set. The Linux leg of `Harness Contract`
keeps its unmasked result inside the advisory Realworld workflow.

- **Smoke is one reusable workflow, `smoke-darwin.yaml`.** `ci.yaml` (needs `compile`) and `cd.yaml`
  (needs its own `compile`, so a release proves the darwin binary on a Mac before GoReleaser publishes) call it
  with `advisory: ${{ github.event_name == 'pull_request' }}` and `advisory: false`. It has three `macos-15`
  attempts (`timeout-minutes: 10` each), a Linux backoff between them (120 s, then 300 s), and a `Verdict` job
  on Linux: the check that stands for the smoke. Each attempt's first step writes `started=true` to its job
  outputs, and **`started` is the source of truth, never the attempt's `result`**: GitHub shows a job it never
  gave a runner as "cancelled" but hands the workflow `result: abandoned` for it. An attempt that is not a
  success and has no `started` is **"no runner"**; one with `started` that did not succeed is **"ran and
  failed"** (`result: failure`) or **"cut off"** (anything else). Only "no runner" re-queues, and only off a
  pull request.
- **A smoke that ran and failed is never retried**, on a pull request or off one: the flake rule below
  (fix the root, never retry) still holds. `scripts/ci/macos-smoke-verdict.sh` judges the attempts: any pass is green; any failure that ran is
  red; no attempt having run is `macOS runner not available; advisory on PRs` (green, warning) on a pull request and
  `macOS runner not available after N attempt(s)` (red, with "not a smoke failure" and "re-run the job") elsewhere.
  It writes the same line to the job summary.
- **The realworld macOS proofs** (`Containment (macOS)`, `Sandbox Shell (Safari)`, `Harness Contract
(macos-15)` and the nightly `Harness Contract (latest) (macos-15)`) carry a pull-request-only
  `continue-on-error`, so on a PR neither a lost runner nor a failed proof reddens the workflow; the Linux legs
  are not masked. The mask cannot tell the two apart (GitHub reports a masked failure as a success), so a real
  macOS failure on a PR is visible only in that job's log. That is accepted: these are the realworld tier, which
  never gated a PR or a release ([Release gating](#release-gating)). `macOS Advisory`
  (`scripts/ci/macos-advisory.sh`) writes the summary line when a job was cancelled. On `main` and the nightly
  they run unmasked, **once** (no re-queue), and `report` files an issue when one fails; a job that never got a
  runner there is cancelled and is not reported, and the next push or nightly runs it again.
- **The raw macOS check can still read "cancelled".** A check run GitHub cancelled stays cancelled whatever the
  workflow does. What the policy changes is every verdict built on it: `Smoke darwin-arm64 / Verdict`
  is green on a PR whose macOS smoke never started, and no required Linux check depends on a macOS job. Merge on the
  Linux checks and `Verdict`; read a cancelled raw macOS check as "no runner", not as a failure.
- **Held by `scripts/validate/macos-relevance.sh`** (section 7): `ci.yaml` calls `smoke-darwin.yaml` as advisory
  on pull requests only, with no macOS leg in the Linux `smoke` matrix; `cd.yaml` calls it with
  `advisory: false` and `goreleaser` needs it; the three attempts are `macos-15` with a ceiling and a `started`
  marker; the backoffs re-queue only a never-started attempt and never on a pull request; the realworld and
  nightly `continue-on-error` masks only macOS legs, only on a pull request; no workflow outside the policy
  names a macOS runner; none asks for a paid or self-hosted one; the verdict script decides the canned cases
  above as written (including an `abandoned` attempt and one that failed before its first step); and the
  `vars.MACOS_SMOKE` switch below is wired as written.

### The owner's switch: `vars.MACOS_SMOKE`

When the macOS pool has had no runner for hours, every release is held behind `Smoke darwin-arm64`. The
repository variable **`MACOS_SMOKE`** is the owner's way out, the macOS twin of `vars.CI_RUNNER_POOL`:

- **`MACOS_SMOKE=skip`** makes the `smoke-darwin` job in `ci.yaml` and `cd.yaml` not run at all
  (a job-level `if:`), so nothing waits 15 minutes for a runner. `CI` still succeeds, so `Release` still runs, and
  `GoReleaser Publish` runs when the smoke was **skipped by the switch** as well as when it passed. It never runs
  past a failed `compile` or a smoke that ran and failed.
- **It ships an unproven darwin binary.** Nothing else runs the cross-compiled darwin binary, so while the switch is
  on, a release is published without the darwin binary having started once on a Mac.
- **It is never silent.** `compile` (`ci.yaml`) and `goreleaser` (`cd.yaml`) run
  `scripts/ci/macos-smoke-skipped.sh`, which writes the warning and job-summary line `macOS smoke skipped by
vars.MACOS_SMOKE=skip (owner); darwin binary released unproven`.
- **Unset, or any value but `skip`, is today's behaviour**: advisory on a pull request, required and retried
  elsewhere. GitHub compares strings case-insensitively, so `SKIP` also skips, and it also warns.
- **Turn it off** with `gh variable delete MACOS_SMOKE` as soon as GitHub's macOS pool is back. Turn it on with
  `gh variable set MACOS_SMOKE --body skip`.

## Workflow split

| Workflow                      | Trigger                                                                                                   | Responsibility                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CI                            | PR opened/pushed/reopened; `full-ci` labeled; `main`; dispatch                                            | Quick every push; Full on labeled PRs and every non-PR run; exact-head Full CI status |
| E2E Slow                      | nightly, dispatch, relevant PRs with `full-ci`                                                            | slow journeys, existing advisory summary                                              |
| Realworld                     | nightly, dispatch (timing tests); `main` and relevant PRs with `full-ci` (macOS and tmux 3.8 proofs only) | machine budgets (nightly), macOS proofs and pinned harness contract; advisory         |
| Harness Contract (latest)     | nightly, dispatch                                                                                         | upstream drift and issue reports                                                      |
| Smoke darwin-arm64 (reusable) | called by CI and CD                                                                                       | existing advisory PR / required release policy                                        |
| Release                       | successful CI on `main`                                                                                   | version, changelog and release tag                                                    |
| CD                            | release tag                                                                                               | compile, required darwin smoke, publish                                               |

The fast E2E jobs now live in `ci.yaml`; there is no separate `e2e.yaml`.
Realworld and Slow remain advisory and outside the Full CI verdict. Release still
waits on the entire CI workflow on `main`, where Quick and Full both always run.

## CI jobs

| Job              | Check name                           | Work                                                                                                                                                |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quick`          | Quick Checks                         | `quick.sh`: format, gates, Nix install bundle, four Worker dry-runs, PWA build, three unit groups and their ledger                                  |
| `full-pending`   | Full CI Pending                      | immediately posts pending `Full CI` on `github.event.pull_request.head.sha`                                                                         |
| `int`            | Integration Tests                    | `integration.sh`: six groups in parallel and their 100% ledger                                                                                      |
| `full-gates`     | Full Gates                           | both Knip checks and route agreement, serially (format runs in Quick only)                                                                          |
| `compile`        | Compile Binaries + SIT               | compile, list and upload the binaries, then check `dist/bin` against its manifest and run SIT against those very files                              |
| `smoke`          | Smoke linux-\*                       | both Linux targets                                                                                                                                  |
| `smoke-darwin`   | Smoke darwin-arm64                   | reusable smoke and existing owner skip/advisory policy                                                                                              |
| `pwa-relevance`  | PWA Relevance                        | does this pull request change anything the PWA browser gate reads (`pwa-relevance.sh`); GitHub, no Nix                                              |
| `pwa-screenshot` | PWA Settings Geometry / Full Gallery | `needs: pwa-relevance`; skipped (and accepted by the verdict) only when it succeeded with `run == false`; existing geometry assertions and evidence |
| `relevance`      | E2E Relevance                        | decide whether journeys have anything to prove                                                                                                      |
| `journeys`       | E2E Shard (1..3)                     | existing three fast shards                                                                                                                          |
| `summary`        | E2E Journeys                         | existing relevance/advisory verdict                                                                                                                 |
| `full`           | Full CI                              | always judges all needed jobs when this is a full-set event; posts head-SHA status                                                                  |

**The merge gate is the commit status `Full CI` on the exact PR head SHA.** Quick
posts pending with `full set not run on this commit: add the full-ci label`. Full's
verdict posts success only after Quick and every required Full job passed (`PWA Relevance` included), allowing
only the existing explicit darwin skip, the E2E relevance skip, and a skipped `pwa-screenshot` when
`pwa-relevance` succeeded with `run == false`. A skipped Full job
on an unlabeled PR cannot turn the commit status green. Cancelled or failed jobs
cannot supply proof. Fork tokens cannot post statuses, so they cannot create a green gate.
**Only a `pull_request` run posts the status**: a `main` push or a `workflow_dispatch` (even on a PR branch,
which proves the branch alone and not its merge with `main`) only exits with the verdict, so a late green
dispatch can never replace a red pull-request status on the head.

The merger reads `gh api repos/kirinnee/ferretry/commits/<headSha>/statuses` and
requires the newest context `Full CI` from `github-actions[bot]` to be `success`,
alongside its existing checks. A new push has a new SHA and must earn its own proof.
After a real Full failure, the verdict removes `full-ci` from that same PR head,
so fix pushes run Quick until the PR is relabeled. Cancelled or superseded runs,
and skipped jobs without a real failure, do not remove it. Re-adding `full-ci` on the same head cancels
the old run: a cancelled job alone is ignored when a newer run of the workflow exists for that head SHA
(`actions/runs?head_sha=…`, id above `GITHUB_RUN_ID`; the verdict has `actions: read`), so the label that
was just re-added is never undone. A real `failure` always removes it. Only the Full verdict
has issue-label write permission; it rechecks the current PR head before removal.

Notable details:

- **Coverage is an artifact, and a gate.** `scripts/ci/test.sh` runs the tier with coverage and
  then asserts the ledger: every path is inside the tier's scope (`src/lib/` for unit,
  `src/adapters/` for int), the ledger is non-empty, every line is hit, and no source file is
  missing from it. The `coverage-<mode>` artifact uploads with `if: always()` so a failure is
  still inspectable. Tiers are described in [Testing](../testing/index.md).
- **Both tiers retain their complete group ledgers.** Quick runs all three unit
  groups and Integration runs all six integration groups from `config/test-groups.json`.
  Each group writes `coverage/<tier>/groups/<group>/lcov.info`. The in-job ledger
  refuses a missing group and requires one group's own 100% coverage per source
  file. Neither groups nor processes can borrow covered lines from siblings.
- **The int groups are balanced by measured test time.** `everything-else` used to hold 40 PWA
  browser-walk files (~350 s of per-file test time in one bun process) and was the last job to finish
  in most runs. 17 of them are now dealt out by name prefix in `config/test-groups.json` (`jump-latest-`,
  `chat-polish`, `chat-rerender` to `pwa-render`; `snooze`, `chat-history` and `agenda-` to `pwa-chat`;
  `inbox-` to `pwa-surfaces`; the `agenda-` walks sat in `daemon-runtime` first and, with that group's daemon
  suites in the same process, pushed a 4 GB runner to 91% RAM and were killed). All six groups share the one 8x16 `int`
  job, so a balanced deal is what keeps its wall near the slowest group. This costs the ledger nothing:
  the PWA has no `src/adapters`, and the `cli`, `fleet`, `protocol` and `relay` tests that cover those
  adapters stay in `everything-else` (`processes: 2`, whole packages dealt by file count). Rebalance by
  measuring per-file times from the job logs (bun prints each test's duration); a group name is a label
  for the CI job, not a promise about its contents.
- **The int tier warms Chrome before its clock starts.** The first Chrome a fresh runner starts is
  slow — on one slow VM longer than the agent browser's 20-second launch budget — so
  `scripts/ci/warm-chrome.sh` starts it once, headless, before the tests. A warm-up, not a gate or a
  retry: a Chrome that cannot start there is reported and left for the tests to fail on.
- **A known flake warns instead of blocking.** When every failing test in the unit or int tier is
  listed in `config/test-quarantine.json` (per int group too), `scripts/ci/quarantine.ts` reruns just those files once.
  If they pass, the job is green with a `::warning::` per test and a job-summary line naming its
  issue; the rerun's coverage is merged into the ledger before the 100% gate reads it. Any failure
  not on the list, or any error Bun reports outside a test, stays red. The rules are in
  [Testing](../testing/index.md#flaky-tests-and-the-quarantine).
- **SIT runs against the artifact, not a rebuild.** SIT is the last steps of `compile`: it
  runs `scripts/ci/test.sh sit` on `dist/bin` after the manifest is written, uploaded and checked
  again, so it tests the very bytes that were uploaded as `cli-binaries` and never a rebuild — which
  is what makes it a black-box test of the shipped thing. It was a job of its own (an instance, a
  queue wait and a ~25-35 s artifact download for ~1-2 min of tests); folding it in removes all three. The cost is that
  `smoke` and `smoke-darwin` (needs `compile`) now start after SIT passes, not beside it. The scripts
  restore the executable bit the artifact download drops.
- **A download is held to a manifest.** `actions/download-artifact` can stop part-way and still exit
  0 (actions/download-artifact#454): its log ends at `Starting download of artifact` with no digest
  line. That left `Smoke linux-x64-baseline` on `main` with no daemon in `dist/bin` while the other
  two smoke jobs took the same artifact whole. So `compile` writes `dist/bin/SHA256SUMS`
  (`scripts/ci/binaries-manifest.sh write`), and `smoke` takes the binaries only through
  `.github/actions/download-binaries`, which checks every file against it and, if one is short or
  missing, downloads once more into an empty directory with a `::warning::`. A second short download
  fails the step as an incomplete download, never as whatever ran next.
- **A browser gate asserts geometry, and never stores pixels.** `pwa-screenshot` runs the PWA's
  screenshot harness in `--settings-only` mode in light, and the whole gallery in dark, and fails on
  `assertNoSidewaysScroll` — the one layout defect a capture cannot show, because the capture is
  clipped to the viewport it overflows. The PNGs upload with `if: always()` as evidence; nothing
  compares them, and `.gitignore` keeps them out of the tree. The harness asserts its own tally of
  checks and the script requires that closing line, so a refactor that stops the checks running is
  red rather than green. Adding or removing a Settings surface means editing one integer, which is
  the churn this shape chose over re-baselining a directory of images. The dark leg walks the whole
  gallery, so a later section that hangs or fails is red on the PR that broke it rather than on the
  next person who needs its frames — and it owes the same Settings tallies a dark `--settings-only`
  leg would, which is why there is no such leg. The viewports are walked one after the other: walking
  them at once, as three software-rendered Chromes on a 4x8, timed out in 3 of 7 runs under load.
- **The browser gate runs only when something it reads changed.** The three legs are ~19% of the
  Namespace bill (measured 2026-10-29 to 11-06: 63k of 339k unit-minutes) and about a quarter of pull
  requests change nothing they read — a daemon-only, CLI-only or docs-only change. `pwa-relevance`
  (`PWA Relevance`, `scripts/ci/pwa-relevance.sh`) lists the pull request's files through the API
  (a rename counts both its old and new path; a pull request of 3000 files or more, which the files API
  cuts off, always runs) and writes `run=true|false`; `pwa-screenshot` has `needs: pwa-relevance` and
  one single-line `if:` that adds the `full-ci` label conjuncts to `!cancelled() && needs.pwa-relevance.outputs.run != 'false'`
  (the label gate cannot be a second `if:` key), and `pwa-relevance` carries the same label `if:` itself, so an unlabelled
  pull request runs neither. When it is `false` every
  leg is **skipped, and a skipped check counts as passed** — no stub check, no branch-protection change,
  and a job and not `paths-ignore` for the reason `E2E Relevance` gives. **Only a `false` skips the
  gate**: a relevance job that failed, timed out or was skipped leaves the output empty and the gate
  runs, so the job fails open as well as the script. Another job may `need` `pwa-screenshot` only if its
  own `if:` starts with `always()` or `!cancelled()` (the `Full CI` verdict; the validator reads the
  `needs:` as an inline list, a block list or a flow sequence over several lines). The gate's `if:` is a
  conjunction (no top-level `||`) of `!cancelled()`, the relevance conjunct and nothing else but
  **event conjuncts**: expressions over `github.event` / `github.event_name` (a label, an action) built
  from `==`, `!=`, `!`, `&&`, `||`, `contains()` and quoted strings, which is how the `full-ci` label
  narrows when the whole workflow runs the gate. A literal such as `false`, a `needs`, `steps`, `env`, `vars` or
  `secrets` expression, or any other function fails the validator. What it cannot judge is whether an
  event conjunct means what it should: a reviewer owns that. The decision is self-contained: it reads
  nothing but the pull request's file list, so it holds however and whenever the gate is triggered.
  - **What selects the gate**: anything under `packages/pwa/`, `packages/protocol/`, `packages/relay/`
    or `packages/fleet/` (the PWA's workspace closure: it imports all three, and `fleet` and `relay`
    import `protocol`), the toolchain (`flake.nix`, `flake.lock`, `nix/**`, `bun.lock`, any
    `package.json`, `bunfig*.toml`, `tsconfig*`), `.github/**`, `scripts/ci/**` and
    `scripts/local/setup.sh`. The list is generous: a path that is not certainly irrelevant is relevant.
    `main`, the nightly and `workflow_dispatch` always run it, and any doubt (not a pull request, an
    unreadable or empty file list) runs it.
  - **Held to the code, not to memory**: `scripts/validate/pwa-relevance.sh` (`a-pwa-relevance`)
    traces every import of the harness bundle (`harness/screenshot.ts`, `harness/main.tsx`)
    transitively, resolves each workspace package it imports through the manifests, and fails unless
    every file or package outside `packages/pwa/` selects the gate. It also fails if a docs-only or
    daemon-only change selects it, if a change that mixes docs with one input does not, if `main`,
    dispatch or any doubt would skip it, or if `ci.yaml` stops gating exactly `pwa-screenshot` on the
    decision or lets the relevance job grow a nix shell, a Namespace runner or a `needs`. It checks the
    fail-open `if:` and the allow-list of its other conjuncts, a dependant's `needs:` in all three YAML
    shapes (each tested against a fixture workflow), a rename moving an input out, a pull request over
    the files API's cut-off, that no relative import in the traced workspace packages leaves its own
    package, and that no `@ferretry/*` import in them names a package their `package.json` does not
    declare (bun hoisting would resolve it, the manifest-following trace would not).
  - **It adds ~10 s before the gate legs can request runners**: it is `ubuntu-latest` with a sparse
    checkout of `scripts/ci` and two API calls, and `pwa-screenshot` cannot ask for its Namespace runner
    until it has queued and run (more when GitHub is busy). The gate waits on it, so keep it bare.
- **Smoke covers the platforms compile cannot.** `linux-x64-baseline` on `ubuntu-latest`,
  `linux-arm64` on `ubuntu-24.04-arm`; `darwin-arm64` on `macos-15` is the separate `smoke-darwin`
  job, whose runner may not come (see [macOS runner shortage](#macos-runner-shortage)). Smoke is the one job that
  does not enter a nix shell — it only needs the downloaded binary and `jq` — and it derives
  the binary name from the CLI package's `bin` key so the matrix stays rename-proof
  ([Architecture](../architecture/index.md)).

## Realworld workflow

`.github/workflows/realworld.yaml` is the fourth test tier's own workflow
([Testing](../testing/index.md#the-four-tiers-concretely)): what depends on the machine as much as on the
code, run where a failure cannot hold anything up.

| Job                    | Runs                                                           | Runner         | Ceiling |
| ---------------------- | -------------------------------------------------------------- | -------------- | ------- |
| `realworld`            | `nix develop .#ci -c ./scripts/ci/test.sh realworld`           | Namespace 8x16 | 30 min  |
| `changes`              | `./scripts/ci/macos-relevance.sh` (`macOS Relevance`)          | GitHub         | 5 min   |
| `darwin-confinement`   | `./scripts/ci/darwin-confinement.sh` (`Containment (macOS)`)   | GitHub macOS   | 20 min  |
| `safari-sandbox-shell` | `scripts/ci/safari-render-proof.sh` (`Sandbox Shell (Safari)`) | GitHub macOS   | 20 min  |
| `harness-contract`     | the pinned harness contract, Linux and `macos-15`              | GitHub         | 30 min  |
| `report`               | `scripts/ci/realworld-report.sh`                               | GitHub         | 10 min  |

- **Triggers.** The `realworld` job (the timing, memory and rate budgets) runs **only on the nightly
  schedule (09:17 UTC, off the hour, once a day on `main`) and on manual dispatch** — on a pull request
  or a push to `main` it is skipped. It cost ~9.4k Namespace runner-minutes a day when it ran on every
  full pull request and every merge, for a tier that gates nothing (owner's call, 2026-11-06). To measure
  a branch's budgets before the night, run the workflow by hand on that branch (Actions > Realworld >
  Run workflow). The rest of the workflow keeps its triggers: a push to `main` (the same `paths-ignore`
  as `CI`) and a pull request that touches the inputs of the macOS and tmux 3.8 jobs run those proofs
  (`bunfig.realworld.toml`, the workflow, its scripts, the toolchain), on free GitHub runners. A pull
  request that touches none of them starts no run.
- **The `realworld` job gets a Namespace 8x16 on every event that runs it.** Its budgets (an idle daemon's CPU and
  memory, a 200 ms event-loop bound under a saturated disk) are the claims a busy shared runner would
  fail for the wrong reason, so it takes a quiet dedicated VM and the pool's escape hatch
  (`vars.CI_RUNNER_POOL == 'github'`) like every Namespace job. It runs the tier swept, with the
  120-second per-test timeout on the command line, no coverage ledger, no quarantine and no rerun, and uploads
  `realworld-results` (JUnit and the console log). A red test fails the job, nothing else.
- **`report` files the failures.** The nightly's failure is visible as that issue (and as the red scheduled run). On a push or a scheduled run that fails, it reads the JUnit and the
  console log and, for each failing test, opens one issue titled `realworld: <file> > <test>` with the
  `realworld` label (created on first use), the run and job links and the lines before the failure; a
  test already open gets a comment instead. A macOS or harness job that failed files
  `realworld: <job>`. A job that died before any test ran files one issue naming it. It files at most
  25 per run. A pull request run never files: its author reads the job.
- **`Harness Contract (latest)`** (`harness-contract-latest.yaml`) is part of the same tier and is unchanged: a
  daily run of the contract suite against the newest upstream `claude-code` and `codex` that files its
  own issue on drift.
- **Concurrency.** Like `CI`, a pull request's runs are grouped by its number and a newer push cancels
  the older, and every push to `main` shares one group with `cancel-in-progress: false` — exactly the
  shape `ci.yaml` uses: one run running, one waiting, and a newer push replaces the waiting one. A burst
  of merges therefore runs the tier at most twice instead of once per merge (it ran 557 times in nine
  days, each on a 4x8), and a run that has started is never cancelled. Nothing is lost: the tier only
  files issues, and the newer run proves every commit the older one held (the `main` group now holds only the macOS and tmux 3.8 proofs). The nightly and a manual
  dispatch keep a group of their own run id, so neither is ever superseded or supersedes a `main` run.

## Release gating

**`Release` waits on `CI` and nothing else.** It fires on the `workflow_run` of `CI` on `main`
(see [Release and CD](#release-and-cd)), so a version ships when the unit and integration tiers, the
ledgers, SIT, the build checks and the cross-platform smoke are green. `Realworld` is a different
workflow: `Release` never sees it, so it cannot delay one, and a failure on `main` or in the nightly files
an issue and **never blocks a release**. **Nothing in branch protection names a `Realworld` job**,
and none should: a required check there would make a quiet-machine claim a merge gate again, which is
what the tier exists to avoid. When a realworld issue is a real regression, the fix goes through a
normal pull request.

The contrary rule is the one for the blocking tiers: a flake there is a bug in the test or the
product, fixed at the root, never retried ([Testing](../testing/index.md#the-four-tiers-concretely)).

## E2E tier

The fast tier runs inside `ci.yaml` as part of Full: on `full-ci` PRs, `main` and dispatch. Its check names, evidence, relevance decisions and advisory journey policy are unchanged.

`E2E` (`.github/workflows/ci.yaml`) runs every journey in `tests/e2e/` against the compiled `fy`/`fyd`, the
real built PWA, the runner's Google Chrome and a local rendezvous ([Testing](../testing/index.md)). Each
runner runs `nix develop .#ci -c ./scripts/ci/e2e.sh`, which compiles this host's binaries and hands off to
`scripts/test/run-e2e.sh`. That script resolves the real tmux and the compiled CLI, typechecks the
harness, owns the suite root and cleans it up.

| Job         | Check name         | Runs                                                                                      |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `relevance` | `E2E Relevance`    | `scripts/ci/e2e-relevance.sh`: does this pull request have anything for the tier to prove |
| `journeys`  | `E2E Shard (1..3)` | `FY_E2E_TIER=fast FY_E2E_SHARD=i/3 ./scripts/ci/e2e.sh`, one share of the journeys each   |
| `summary`   | **`E2E Journeys`** | `scripts/ci/e2e-summary.sh`: the one status, adding up every shard                        |

`E2E Slow` (`.github/workflows/e2e-slow.yaml`) runs the `[slow]` journeys the same way, one per shard,
into **`E2E Slow Journeys`**.

- **One status, whatever the shard count.** Branch protection and merge tooling wait on `E2E Journeys`.
  The shard jobs are named differently so that nothing waits on them by accident. The summary runs
  unless the run was cancelled. It is green when the run had nothing to prove or every shard job
  finished. It is red when the relevance check or a shard job did not finish: a setup step failed, a
  runner died, or the matrix was cancelled.
- **Docs-only and model-catalog-only pull requests skip the journeys** and still report `E2E Journeys`
  green. The full set runs on labeled pull requests, and the `relevance` job lists the pull request's
  files. When every one is under `docs/`, ends in `.md`, or is under `packages/fleet/models/`, no shard
  starts. It is a job and not a workflow `paths-ignore` because a filtered-out workflow never posts
  its status, so a merge waiting on that status waits forever. The usual fix is a stub workflow that
  reports the same name on the ignored paths. That stub also fires on a mixed pull request, so a green
  stub then sits beside the real check. The decision fails open: if it can't list the files, the
  journeys run.
- **Split by test, balanced by measured time.** `bun test --shard` splits by file, and one file holds
  about five minutes of the tier. `scripts/ci/e2e-shards.ts` lists every journey with Bun's own JUnit
  report: a run whose name pattern matches nothing loads every file in ~0.5 s and runs nothing. It
  then places the longest journeys first, each on the least-loaded shard. Times come from
  `tests/e2e/timings.json`, and a journey with no recorded time counts as 10 s. Each shard gets its
  files plus one anchored `--test-name-pattern`. Every runner computes the same plan from the same
  checkout. The plan, with each journey's expected seconds, is printed at the top of the shard's log.
- **Regenerating the timings.** Every shard writes `junit.xml` into its evidence. Download a green
  run's `e2e-evidence-*` artifacts, plus an `E2E Slow` run's for the slow journeys, and run
  `bun scripts/ci/e2e-shards.ts timings <junit.xml>…`. Times measured in the reports replace the
  recorded ones. Journeys the reports did not run keep their times, and journeys that no longer exist
  are dropped. A local `FY_E2E_JUNIT=<file> task test:e2e` writes a report too, but a laptop's times
  are not a runner's.
- **`[slow]` journeys run in `E2E Slow`.** A journey whose title ends in `[slow]` waits on purpose,
  for a minute or more: a relayed page left idle, a tab frozen past the relay's eviction grace, a
  relay restarted again and again under a live page. `E2E` runs the `fast` tier, which is everything else.
  `E2E Slow` runs the slow tier nightly, on manual dispatch, and on a `full-ci` pull request that touches the
  code those journeys prove: `packages/relay`, the daemon's relay, carrier and socket code, and the
  PWA's connection, transport and relay code (the workflow lists the paths). Those pull requests get
  both workflows, and the slow journeys run in parallel with the rest. It does not run on every push
  to `main`: that was 342 runs in two weeks of three shards on the capped free GitHub pool,
  re-proving what the pull request had already proved, and a change elsewhere that breaks a slow
  journey is caught by the nightly run. Tag a journey `[slow]` only when its length is the point. A
  journey that is slow because it polls or sleeps should wait on a condition instead.
- **A hang costs one journey's ceiling, never a shard.** `scripts/test/run-e2e.sh` owns one per-journey
  ceiling, 150 s, and passes it to Bun as `--timeout`. `scripts/test/e2e-journey-timeouts.ts` runs before
  the journeys and fails the tier when a journey outside `[slow]` raises its own timeout past that
  ceiling, because Bun lets a test's own timeout win. A browser call cannot wait forever either. When
  Bun silently loses the DevTools pipe to Chrome, every call on that browser fails at once with
  `browser has disconnected`. The loss is found from Chrome's own log, an unrequested exit, or a
  probe of Chrome's browser process that gets no reply. The journey retry then runs it again, up to
  twice (`tests/e2e/README.md`). Before this,
  two journeys hung their shards for 600 s and 900 s.
- **No build-once job, measured.** A shard spends about 40 s before its first journey. Of that, about
  20 s is the Nix shell (substituted from cache.nixos.org, nothing built), about 2 s is `bun install`,
  about 3 s is the harness typecheck. Compiling is only the host's target: `e2e.sh` sets
  `COMPILE_TARGETS=linux-x64-baseline` (derived from `uname`, the way `run-e2e.sh` resolves the CLI and
  the journeys name the daemon), where all nine release binaries took 6–15 s; the release path never sets
  it and still compiles every target. A job that compiled
  once and handed the binaries to the shards would save that per shard. It would also add a whole
  job's startup, setup and artifact round trip in front of every shard, which is a net loss of wall
  clock. The PWA bundle cannot be shared either: it is built inside the suite, against the loopback
  relay directory's port, and takes about 5 s.
- **One Chrome per journey, measured.** A headless Chrome launches and closes in about 0.5 s, so
  sharing one browser across a shard would save a few seconds per shard. The cost would be isolation:
  each journey launches with its own flags, user agent and virtual authenticator, and some journeys
  close their own browser mid-journey. Most fixed sleeps that remain in the journeys are observation
  windows for a negative assertion ("the prompt did not come back", "still serving two seconds
  later"). Replacing one with "wait until" would pass at the first instant the condition holds and
  weaken the assertion.
- **Evidence is an artifact.** Each shard uploads `e2e-evidence-<shard>-<attempt>` (`E2E Slow`:
  `e2e-slow-evidence-…`) with `if: always()`. It holds every screen the journeys reached at 390 px and
  1280 px in both colour schemes, the per-step journey log, the relay ledgers, the JUnit report and the
  shard's `result.json`. The summary reads only the small `e2e-result-<shard>-<attempt>` artifacts.
  After "re-run failed jobs", it counts each shard's latest attempt.
- **Advisory, and visibly so.** Each shard's journeys step runs with `continue-on-error: true`, so a
  failing journey leaves the checks green. Failures still land in four places: the shard's job summary,
  a warning annotation, the `E2E Journeys` tally with every failing test listed, and the evidence
  artifact. When the tier becomes required, `continue-on-error` is removed in the same change, and the
  summary fails when any shard's `result.json` reports a non-zero exit.
- **Advisory never means "silently never runs".** `scripts/ci/e2e-summary.sh` fails `E2E Journeys` when
  NO shard left a `result.json` ("E2E harness produced no results: the journeys did not run"): every
  shard job was green, but the harness died before the first journey (a typecheck error in
  `scripts/test/**` once did this to every shard in ~20 s, and the run still went green with a warning
  nobody reads). A result counts only with numeric `passed` and `failed`: a harness that dies before its
  tally writes `null`s, and that set, or a 0-total set with any non-zero exit status, fails the same way. A
  partial set (some shards without a result) and failing journeys stay advisory, as
  above. `a-e2e-harness-typecheck` ([Linting](../linting/index.md)) runs the harness's own `tsc` step in
  Quick so that error is caught before Full, and `scripts/test/ci-sets.ts` pins both the zero-result
  failure, the null/0-total cases and the advisory cases.
- **It is NOT a required check yet.** The tier drives a real browser through Bun, and Bun 1.3 occasionally
  drops a child's pipes. The harness retries those failures, or bounds them and names them, but the real
  flake rate on hosted runners is unmeasured. It becomes a required branch-protection check after **two
  weeks** of runs, measured from the merge of the change that added this section. If the rate is not
  close to zero by then, a flake goes on record as a bug with its run, rather than the check being
  required anyway.
- **A known open bug does not turn it red, and cannot hide.** A journey step that asserts a reported, still-open
  product bug passes `softStep` a `knownWhen` pattern. While that exact failure reproduces, the step is
  logged as `KNOWN` with its bug note. Once it passes, the run fails with "remove the marker". Any other
  failure of that step is an ordinary failure.
- **About three and a half to four and a half minutes per pull request** on `ubuntu-latest`. Four
  shards each run about 2–2.5 minutes of journeys after about 40 s of setup. `E2E Slow` takes about
  five minutes; the idle journey alone runs for about four. Before the split, the tier was one job of
  13–25 minutes, with 12–24 of them spent in the journeys. Each shard has `timeout-minutes: 20`
  (`E2E Slow`: 25), so a wedged browser cannot hold a runner for six hours.

## Job ceilings

Every CI job carries `timeout-minutes`, sized at about two to three times its normal duration. It is a
**ceiling, not a retry**: a job that reaches it is red, and the log says it was cancelled. Without one,
a wedged job holds its runner for GitHub's six-hour default. On 2026-10-29 the daemon integration group
hung inside a test and held its runner for two hours, three runs in a row, before anyone cancelled it.

- The consolidated integration job (`int`) has `timeout-minutes: 20`; its six groups run at once on one
  8x16 runner, so the job takes about as long as its slowest group plus setup and the ledger.
- The e2e shards have `timeout-minutes: 20` (`E2E Slow`: 25); see [E2E tier](#e2e-tier).
- The [realworld workflow](#realworld-workflow) jobs: `realworld` 30, `harness-contract` 30,
  `darwin-confinement` 20, `safari-sandbox-shell` 20, `report` 10, `changes` 5. A machine-dependent test
  that hangs is a red realworld job, never a held runner.
- Every other job, sized at two to three times its p95 over the week to 2026-10-29: `CI` —
  `quick` 20, `pwa-screenshot` 20, `pwa-relevance` 5, `full-gates` 15, `compile` (with SIT) 20,
  `smoke` 10, `full-pending` and `full` 5; E2E relevance and summary 5; `Harness Contract (latest)`
  20 and its report 10; `CD` `compile` 15, `goreleaser` 30 and `sign` 15; the darwin smoke
  (`smoke-darwin.yaml`) attempts 10 each, backoffs 5 and 8, verdict 5; `macOS Advisory` 5; `Deploy PWA to Pages` build 15, sign 10,
  deploy 10; `Deploy Hosted Relay` jobs 20; `Release` 20.
- A new job states its ceiling when it is added, sized from its first green runs.
  `scripts/validate/job-ceilings.sh` refuses a workflow job without one.

The ceiling is the last net. The unit and integration tiers stop sooner on their own:
`scripts/test/stall-watch.ts` kills a `bun test` run that has printed nothing for
`FY_TEST_STALL_SECONDS` (default 300, over twice the per-test budget), and first prints the last line,
the live processes and every thread, with stacks when `gdb` is on the PATH. See
[Testing](../testing/index.md).

## One run per commit

`CI` runs once for each commit under test: a pull request through its `pull_request` run, `main`
through its `push` run (the run `Release` waits on), and anything else through `workflow_dispatch`.
`push` is filtered to `main` on purpose. When it fired for every branch and tag, each PR ran every
job twice — the branch push and the PR — and each release ran them a third time on the tag, whose
tree the `main` run of the release commit had already proved. The duplicates drew on the same
runner pool as the runs that mattered, and macOS runners are the scarcest part of it.

`push` also ignores a commit that changes only `Casks/**`. That is GoReleaser's cask update, pushed
by `CD` after a release has shipped, and no job reads it. It ignores semantic-release's own
`release: X.Y.Z` commit for the same reason: that commit writes only `VERSION`, `Changelog.md`,
`Changelog.old.md` and the version in `packages/cli/package.json` and `packages/daemon/package.json`
(the `@semantic-release/git` assets in `.releaserc.yaml`), over a tree whose parent has a run of its
own, and `Release` has nothing left to release for it. It was a third of all `main` runs — 170 of
513 in two weeks, each billing every Namespace job. A commit that touches any other file runs everything.

## Superseded runs

A new push makes the run for the old SHA worthless, so `CI` cancels it rather than letting it hold a
runner. Its top-level `concurrency` block keys the group on the PR number for `pull_request`
events, with `cancel-in-progress` true for exactly that case.

A push to `main` falls into ONE shared group, `CI-main`, without `cancel-in-progress`: at most one
`main` run is in progress and one waits, and a newer push replaces the waiting one. Until 2026-10-30
each `main` run had a group of its own `run_id`, so every merge queued a full run on GitHub's runners;
a burst of merges left twelve of them queued for over an hour behind pull-request jobs, the integration
ledger gate of each waiting for a runner, and no release went out. Replacing a waiting run loses
nothing: `Release` releases `main`'s head (it checks out the default branch, not the run's SHA, and
semantic-release reads every commit since the last tag), and the newer run proves every commit the
replaced one held. A run in progress is never cancelled, so a steady stream of merges cannot starve
`Release` either. A manual dispatch keeps a group of its own `run_id`.
The deploying workflows (`CD`, `Release`, `PWA Pages`,
`Hosted Relay`) never cancel an in-progress run: they have no group, or a fixed one without
`cancel-in-progress`. A new `pull_request` workflow copies the `CI` block; a deploy never
does.

## Release and CD

```yaml
# release.yaml
on:
  workflow_run:
    workflows: ['CI']
    branches: [main]
    types: [completed]
concurrency:
  group: release
```

`Release` runs only `if: github.event.workflow_run.conclusion == 'success'`, with
`fetch-depth: 0` so semantic-release can read the full history, and calls
`nix develop .#ci -c ./scripts/ci/release.sh`. The single `release` concurrency group means two
merges in quick succession cannot race for the same version.

**`Release` must authenticate with a PAT or GitHub App token, not `GITHUB_TOKEN`.** Tags pushed
with the default token do not trigger further workflows, so a `GITHUB_TOKEN` tag would leave CD
un-fired and no release published. The job passes `secrets.RELEASE_TOKEN`.

`CD` reacts to the tag. Before it publishes anything it compiles the binaries once more and starts the
darwin-arm64 one on a real Mac (`smoke-darwin`, `advisory: false`): a release proves darwin works, a macOS
runner that never comes is re-queued up to 3 times, and only then does the release stop, saying the runner was
unavailable ([macOS runner shortage](#macos-runner-shortage)). `goreleaser` `needs` that job. It then checks out with `fetch-depth: 0`, and runs
`nix develop .#releaser -c ./scripts/release/publish.sh` — the `.#releaser` shell is the only
one with `goreleaser` and `go`. GoReleaser owns the GitHub release, archives, checksums, the
installer, and the in-repo Homebrew cask. See
[Semantic Release](../semantic-release/index.md) for what each half owns.

## Permissions and checkout

- Every job declares least-privilege `permissions:` explicitly — `contents: read` for CI jobs,
  `contents: write` only for `Release` and `CD`.
- Every checkout sets `persist-credentials: false`, so a compromised build step cannot reuse the
  checkout's credentials to push.
- Nix comes from the one local action `.github/actions/install-nix` ([Installing Nix](#installing-nix)),
  and checkout is always its own step before it.

## Installing Nix

Every job that needs Nix calls `uses: ./.github/actions/install-nix` (with `shell: .#releaser` in
`CD`), never `cachix/install-nix-action` directly. It is the one bespoke setup action (the other local
action, `download-binaries`, is described under the SIT bullet above), and it exists
because the network failed whole jobs, including on `main`, where a red CI skips a release:

- **The installer's download.** `cachix/install-nix-action` fetches its installer five times one
  second apart, which a DNS blip outlasts (`Could not resolve host: releases.nixos.org`). That fails
  before anything is installed, so the action installs once more after 60 seconds, with a
  `::warning::`, and never a third time.
- **A substitute's download.** `download-attempts = 10` and `connect-timeout = 15` go into
  `/etc/nix/nix.conf` for the daemon that does the downloading. They do not cover the failure that
  actually recurred: cache.nixos.org breaks a `.nar.zst` mid-file, Nix resumes it from that byte, the
  CDN answers the range with HTTP 416, and Nix stops with `path … is required, but there is no
substituter that can build it`. Only a fresh download recovers, so the action's last step runs
  `scripts/ci/nix-realise.sh <shell>`: `nix print-dev-env` realises the dev shell without running
  anything, at most three times, 20 then 40 seconds apart, each failure a `::warning::`. The job's
  real step then enters a shell that is already in the store, so a retry never reruns a test.

A real evaluation or build failure fails every attempt identically and reaches the PR about a minute
later than it would have; that is the whole cost. The cache volume step stays in each workflow,
BEFORE this action. `scripts/validate/action-pins.sh` reads `.github/actions/` as well as
`.github/workflows/`, so the pin inside the action is held to the same rules as any other.

## Action pins

Actions are classified in `config/action-trust.json` (`schemaVersion: 1`, each entry `trusted`
or `non-trusted`):

- **Trusted** actions pin a major tag (`actions/checkout@v5`). Currently trusted:
  `actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`,
  `cachix/install-nix-action`.
- **A job that holds a long-lived secret** pins EVERY action it runs to an exact SHA, trusted ones
  included (`pwa-pages.yaml`, whose jobs hold the release signing key and the Cloudflare token). A
  tag can be moved; a SHA cannot.
- **Everything else** pins an exact 40-character SHA with its tag as a trailing comment:

  ```yaml
  - uses: some/action@1234567890abcdef1234567890abcdef12345678 # v2.1.0
  ```

`scripts/validate/action-pins.sh trusted|non-trusted` enforces this from pre-commit and fails on
three separate mistakes: an action used but never classified, a classification that does not
match the pin style, and a classified action no longer used anywhere. The last rule keeps the
trust map from rotting into a list of actions nobody remembers.

## Local reproduction

Use the same entry points CI uses. `task ci:quick` runs the complete unit tier,
not only touched packages: the ledger requires every configured group.
`FY_CI_QUICK_PARALLEL` controls concurrency (default two locally, capped at two
outside CI; the workflow sets six). Do not run Integration, real tmux or E2E
on the shared development box; the full CI run proves those tiers.

```bash
task ci:quick                                  # local Quick set, at most two parts at once
nix develop .#ci -c ./scripts/ci/test.sh unit     # the whole unit tier and ledger
nix develop .#ci -c ./scripts/ci/test.sh sit      # SIT (compile first)
nix develop .#ci -c ./scripts/ci/pwa-screenshot-proof.sh   # the Settings geometry gate
./scripts/release/publish.sh --snapshot           # the whole CD lane, offline
```

`publish.sh --snapshot` builds every artifact with publishing disabled — it is the acceptance
test for release changes, and it needs no tokens.

## Adding a lane

1. Write `scripts/ci/<name>.sh` (or reuse a `scripts/release/*` script CI already shares).
2. Add a job whose only `run:` is `nix develop .#<shell> -c ./scripts/ci/<name>.sh`.
3. Declare the narrowest `permissions:` the job needs.
4. Classify any new action in `config/action-trust.json` and pin it accordingly.
5. If the job needs tools the shell lacks, add them through
   `nix/packages.nix` → `nix/env.nix` ([Nix](../nix/index.md)) — never `apt-get` in a workflow.
