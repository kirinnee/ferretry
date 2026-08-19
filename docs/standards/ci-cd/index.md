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

| Workflow  | Trigger                                   | Responsibility                                     |
| --------- | ----------------------------------------- | -------------------------------------------------- |
| `CI`      | every push, pull request, manual dispatch | gates, tests, compile, SIT, cross-platform smoke   |
| `Release` | `CI` completed successfully on `main`     | semantic-release: version, changelog, `vX.Y.Z` tag |
| `CD`      | push of a `v*.*.*` tag                    | GoReleaser publishes the release and its channels  |

The chain is deliberately one-directional: CI proves the tree, Release decides the version and
pushes the tag, the tag fires CD. Nothing else publishes anything.

## CI jobs

| Job              | Runs                                                       | Notes                                         |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------- |
| `precommit`      | `nix develop .#ci -c ./scripts/ci/pre-commit.sh`           | every gate, with `--show-diff-on-failure`     |
| `test`           | `nix develop .#ci -c ./scripts/ci/test.sh "$TEST_MODE"`    | matrix `[unit, int]`, `fail-fast: false`      |
| `pwa-screenshot` | `nix develop .#ci -c ./scripts/ci/pwa-screenshot-proof.sh` | Settings geometry in a real Chromium          |
| `compile`        | `nix develop .#ci -c ./scripts/release/compile.sh`         | uploads `cli-binaries` from `dist/bin/`       |
| `sit`            | `nix develop .#ci -c ./scripts/ci/test.sh sit`             | `needs: compile`, downloads the binaries      |
| `smoke`          | `./scripts/release/smoke.sh dist/bin/<binary>-<target>`    | `needs: compile`, one runner per build target |

Notable details:

- **Coverage is an artifact, and a gate.** `scripts/ci/test.sh` runs the tier with coverage and
  then asserts the ledger: every path is inside the tier's scope (`src/lib/` for unit,
  `src/adapters/` for int), the ledger is non-empty, every line is hit, and no source file is
  missing from it. The `coverage-<mode>` artifact uploads with `if: always()` so a failure is
  still inspectable. Tiers are described in [Testing](../testing/index.md).
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
