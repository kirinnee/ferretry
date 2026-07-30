---
id: taskfile
title: Taskfile Conventions
---

# Taskfile Conventions

[go-task](https://taskfile.dev) (`task`) is the repository task runner. Root tasks live in
`Taskfile.yaml`; grouped tasks live under `tasks/` and are pulled in by namespace. Every task
assumes it is running inside the nix devshell — see [Nix](../nix/index.md).

## Current surface

`task --list` is the authority; this is what it prints today.

| Command                  | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `task setup`             | install locked workspace dependencies                    |
| `task check`             | typecheck the workspace (`tsc --noEmit`)                 |
| `task lint`              | run every repository gate (`pre-commit run --all-files`) |
| `task build`             | build the Bun bundle into `dist/`                        |
| `task clean`             | remove build, dependency, and coverage artifacts         |
| `task deadcode`          | review strict and LLM-assisted dead-code findings        |
| `task run -- <args>`     | run the CLI source entry point                           |
| `task preview -- <args>` | run this host's compiled standalone binary               |
| `task compile`           | cross-compile every standalone binary into `dist/bin/`   |
| `task compile:smoke`     | smoke-test one compiled binary                           |
| `task test`              | unit + integration + SIT, no coverage                    |
| `task test:unit`         | unit suite only                                          |
| `task test:int`          | integration suite only                                   |
| `task test:sit`          | black-box journeys through the freshly compiled binary   |
| `task test:coverage`     | every coverage-capable suite with coverage               |
| `task test:watch`        | watch the fast unit suite                                |

`task compile` is an alias for `compile:default`. Each `test:*` task also has a `:coverage`
variant (`test:unit:coverage`, `test:int:coverage`, `test:sit:coverage`). The tiers themselves
are described in [Testing](../testing/index.md).

## Layout

```
Taskfile.yaml                 # root: vars, includes, the whole user-facing surface
tasks/Taskfile.compile.yaml   # compile namespace
tasks/Taskfile.test.yaml      # parameterized test building blocks
```

Included files are namespaced by their include key, and an include may pass `vars:` down. The
test file is included twice — once as `unit`, once as `int` — with only `MODE` and `CONFIG`
differing:

```yaml
includes:
  unit:
    taskfile: tasks/Taskfile.test.yaml
    vars:
      MODE: unit
      CONFIG: bunfig.unit.toml
```

That is how one small file serves both tiers. Its tasks are marked `internal: true`,
because the user-facing names are the `test:*` tasks in the root file — an included building
block should not show up in `task --list` twice under two spellings.

## Rules

1. **Keep one- or two-line commands inline.** `task lint`, `task check`, and `task test:sit`
   are single commands and belong in the Taskfile verbatim.
2. **Move conditional or multi-step local logic to `scripts/local/`.** `setup`, `build`, and
   `deadcode` are scripts because they guard inputs, chain steps, or verify their own output.
   See [Shell Script Conventions](../shell-scripts/index.md).
3. **Never call `scripts/ci/*` from a Taskfile.** Those are workflow entry points and own
   their own setup; GitHub Actions calls them directly. Taskfiles may call `scripts/local/*`
   and `scripts/release/*` (`compile`, `compile:smoke`) — the release scripts are the same
   code CI runs, which is the point.
4. **Use lowercase names and colon-separated namespaces.** `test:unit:coverage`, not
   `testUnitCoverage`.
5. **Derive names; never hardcode them.** Root `vars:` compute the binary name, the
   host artifact, and the entry file from the CLI package's `bin` key:

   ```yaml
   vars:
     CLI_PKG: packages/cli
     ARTIFACT_PREFIX:
       sh: jq -r '.bin | to_entries[0].key' {{.CLI_PKG}}/package.json
   ```

   `scripts/validate/cli-contracts.sh name-single-source` fails the commit if that derivation
   disappears from `Taskfile.yaml`. Any other repository-specific value belongs in a `vars:`
   block too, not sprinkled through commands.

6. **Do not add progress-only `echo` commands.** The runner already prints each command before
   running it. Scripts may print progress (they are opaque to the runner); Taskfiles may not.
7. **Declare real prerequisites with `deps:`.** `test:sit` and `preview` both depend on
   `compile`, so neither can run against a stale binary.
8. **Forward user arguments with `{{.CLI_ARGS}}`** so `task run -- --help` and
   `task compile:smoke -- dist/bin/<binary>` work.

## Adding a task

- One command, user-facing → add it to `Taskfile.yaml` `tasks:`.
- Several steps or any conditional → write `scripts/local/<name>.sh` and call it from a
  one-line task.
- A new family of related tasks → add `tasks/Taskfile.<name>.yaml` and include it under its
  namespace. If two families differ only by a variable, include one file twice with different
  `vars:` instead of copying it.
- A new pipeline lane → the workflow calls `scripts/ci/<name>.sh` directly; do not add a
  Taskfile wrapper for it ([CI/CD](../ci-cd/index.md)).
