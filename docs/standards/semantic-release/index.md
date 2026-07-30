---
id: semantic-release
title: Semantic Release
---

# Semantic Release

Versioning is fully automated: commit subjects decide the number, semantic-release stamps it and
tags it, and GoReleaser publishes the artifacts. `.releaserc.yaml` is the single source of truth
for the version calculation and the release commit; nobody edits a version by hand.

## Division of labour

| Concern                                          | Owner            |
| ------------------------------------------------ | ---------------- |
| Version number from commit types                 | semantic-release |
| `Changelog.md` and release-note text             | semantic-release |
| `VERSION`, `packages/cli/package.json` version   | semantic-release |
| The `release: x.y.z` commit and the `vX.Y.Z` tag | semantic-release |
| Binaries, archives, checksums, installer, cask   | GoReleaser       |
| The GitHub Release object itself                 | GoReleaser       |

**`@semantic-release/github` is forbidden in this repository.** GoReleaser creates the GitHub
release when the tag lands, so adding the plugin would produce two publishers racing over one
release. `scripts/validate/cli-contracts.sh release-backup-order` fails the commit if the plugin
reappears ([Contracts](../contracts/README.md)).

## Configuration

`.releaserc.yaml`: `branches: [main]`, `tagFormat: v${version}`, and a plugin chain whose
**order is load-bearing**:

| #   | Plugin                                      | Effect                                                         |
| --- | ------------------------------------------- | -------------------------------------------------------------- |
| 1   | `@semantic-release/commit-analyzer`         | `conventionalcommits` preset → next version                    |
| 2   | `@semantic-release/release-notes-generator` | `conventionalcommits` preset → note text                       |
| 3   | `@semantic-release/exec`                    | `prepareCmd: ./scripts/release/backup-changelog.sh`            |
| 4   | `@semantic-release/changelog`               | prepends the new section to `Changelog.md`                     |
| 5   | `@semantic-release/exec`                    | `prepareCmd: ./scripts/release/bump.sh ${nextRelease.version}` |
| 6   | `@semantic-release/git`                     | commits the assets as `release: ${version}` and tags it        |

Step 3 must precede step 4. `backup-changelog.sh` copies `Changelog.md` to `Changelog.old.md`
_before_ the changelog plugin rewrites it, which is what lets `publish.sh` recover exactly this
version's section later by diffing the two files. Both files are `@semantic-release/git` assets,
alongside `packages/cli/package.json` and `VERSION`.

Committing `Changelog.old.md` is not incidental: CD is a separate workflow that checks the tag
out fresh, so the diff basis has to exist in the tagged commit. The `changelog-asset` contract
enforces both halves — the asset in `.releaserc.yaml` and the `--release-notes` flag in
`publish.sh`.

## Scripts

| Script                                | Role                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `scripts/release/backup-changelog.sh` | snapshots `Changelog.md` → `Changelog.old.md` (or creates it empty)     |
| `scripts/release/bump.sh <version>`   | stamps `packages/cli/package.json` and `VERSION`                        |
| `scripts/ci/release.sh`               | the workflow entry point: setup, drop local hooks, run semantic-release |
| `scripts/release/publish.sh`          | GoReleaser side: compile, package, publish, release notes               |

`bump.sh` restores both version-bearing files from `HEAD` before writing, so a re-run or a
partly dirty tree cannot compound a version. It strips a leading `v`, so the file contents are
plain semver while the tag keeps its `v` prefix.

`scripts/ci/release.sh` deletes `.git/hooks/*` before running semantic-release: the automated
`release: x.y.z` commit must not be blocked by, or reformatted by, the local hooks
([Linting](../linting/index.md)).

## Pipeline

1. `CI` passes on `main` ([CI/CD](../ci-cd/index.md)).
2. `release.yaml` starts via `workflow_run`, in the `release` concurrency group, authenticated
   with a PAT — a tag pushed with the default `GITHUB_TOKEN` would not trigger CD.
3. `nix develop .#ci -c ./scripts/ci/release.sh` runs semantic-release, which computes the
   version, rewrites the changelog, stamps the version files, commits, and pushes the `vX.Y.Z`
   tag.
4. The tag fires `cd.yaml`, which runs
   `nix develop .#releaser -c ./scripts/release/publish.sh`.
5. `publish.sh` compiles the standalone binaries into `prebuilt/` (it survives GoReleaser's
   `--clean`), diffs `Changelog.md` against `Changelog.old.md` into `IncrementalChangelog.md`,
   and hands that to `goreleaser release --release-notes`.

A no-release cycle simply stops after step 3 with no tag, and CD never runs.

## Acceptance gate

```bash
./scripts/release/publish.sh --snapshot
```

This is the offline test for any release-machinery change: it compiles, packages, and builds
every artifact into `dist/` with publishing skipped, requires no tokens, and asserts the
artifacts it expects. Run it before touching `.goreleaser.yaml`, `.releaserc.yaml`, or anything
under `scripts/release/`.

To see what the version calculation would do without releasing:

```bash
./node_modules/.bin/semantic-release --dry-run --no-ci
```

## Rules

- Never hand-edit `Changelog.md`, `Changelog.old.md`, `VERSION`, or the CLI package version.
  Prettier deliberately skips the changelog files so formatting never churns a release commit.
- Never add `@semantic-release/github`.
- Never reorder the plugin chain; the backup-before-changelog order is a contract.
- Version-relevant behavior comes from commit subjects only — see
  [Conventional Commits](../conventional-commits/index.md).
