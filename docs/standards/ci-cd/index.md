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

## Workflow split

| Workflow  | Trigger                                                     | Responsibility                                         |
| --------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `CI`      | push to `main`, pull request, manual dispatch               | gates, tests, compile, SIT, cross-platform smoke       |
| `E2E`     | pull requests touching the tier's packages, manual dispatch | the e2e tier: compiled binaries, real PWA, real Chrome |
| `Release` | `CI` completed successfully on `main`                       | semantic-release: version, changelog, `vX.Y.Z` tag     |
| `CD`      | push of a `v*.*.*` tag                                      | GoReleaser publishes the release and its channels      |

The chain is deliberately one-directional: CI proves the tree, Release decides the version and
pushes the tag, the tag fires CD. Nothing else publishes anything.

## CI jobs

| Job              | Runs                                                          | Notes                                                                |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `precommit`      | `nix develop .#ci -c ./scripts/ci/pre-commit.sh "$PART"`      | matrix `[format, gates]`: treefmt, and every other hook, in parallel |
| `test`           | `nix develop .#ci -c ./scripts/ci/test.sh unit "$TEST_GROUP"` | matrix over `config/test-groups.json`                                |
| `unit-ledger`    | `./scripts/ci/coverage-ledger.sh unit --groups <dir>`         | `needs: test`; the unit tier's 100% ledger                           |
| `int`            | `nix develop .#ci -c ./scripts/ci/test.sh int "$TEST_GROUP"`  | matrix over `config/test-groups.json`                                |
| `int-ledger`     | `./scripts/ci/coverage-ledger.sh int --groups <dir>`          | `needs: int`; the int tier's 100% ledger                             |
| `pwa-screenshot` | `nix develop .#ci -c ./scripts/ci/pwa-screenshot-proof.sh`    | Settings geometry in a real Chromium                                 |
| `compile`        | `nix develop .#ci -c ./scripts/release/compile.sh`            | uploads `cli-binaries` from `dist/bin/`                              |
| `sit`            | `nix develop .#ci -c ./scripts/ci/test.sh sit`                | `needs: compile`, downloads the binaries                             |
| `smoke`          | `./scripts/release/smoke.sh dist/bin/<binary>-<target>`       | `needs: compile`, one runner per build target                        |

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
- **SIT runs against the artifact, not a rebuild.** `compile` uploads the binaries and `sit`
  downloads them, which is what makes it a black-box test of the shipped thing.
  `download-artifact` drops the executable bit; the scripts restore it.
- **A browser gate asserts geometry, and never stores pixels.** `pwa-screenshot` runs the PWA's
  screenshot harness in `--settings-only` mode in both colour schemes and fails on
  `assertNoSidewaysScroll` — the one layout defect a capture cannot show, because the capture is
  clipped to the viewport it overflows. The PNGs upload with `if: always()` as evidence; nothing
  compares them, and `.gitignore` keeps them out of the tree. The harness asserts its own tally of
  checks and the script requires that closing line, so a refactor that stops the checks running is
  red rather than green. Adding or removing a Settings surface means editing one integer, which is
  the churn this shape chose over re-baselining a directory of images.
- **Smoke covers the platforms compile cannot.** `linux-x64-baseline` on `ubuntu-latest`,
  `linux-arm64` on `ubuntu-24.04-arm`, `darwin-arm64` on `macos-14`. This is the one job that
  does not enter a nix shell — it only needs the downloaded binary and `jq` — and it derives
  the binary name from the CLI package's `bin` key so the matrix stays rename-proof
  ([Architecture](../architecture/index.md)).

## E2E tier

`E2E` (`.github/workflows/e2e.yaml`) runs `nix develop .#ci -c ./scripts/ci/e2e.sh`. That script compiles the
binaries and hands off to `scripts/test/run-e2e.sh`, which runs every journey in `tests/e2e/` against the
compiled `fy`/`fyd`, the real built PWA, the runner's Google Chrome and a local rendezvous
([Testing](../testing/index.md)). It is its own workflow because GitHub filters by path per workflow. It runs on
pull requests that touch `packages/{pwa,daemon,relay,protocol,cli}` or the tier itself, and on manual dispatch.

- **Evidence is an artifact.** The `e2e-evidence-<attempt>` artifact (one per run attempt) uploads with `if: always()`. It holds every screen
  the journeys reached at 390 px and 1280 px in both colour schemes, the per-step journey log, and the relay
  ledger.
- **Advisory, and visibly so.** The journeys step runs with `continue-on-error: true`, so a red run leaves the
  check green. Its failures still land in three places: the job summary ("E2E: N pass / M fail" plus the
  failing tests), a warning annotation, and the evidence artifact. When the job becomes required,
  `continue-on-error` is removed in the same change.
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
- About ten minutes on `ubuntu-latest`, with `timeout-minutes: 30` so a wedged browser cannot hold a runner
  for six hours.

## One run per commit

`CI` runs once for each commit under test: a pull request through its `pull_request` run, `main`
through its `push` run (the run `Release` waits on), and anything else through `workflow_dispatch`.
`push` is filtered to `main` on purpose. When it fired for every branch and tag, each PR ran every
job twice — the branch push and the PR — and each release ran them a third time on the tag, whose
tree the `main` run of the release commit had already proved. The duplicates drew on the same
runner pool as the runs that mattered, and macOS runners are the scarcest part of it.

`push` also ignores a commit that changes only `Casks/**`. That is GoReleaser's cask update, pushed
by `CD` after a release has shipped, and no job reads it.

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
