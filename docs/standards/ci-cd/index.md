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

Two pools, chosen per job by measurement. GitHub's hosted runners are **free for a public
repository** (`ubuntu-latest` is 4 cores and 16GB) but cap concurrent jobs; **Namespace** runners
start from a warm `/nix` and have their own pool, but every minute is billed, and they are capped at
32 concurrent Linux vCPUs on the Developer plan. The GitHub cap, not run time, was what made pull
requests slow, and Namespace is what buys a pull request out of that queue. So Namespace runs only
**pull-request** jobs that are worth the money, each on the smallest shape that does not lengthen the
critical path, and nothing goes there that is free and about as fast on GitHub.

**`main` runs on GitHub.** A `main` run re-proves a tree its pull request already proved, nobody
waits on it but `Release`, and it was 40% of the Namespace bill (330 of the 1,219 runs that used Namespace, Oct 19–28). Its
jobs take the `ubuntu-latest` branch of the same `runs-on` expression, except `Build Checks`, which
stays on Namespace because it is the job that refreshes the cache volume (below).

**`vars.CI_RUNNER_POOL`** is the switch. Set the repository variable to `github` and every Namespace
job, `Build Checks` and the E2E shards included, runs on `ubuntu-latest` from the next run on: no
pull request, no Namespace bill. Unset, the pools are as this section describes. The cost of the
switch is the GitHub queue on a busy day, nothing else: each job's cache step is skipped off
Namespace (`if: runner.environment == 'self-hosted'`) and Nix installs from cache.nixos.org as it
did before Namespace.

