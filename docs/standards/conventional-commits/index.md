---
id: conventional-commits
title: Conventional Commits
---

# Conventional Commits

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
They are not a style preference: the release version, the changelog, and the release notes are
all computed from them ([Semantic Release](../semantic-release/index.md)).

## Format

```
type(scope)!: description
```

- `type` — required, from the list below.
- `(scope)` — optional, lowercase, matching `[a-z0-9./-]+`.
- `!` — optional, marks a breaking change.
- `description` — required, at least one character after `: `.

### Examples

```
feat(cli): add a --json output flag
fix: exit non-zero when the daemon socket is unreachable
perf(fleet): cache the host inventory between calls
dep(patch): update a pinned dependency
docs(standards): document the release pipeline
ci: pin the artifact upload action
```

## Commit types

The gate is `scripts/validate/commit-msg.sh`, wired as the `a-commit-msg` pre-commit hook on the
`commit-msg` stage ([Linting](../linting/index.md)). It accepts exactly these types:

```text
amend, build, chore, ci, config, dep, docs, feat, fix, perf, refactor, release, revert, style, test
```

`release` belongs to semantic-release — it is the type of the automated
`release: x.y.z` commit — so do not use it by hand.

Merge, revert, and rebase-fixup subjects pass through untouched (`Merge …`, `Revert …`,
`fixup! …`, `squash! …`), because git authors those and rewriting them would break the tooling
that reads them.

## Release behavior

`.releaserc.yaml` is the source of release behavior. It uses the `conventionalcommits` preset
with its default rules, so:

| Commit                                           | Release    |
| ------------------------------------------------ | ---------- |
| `feat: …`                                        | minor      |
| `fix: …`                                         | patch      |
| `perf: …`                                        | patch      |
| any type with `!` or a `BREAKING CHANGE:` footer | major      |
| a revert recognised by the parser                | patch      |
| every other type                                 | no release |

So `docs`, `ci`, `chore`, `refactor`, `style`, `test`, `build`, `config`, `dep`, and `amend`
land on `main` without cutting a version. Only the changes users can observe move the number.

There is no generated commit-convention document to consult: the validator's type list and
`.releaserc.yaml` are the two sources, and both are short enough to read.

## Breaking changes

Either mark the subject with `!` or add a `BREAKING CHANGE:` footer:

```
feat!: remove the deprecated --legacy flag
```

```
feat: add the replacement flag

BREAKING CHANGE: --legacy no longer exists; use --mode instead.
```

The `!` form is preferred for a one-line rationale-free change; use the footer when the
migration needs explaining, since the footer text lands in the release notes.

## Checking a message

The hook runs automatically on `git commit`. To check one by hand:

```bash
pre-commit run a-commit-msg --hook-stage commit-msg --commit-msg-filename .git/COMMIT_EDITMSG
./scripts/validate/commit-msg.sh <file-containing-the-message>
```

The validator inspects the **subject line only**. Bodies and footers are free-form, apart from
`BREAKING CHANGE:` having meaning to the release calculation.

CI strips local hooks before semantic-release commits (`scripts/ci/release.sh` removes
`.git/hooks/*`), so the automated release commit never fights the gate it would otherwise
trigger.

## Summary

| Aspect            | Pattern                                                  |
| ----------------- | -------------------------------------------------------- |
| **Format**        | `type(scope)!: description`                              |
| **Gate**          | `scripts/validate/commit-msg.sh` (`commit-msg` stage)    |
| **Release rules** | `.releaserc.yaml`, `conventionalcommits` preset defaults |
| **Breaking**      | `!` in the subject or a `BREAKING CHANGE:` footer        |
| **Reserved**      | `release` — written by semantic-release, never by hand   |
