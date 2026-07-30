---
id: nix
title: Nix Flake Configuration
---

# Nix Flake Configuration

Every tool this repository needs — Bun, go-task, GoReleaser, shellcheck, treefmt, jq — comes
from the Nix flake. Local development, CI, and CD all run the same pinned versions, so "works
on my machine" and "works in the pipeline" mean the same thing.

The configuration uses a **modular flake architecture**: `flake.nix` orchestrates, and each
concern lives in its own file under `nix/`.

## Quick reference

```
nix/
├── packages.nix   # aggregate packages from registries
├── env.nix        # group packages by purpose
├── shells.nix     # define dev environments
├── fmt.nix        # configure formatters (treefmt)
└── pre-commit.nix # configure git hooks

flake.nix          # main flake (orchestrator)
.envrc             # direnv (watches nix files, loads the default shell)
```

## File structure

### flake.nix — the orchestrator

**Purpose**: define inputs (package registries) and export outputs (packages, devShells,
formatter, checks).

Inputs today:

| Input              | Provides                                      |
| ------------------ | --------------------------------------------- |
| `nixpkgs`          | every tool package (`nixos-unstable`)         |
| `flake-utils`      | `eachDefaultSystem` — per-platform outputs    |
| `treefmt-nix`      | the multi-formatter wrapper used by `fmt.nix` |
| `pre-commit-hooks` | the hook runner used by `pre-commit.nix`      |

The outputs use `with rec { ... }` so modules can reference each other. Each module is
imported with only the parameters it needs, and the pre-commit check's `shellHook` is threaded
into `shells.nix`:

```nix
devShells = import ./nix/shells.nix {
  inherit pkgs env packages;
  shellHook = checks.pre-commit-check.shellHook;
};
```

That is what installs the git hooks when you enter the shell. Exported outputs are `checks`
(`pre-commit-check`, `format`), `formatter`, `packages`, and `devShells`.

### nix/packages.nix — package aggregation

**Purpose**: combine packages from every registry into one flat attribute set that `env.nix`
consumes.

Only `nixpkgs` is wired today, so the file is a single `inherit (pkgs) ...` block:
`actionlint bash bun git go go-task goreleaser jq pre-commit ripgrep shellcheck treefmt
yq-go`. When more than one registry is in play, each registry gets its own group in a
`let all = { ... }` block and the groups merge with `//` in priority order — later groups win.

> The CLI's own nix package build (a fixed-output `node_modules` derivation plus
> `bun build --compile`) is deliberately **not** here yet; maintaining the dependency hash
> was not worth it at P0. The `TODO` in `packages.nix` records that decision. Compilation is
> owned by `scripts/release/compile.sh` instead.

### nix/env.nix — environment groups

**Purpose**: organize packages into functional groups so each shell includes only what it
needs.

| Group      | Contents                                                 | Why it exists                               |
| ---------- | -------------------------------------------------------- | ------------------------------------------- |
| `main`     | `bash bun git go-task jq ripgrep yq-go`                  | run and build the workspace                 |
| `lint`     | `actionlint pre-commit ripgrep shellcheck treefmt yq-go` | the gates in [Linting](../linting/index.md) |
| `dev`      | `git go-task jq`                                         | interactive convenience                     |
| `releaser` | `git go goreleaser`                                      | release-only tooling                        |