**What Namespace bills**, from its [pricing page](https://namespace.so/pricing) and
[cache docs](https://namespace.so/docs/architecture/storage/cache-volumes):

- Compute by the minute per vCPU, one-minute floor, the next 15 seconds rounded down: a 2x4 costs
  $0.002/min prepaid, $0.003/min beyond the plan. A 20-second job is billed a whole minute.
- The cache volume on its **requested** size, not what it holds: storage per GB-day, plus a snapshot
  charge of size × the time each job has it attached ($0.002/GB-hour). Every job carrying
  `-with-cache` pays that, whether or not it mounts `/nix`.
- **Measure it, don't estimate it.** `nsc instance report --start <RFC3339> --out <file>` writes one
  CSV row per Namespace instance with its shape, start and end, peak CPU and memory, and the GitHub
  job, run and branch it served. It is read-only and needs no GitHub API calls.

**Where each job runs** on a pull request, with the busy cores measured by sampling `/proc/stat`
every second, and the GitHub times from the last runs before Namespace (p50):

| Job                                              | Runner        | Measured                           | Why                                                         |
| ------------------------------------------------ | ------------- | ---------------------------------- | ----------------------------------------------------------- |
| `Pre-Commit (format)`                            | Namespace 2x4 | treefmt, ~3.4 of 4 cores           | ~55s on 2x4 vs ~30s on 4x8: half the price, off the path    |
| `Pre-Commit (gates)`                             | GitHub        | 113s vs 97s on Namespace 4x8       | knip needs more than a 2x4's 4GB; a 4x8 bought 16s          |
| `Unit Tests (<group>)`                           | Namespace 2x4 | ~0.7 cores                         | `bun test` runs one file at a time                          |
| `Build Checks`, `Compile Binaries`               | Namespace 2x4 | ~1.4 cores                         | short builds; `Build Checks` also refreshes the cache       |
| `PWA Settings Geometry (light)`                  | Namespace 2x4 | ~1.9 cores                         | well inside the critical path                               |
| `PWA Full Gallery (dark)`                        | Namespace 4x8 | ~427s; 643s on GitHub, ~3.3GB peak | past a 2x4's memory; GitHub would make it the critical path |
| `E2E Shard (1..3)`                               | Namespace 2x4 | ~1 core, 1.8GB                     | one journey at a time                                       |
| `Integration Tests (<group>)`                    | GitHub        | ~0.6–2 cores                       | free, and five groups keep each under ~2.5 min              |
| `Unit Tests`, `Integration Tests`, `E2E …` tails | GitHub        | seconds, no nix shell              | billed a whole minute and a cache attachment on Namespace   |
| `SIT`, smoke, harness contract, every macOS job  | GitHub        | —                                  | free; macOS and arm64 have no Namespace equivalent here     |

- **One cache volume, tag `ferretry-nix`, requested at 10GB.** `namespacelabs/nscloud-cache-action`
  with `cache: nix` mounts a persistent `/nix` BEFORE `cachix/install-nix-action`, so the dev shell
  is already built when the job starts. The order is load-bearing: installing Nix first would
  populate a fresh store. The tag is the key, so every shape shares the one volume. It holds ~2.5GB
  (dev shell plus install bundle), so `nscloud-cache-size-10gb` replaces the 20GB default and halves
  both storage and every job's snapshot charge.
- **Only `main` writes the volume.** Every Namespace job carries
  `nscloud-cache-allow-commit-from-main`: a pull request reads the volume and its own additions die
  with its runner, so a PR that bumps `flake.lock` builds its new shell itself until it merges.
  `main`'s `Build Checks` then runs `scripts/ci/nix-store-hygiene.sh`, which roots the dev shell and
  the install bundle and collects everything else once `/nix` passes 6GB, because a store only ever
  grows and a full volume fails every job.
- **The image's Node is never the build's Node.** The devshells ship a pinned `nodejs_24` and
  `scripts/validate/pinned-toolchain.sh` fails if `node` or `bun` resolves outside `/nix/store`. The
  Namespace image's Node once ran `vite` and the int tier's browser worker, and could load neither's
  `.ts` imports. See [Nix](../nix/index.md#one-toolchain-nothing-falls-through-to-the-runner-image).
- **`Integration Tests` could run on Namespace, and does not.** Measured there, its groups take
  80–100s against GitHub's 100–135s once split five ways: about 40 seconds for roughly 40
  vCPU-minutes a run. One environment difference remains: Namespace's root is an overlay whose files
  and directories report different `st_dev`, and the shared-history planner refuses a rename it reads
  as cross-device although `rename(2)` succeeds there. The tests write under `/tmp` by design
  (`scripts/test/swept.sh`), so that is a product question about overlay filesystems, not a CI knob.
- **No path filters beyond E2E's.** Of 120 merged pull requests, two changed only documentation, and
  `E2E Relevance` already skips those. Skipping a unit or int group for an unrelated change would
  leave its files out of the per-group 100% ledger, and the jobs a PWA-only change could skip run on
  GitHub, where they cost nothing.
- **Moving a job between pools is its `runs-on`.** A Namespace job's `runs-on` is one expression:
  `ubuntu-latest` off a pull request or under `CI_RUNNER_POOL=github`, its `nscloud-*` labels
  otherwise; a matrix entry with `shape: github` always takes `ubuntu-latest`. Its cache step carries
  `if: runner.environment == 'self-hosted'` (a Namespace runner registers as self-hosted), so the
  same job runs on either pool and nothing else in it depends on the runner vendor.

## Workflow split

| Workflow   | Trigger                                                                   | Responsibility                                                     |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `CI`       | push to `main`, pull request, manual dispatch                             | gates, tests, compile, SIT, cross-platform smoke                   |
| `E2E`      | pull request (docs/model-catalog-only ones skip inside), manual dispatch  | the e2e tier's fast journeys in three shards, into `E2E Journeys`  |
| `E2E Slow` | nightly, manual dispatch, pull requests touching relay or connection code | the `[slow]` e2e journeys, one per shard, into `E2E Slow Journeys` |
| `Release`  | `CI` completed successfully on `main`                                     | semantic-release: version, changelog, `vX.Y.Z` tag                 |
| `CD`       | push of a `v*.*.*` tag                                                    | GoReleaser publishes the release and its channels                  |

The chain is deliberately one-directional: CI proves the tree, Release decides the version and
pushes the tag, the tag fires CD. Nothing else publishes anything.

## CI jobs

| Job              | Runs                                                                             | Notes                                                                         |
| ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `precommit`      | `nix develop .#ci -c ./scripts/ci/pre-commit.sh "$PART"`                         | matrix `[format, gates]`: treefmt, and every other hook, in parallel          |
| `build-checks`   | `nix build .#default`, `wrangler deploy --dry-run` ×2, `scripts/ci/build-pwa.sh` | the install bundle, both relay Workers and the Pages bundle, in one job       |
| `test`           | `nix develop .#ci -c ./scripts/ci/test.sh unit "$TEST_GROUP"`                    | matrix over `config/test-groups.json`                                         |
| `unit-ledger`    | `./scripts/ci/coverage-ledger.sh unit --groups <dir>`                            | `needs: test`; the unit tier's 100% ledger                                    |
| `int`            | `nix develop .#ci -c ./scripts/ci/test.sh int "$TEST_GROUP"`                     | matrix over `config/test-groups.json`                                         |
| `int-ledger`     | `./scripts/ci/coverage-ledger.sh int --groups <dir>`                             | `needs: int`; the int tier's 100% ledger                                      |
| `pwa-screenshot` | `nix develop .#ci -c ./scripts/ci/pwa-screenshot-proof.sh "$SCHEME" "$SCOPE"`    | Settings geometry in light, plus the full gallery (Settings included) in dark |
| `compile`        | `nix develop .#ci -c ./scripts/release/compile.sh`                               | uploads `cli-binaries` from `dist/bin/`                                       |
| `sit`            | `nix develop .#ci -c ./scripts/ci/test.sh sit`                                   | `needs: compile`, downloads the binaries                                      |
| `smoke`          | `./scripts/release/smoke.sh dist/bin/<binary>-<target>`                          | `needs: compile`, one runner per build target                                 |

Notable details:

- **Coverage is an artifact, and a gate.** `scripts/ci/test.sh` runs the tier with coverage and
  then asserts the ledger: every path is inside the tier's scope (`src/lib/` for unit,
  `src/adapters/` for int), the ledger is non-empty, every line is hit, and no source file is
  missing from it. The `coverage-<mode>` artifact uploads with `if: always()` so a failure is
  still inspectable. Tiers are described in [Testing](../testing/index.md).
- **Both test tiers run in groups.** `test` and `int` run each group of `config/test-groups.json` on
  its own runner and upload `coverage-<tier>-<group>`; `unit-ledger` and `int-ledger` (check names
  `Unit Tests` and `Integration Tests`)
  download them all and apply the gate, refusing to judge while any configured group is missing.
  A source file must reach 100% inside one group ([Testing](../testing/index.md) says why). Like
  `smoke`, the ledger jobs enter no nix shell — the gate is bash, awk, grep and jq — because a nix
  shell would put ~30s back on the critical path the groups took off it. Adding a group means adding
  it to the config and to the matrix.
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
- **SIT runs against the artifact, not a rebuild.** `compile` uploads the binaries and `sit`
  downloads them, which is what makes it a black-box test of the shipped thing.
  `download-artifact` drops the executable bit; the scripts restore it.
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
- **Smoke covers the platforms compile cannot.** `linux-x64-baseline` on `ubuntu-latest`,
  `linux-arm64` on `ubuntu-24.04-arm`, `darwin-arm64` on `macos-14`. This is the one job that
  does not enter a nix shell — it only needs the downloaded binary and `jq` — and it derives
  the binary name from the CLI package's `bin` key so the matrix stays rename-proof
  ([Architecture](../architecture/index.md)).

## E2E tier

`E2E` (`.github/workflows/e2e.yaml`) runs every journey in `tests/e2e/` against the compiled `fy`/`fyd`, the
real built PWA, the runner's Google Chrome and a local rendezvous ([Testing](../testing/index.md)). Each
runner runs `nix develop .#ci -c ./scripts/ci/e2e.sh`, which compiles the binaries and hands off to
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
  green. The workflow runs on every pull request, and the `relevance` job lists the pull request's
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
  `E2E Slow` runs the slow tier nightly, on manual dispatch, and on a pull request that touches the
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
  about 6 s is compiling every target, and about 3 s is the harness typecheck. A job that compiled
  once and handed the binaries to the shards would save the 6 s per shard. It would also add a whole
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

Every other run — a push to `main`, a manual dispatch — falls into a group of its own
`run_id`, so nothing can cancel it. Setting `cancel-in-progress: false` on a shared group would not
be enough: GitHub still cancels a _pending_ run in a group when a newer one queues, and `Release`
needs every `main` CI run to complete. The deploying workflows (`CD`, `Release`, `PWA Pages`,
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

`CD` reacts to the tag, checks out with `fetch-depth: 0`, and runs
`nix develop .#releaser -c ./scripts/release/publish.sh` — the `.#releaser` shell is the only
one with `goreleaser` and `go`. GoReleaser owns the GitHub release, archives, checksums, the
installer, and the in-repo Homebrew cask. See
[Semantic Release](../semantic-release/index.md) for what each half owns.

## Permissions and checkout

- Every job declares least-privilege `permissions:` explicitly — `contents: read` for CI jobs,
  `contents: write` only for `Release` and `CD`.
- Every checkout sets `persist-credentials: false`, so a compromised build step cannot reuse the
  checkout's credentials to push.
- Nix comes from `cachix/install-nix-action`; there is no bespoke setup action, and checkout is
  always its own step.

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

Use the same entry points CI uses:

```bash
nix develop .#ci -c ./scripts/ci/pre-commit.sh    # the precommit job
nix develop .#ci -c ./scripts/ci/test.sh unit     # the unit matrix leg
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
