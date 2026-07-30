---
id: shell-scripts
title: Shell Script Conventions
---

# Shell Script Conventions

Shell is the glue language of this repository: pipeline entry points, release orchestration,
and policy enforcers are all bash. These conventions keep them readable, debuggable, and
identical whether a developer or GitHub Actions runs them.

Every `*.sh` file is shellcheck-clean and executable — both are pre-commit gates
([Linting](../linting/index.md)).

## Required header

All scripts start with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

- `#!/usr/bin/env bash` — resolve bash from `PATH` (nix, not `/bin/bash`)
- `set -e` — exit on the first failing command (errexit)
- `set -u` — unset variables are an error (nounset)
- `set -o pipefail` — a pipeline fails if any stage fails

## Style principles

### Linear and procedural

- Avoid functions — keep scripts top-to-bottom readable.
- Execute commands sequentially; separate phases with comments.
- Define a function only when it removes genuine repetition that no other construct can.
  `scripts/local/rename.sh` has exactly one (`rewrite`, applying the same `sed` across a file
  list) and it is the only function in `scripts/`.

### Run from the repository root

Any script that touches repo-relative paths and might be invoked from a subdirectory pins its
own cwd first:

```bash
root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
```

### Prefer substitution over flow control

- Do **not** use `if`/`else`, loops, or functions for abstraction or "tidiness".
- Prefer parameter and command substitution:

  ```bash
  OUTDIR="${COMPILE_OUTDIR:-dist/bin}"
  arg="$([ -n "${flag:-}" ] && echo "--flag" || echo "")"
  ```

- Use flow control **only when necessary** — iterating an unknown number of items, or a genuine
  two-mode branch (`scripts/ci/test.sh` branching on the `sit` mode is the archetype).

### Portable and safe

- Prefer plain, widely supported bash; avoid obscure shell features.
- Use `$(command)`, never backticks.
- Write required-variable guards as single-line `[ ] && ... && exit 1` lists reporting to
  stderr:

  ```bash
  [ -z "${GITHUB_TOKEN:-}" ] && echo "❌ 'GITHUB_TOKEN' env var not set" >&2 && exit 1
  ```

  Keep such a guard away from the **final** line of the script: under `set -e`, an `&&` chain
  whose first test is false yields a non-zero exit status, so a trailing guard makes a
  successful script look failed. End on an `echo` instead.

- Clean up temp files with a `trap` right after creating them:

  ```bash
  tmp="$(mktemp)"
  trap 'rm -f "${tmp}"' EXIT
  ```

- When you need a command's exit code rather than an abort, fence it explicitly:

  ```bash
  set +e
  bun test --config="${config}" --coverage
  test_status=$?
  set -e
  ```

- **Every `curl` carries `--connect-timeout` and `--max-time`.** An installer that hangs
  forever on a stalled connection is worse than one that fails. This is enforced for release
  scripts by the `installer-timeouts` contract ([Contracts](../contracts/README.md)):

  ```bash
  curl -fsSL --connect-timeout 30 --max-time 600 "${base}/${archive}" -o "${tmp}/${archive}"
  ```

### Output

- No ANSI color codes, but **prefix every `echo` with a suitable emoji**: 📦 install, 📝 info,
  🔨 build, 🧪 test, ⚙️ compute, 🔁 rewrite, 📤 push, ✅ success, ❌ failure.
- Progress echos are **encouraged** — a script is opaque to its caller, so say what is
  happening. (Taskfiles are the opposite: the runner already echoes each command, so progress
  echos there are noise. See [Taskfile Conventions](../taskfile/index.md).)
- Do **not** emit no-op placeholders like `echo "Completed"`. Report a fact:
  `echo "✅ Build artifact present: ${artifact}"`.
- Failures go to stderr; successes to stdout.

## Template

```bash
#!/usr/bin/env bash
set -euo pipefail

[ -z "${SOME_VAR:-}" ] && echo "❌ 'SOME_VAR' env var not set" >&2 && exit 1

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

echo "🔨 Doing the thing..."
# commands here

echo "✅ Done"
```

## File location

All shell scripts live under `scripts/` at the repository root. Who may call what is part of
the contract:

```
scripts/
├── ci/        # workflow entry points — GitHub Actions only
│   ├── setup.sh        install locked dependencies
│   ├── pre-commit.sh   every gate
│   ├── test.sh         one tier (unit | int | sit) + coverage ledger checks
│   ├── build.sh        bundle
│   └── release.sh      semantic-release
├── local/     # developer helpers, called from Taskfiles
├── release/   # compile, shim, publish, smoke, installer, bump, changelog backup
└── validate/  # repository policy checks, called from pre-commit
```

| Caller            | May call                               |
| ----------------- | -------------------------------------- |
| GitHub workflows  | `scripts/ci/*`, `scripts/release/*`    |
| Taskfiles         | `scripts/local/*`, `scripts/release/*` |
| pre-commit hooks  | `scripts/validate/*`                   |
| `.releaserc.yaml` | `scripts/release/*`                    |

Taskfiles never call `scripts/ci/*` — those scripts own their own setup and exist for the
pipeline. Each `scripts/ci/*` script begins by running `scripts/ci/setup.sh` so a workflow job
is a single line.

## Summary

| Aspect       | Pattern                                                        |
| ------------ | -------------------------------------------------------------- |
| **Header**   | `#!/usr/bin/env bash` + `set -euo pipefail`                    |
| **Style**    | Linear, portable bash; substitution over flow control          |
| **Guards**   | Single-line `[ ] && echo … >&2 && exit 1`, never the last line |
| **Network**  | Every `curl` has `--connect-timeout` and `--max-time`          |
| **Progress** | Emoji-prefixed echos, no ANSI colors                           |
| **Location** | `scripts/{ci,local,release,validate}/`                         |
| **Gates**    | shellcheck-clean and executable (pre-commit)                   |