The `releaser` group and the `.#releaser` shell are named after their job — running
[GoReleaser](https://goreleaser.com) at release time. There is no tool of that name in this
repository; `go` is present only because GoReleaser compiles a Go stub per target, over which a
post-build hook swaps the real Bun binary.

**When to create a new group**: when a set of packages belongs in some shells but not others.
Release-only tooling is the archetype — `goreleaser` and `go` have no business in the CI lint
lane, so they live in their own group.

### nix/shells.nix — development environments

**Purpose**: define environments by composing groups with `++`.

| Shell      | Composition                       | Used by                                            |
| ---------- | --------------------------------- | -------------------------------------------------- |
| `default`  | `main ++ lint ++ dev ++ releaser` | direnv / `nix develop` — everything                |
| `ci`       | `lint ++ main`                    | every CI job (`nix develop .#ci -c ./scripts/...`) |
| `releaser` | `lint ++ main ++ releaser`        | `cd.yaml` — GoReleaser publish                     |

**IMPORTANT**: every shell must use `inherit shellHook;`. Do not override or customize
`shellHook` in `shells.nix` — the inherited hook is what installs the git hooks, and
downstream nix-resolvers do not understand custom modifications.

**Usage**: `nix develop` for the default shell, `nix develop .#ci` or `.#releaser` for a
named one.

### nix/fmt.nix — formatters

**Purpose**: configure multi-language formatting through treefmt. Each formatter is enabled
with `program-name.enable = true`, and the config is evaluated with
`treefmt-nix.lib.evalModule`.

Enabled today: `actionlint`, `nixfmt`, `prettier`, `shfmt`. `prettier` excludes `Changelog.md`
and `Changelog.old.md` — those are generated by semantic-release and reformatting them would
churn the release commit.

Supported programs: https://github.com/numtide/treefmt-nix#supported-programs

### nix/pre-commit.nix — git hooks

**Purpose**: declare every repository gate. Hooks are defined with `pre-commit-lib.run` and
the treefmt formatter hook comes first. The full inventory and the rules for adding one live
in [Linting](../linting/index.md); this section covers only the nix mechanics.

Two helpers keep the hooks honest:

- `validator` wraps a repo shell script in an explicit `PATH` built from a
  `pkgs.buildEnv` (bash, git, jq, ripgrep, yq-go, coreutils, findutils, grep, sed, awk). A
  validator therefore cannot accidentally depend on a host-installed binary.
- `bun-tool` invokes `./node_modules/.bin/<name>` for the JS/TS gates (Biome, Knip,
  `tsc`).

**Deliberate trade-off**: the JS/TS hooks use the workspace's own `node_modules` (installed by
`task setup`) rather than a nix-built fixed-output tooling derivation. That keeps the flake
hash-free, at the cost that `nix flake check` cannot run those hooks hermetically. Run
`pre-commit run --all-files` inside the devshell instead.

**Hook naming convention**: prefix custom hook names with `a-` (`a-shellcheck`, `a-biome`,
`a-cli-contracts`). The prefix sorts repository-owned hooks together, ahead of the
upstream-named ones. Two hooks do not carry it: `treefmt`, which is the upstream formatter hook,
and `typecheck`.

Hook types:

| Type      | Purpose             | Example in this repo                 |
| --------- | ------------------- | ------------------------------------ |
| Formatter | Runs treefmt        | `treefmt`                            |
| Linter    | Checks file quality | `a-shellcheck`, `a-biome`            |
| Enforcer  | Validates policies  | `a-cli-contracts`, `a-action-pins-*` |

### .envrc — direnv configuration

**Purpose**: load the default dev shell automatically and reload it when the nix files change.

```bash
watch_file "./nix/env.nix" "./nix/fmt.nix" "./nix/packages.nix" "./nix/shells.nix" "./nix/pre-commit.nix" "./flake.nix"
use flake
```

1. `watch_file` — every nix module plus `flake.nix`, so editing any of them triggers a reload.
2. `use flake` — loads the default shell.
3. Optional `PATH_add` — for repo-local paths only (see below).

**PATH_add rules**: you may add `PATH_add` entries for paths whose existence is **declared by
a file checked into the repository**. The path need not be inside the repo, but the reason it
exists must be traceable to repo config. These are a dev convenience only; all primary tool
installation stays in nix.

```bash
# OK — existence declared by repo config files
PATH_add node_modules/.bin           # declared by package.json

# NOT OK — arbitrary external paths not traceable to repo config
# PATH_add /usr/local/custom-tool/bin
# export TOOL_HOME=/some/path
```

This repo currently adds nothing to `PATH`: scripts and hooks call `./node_modules/.bin/<tool>`
explicitly, which is unambiguous and works identically in CI.

**Do not** use `.envrc` to install tools, export environment variables, or add arbitrary
external paths.

## Data flow

```
Registries (flake.nix inputs)
           |
    packages.nix (aggregate into attrset, merge with //)
           |
       env.nix (group into named lists)
           |
     shells.nix (compose lists with ++)
           |
    flake.nix (export as devShells, checks, formatter)
```

## Common operations

### Adding a package

1. **Add it in `nix/packages.nix`** — extend the `inherit (pkgs) ...` list (or the right
   registry group if more registries are wired):

```nix
{ pkgs }:
{
  inherit (pkgs)
    # ... existing packages ...
    new-package
    ;
}
```

2. **Add it to an environment group** in `nix/env.nix`:

```nix
lint = [ existing-package new-package ];
```

3. **Apply**: `direnv reload`.

### Removing a package

1. Remove the name from `nix/packages.nix`.
2. Remove it from every group in `nix/env.nix`.
3. Apply: `direnv reload`.

### Adding an environment group

**When**: a set of packages belongs in some shells but not others.

1. **Add the group** in `nix/env.nix`:

```nix
{ pkgs, packages }:
with packages;
{
  # ... existing groups ...
  my-new-group = [ package1 package2 ];
}
```

2. **Use it in shells** in `nix/shells.nix`:

```nix
my-shell = pkgs.mkShell {
  buildInputs = main ++ my-new-group;
  inherit shellHook;
};
```

### Adding a shell

**When**: a distinct workflow needs a different package combination — a new pipeline lane, for
example.

```nix
{ pkgs, packages, env, shellHook }:
with env;
{
  # ... existing shells ...
  my-shell = pkgs.mkShell {
    buildInputs = lint ++ main;
    inherit shellHook;
  };
}
```

**IMPORTANT**: always `inherit shellHook;`. Then use it: `nix develop .#my-shell`. If a CI or
CD job needs the new shell, wire it in the workflow as
`nix develop .#my-shell -c ./scripts/ci/<script>.sh` — see [CI/CD](../ci-cd/index.md).

### Adding a formatter

1. **Enable it in `nix/fmt.nix`**:

```nix
programs = {
  formatter-name.enable = true;
};
```

2. **Optionally exclude files**:

```nix
programs.formatter-name.excludes = [ "pattern" ];
```

### Adding a pre-commit hook

**Convention**: prefix custom hook names with `a-`, and route repo scripts through the
`validator` wrapper so the hook's `PATH` stays explicit.

```nix
# In nix/pre-commit.nix, add to hooks:
hooks = {
  a-my-linter = {
    enable = true;
    name = "Display Name";
    entry = "${packages.my-tool}/bin/my-tool --args";
    files = "\\.(ext)$";
    pass_filenames = true;
    language = "system";
  };

  a-my-enforcer = {
    enable = true;
    name = "Policy Check";
    entry = validator "scripts/validate/my-check.sh";
    files = "^config/.*$";
    pass_filenames = false;
    language = "system";
  };
};
```

New policy enforcers belong in `scripts/validate/` — see [Contracts](../contracts/README.md).

### Adding a registry

1. **Add the input** in `flake.nix`:

```nix
inputs = {
  # ... existing inputs ...
  my-registry.url = "github:myorg/nix-registry";
};
```

2. **Wire it** in the outputs function parameters and pass it to `packages.nix`.

3. **Use it in `nix/packages.nix`** — add the parameter and create a group:

```nix
{ pkgs, my-registry }:
let
  all = {
    nixpkgs-group = { inherit (pkgs) bun jq; };
    my-org = with my-registry; { inherit tool1 tool2; };
  };
in
with all;
nixpkgs-group // my-org
```

### Adding a binary to PATH

**All tool binaries must be managed through nix.** That is what makes local dev, CI, and CD
reproducible.

1. Find the package that provides it (`nix search nixpkgs <name>`).
2. Add it to `nix/packages.nix` → `nix/env.nix`.
3. It lands on `PATH` in every shell whose groups include it.

**If a binary cannot be packaged in nix** (it only exists via `npm`/`bun install`, say), either
add its path via `.envrc` `PATH_add` when the path is repo-declared, or invoke it explicitly
from the task runner or hook — this repo's convention is the explicit
`./node_modules/.bin/<tool>` call.

## Usage commands

| Action            | Command                        |
| ----------------- | ------------------------------ |
| Enter shell       | `nix develop` or `cd` (direnv) |
| Specific shell    | `nix develop .#ci`             |
| Update registries | `nix flake update`             |
| Search packages   | `nix search nixpkgs <name>`    |
| Show flake info   | `nix flake show`               |
| Reload direnv     | `direnv reload`                |

## Key concepts

### Modularity

Each file has a single responsibility:

- `packages.nix` = what packages exist (aggregation)
- `env.nix` = how packages are grouped (purpose)
- `shells.nix` = which shells include which groups (composition)
- `fmt.nix` = how files are formatted
- `pre-commit.nix` = what runs before commits
- `.envrc` = watches nix files and loads the default shell

### Composability

Groups are defined once and composed into multiple shells:

```nix
# Define groups once in env.nix
lint = [ pkg1 pkg2 ];
releaser = [ pkg3 pkg4 ];

# Compose differently in shells.nix
default = main ++ lint ++ dev ++ releaser;
ci = lint ++ main;                          # no release tooling
```

### Separation of concerns

- **Package source** (where it comes from) vs **group** (what it is for) vs **shell** (when it
  is available).
- **Formatter** (how to format) vs **hook** (when to run).
- **Definition** (in `nix/`) vs **orchestration** (in `flake.nix`).
- **Default shell** (direnv, `nix develop`) vs **named shells** (`.#ci`, `.#releaser`).

## See also

- [Linting](../linting/index.md) — the hook inventory and how gates run.
- [CI/CD](../ci-cd/index.md) — which shell each pipeline job uses.
- [Taskfile Conventions](../taskfile/index.md) — the task surface that runs inside the shell.
