{
  packages,
  formatter,
  pkgs,
  pre-commit-lib,
}:
let
  # Deliberate simplification vs diene: hooks call the workspace's own node_modules tooling
  # (installed by `task setup`) instead of a nix-built fixed-output tooling derivation. This
  # keeps the flake hash-free; the trade-off is that `nix flake check` cannot run these hooks
  # hermetically — run `pre-commit run --all-files` inside the devshell instead.
  validator-runtime = pkgs.buildEnv {
    name = "workspace-validator-runtime";
    paths = [
      packages.bash
      # The reachability gate walks the real module graph, so its validator shells out to bun.
      packages.bun
      packages.git
      packages.jq
      packages.ripgrep
      packages.yq-go
      pkgs.coreutils
      pkgs.findutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.gawk
    ];
  };
  validator =
    command:
    ''${packages.bash}/bin/bash -c 'export PATH=${validator-runtime}/bin; exec ${packages.bash}/bin/bash ${command} "$@"' --'';
  bun-tool = name: "${packages.bash}/bin/bash -c 'exec ./node_modules/.bin/${name} \"$@\"' --";
  # Like bun-tool, a repo script that drives a node_modules binary keeps the ambient
  # devshell PATH: the validator runtime deliberately has no node for tsc's shebang.
  bun-script = script: "${packages.bash}/bin/bash -c 'exec ${script} \"$@\"' --";
in
pre-commit-lib.run {
  src = ./..;

  hooks = {
    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "^Changelog\\.md$"
        "^Changelog\\.old\\.md$"
      ];
    };

    a-action-pins-non-trusted = {
      enable = true;
      name = "Non-trusted action SHA pins";
      entry = validator "scripts/validate/action-pins.sh non-trusted";
      files = "^(\\.github/workflows/.*\\.ya?ml|config/action-trust\\.json)$";
      pass_filenames = false;
      language = "system";
    };

    a-action-pins-trusted = {
      enable = true;
      name = "Trusted action major pins";
      entry = validator "scripts/validate/action-pins.sh trusted";
      files = "^(\\.github/workflows/.*\\.ya?ml|config/action-trust\\.json)$";
      pass_filenames = false;
      language = "system";
    };

    a-cli-contracts = {
      enable = true;
      name = "Workspace and CLI release contracts";
      entry = validator "scripts/validate/cli-contracts.sh all";
      files = "^(\\.goreleaser\\.yaml|\\.releaserc\\.yaml|Casks/.*|INSTALLATION\\.md|Taskfile\\.yaml|flake\\.nix|go\\.mod|nix/ferretry\\.nix|package\\.json|packages/.*|scripts/release/.*|scripts/validate/cli-contracts\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    a-composition-reachability = {
      enable = true;
      name = "Composition-root reachability";
      entry = validator "scripts/validate/composition-reachability.sh";
      files = "^(packages/.*\\.ts|packages/[^/]+/package\\.json|scripts/validate/composition-reachability\\.(sh|ts)|scripts/validate/reachability-allowlist\\.txt)$";
      pass_filenames = false;
      language = "system";
    };

    a-composition-invocation = {
      enable = true;
      name = "Composition-root invocation";
      entry = validator "scripts/validate/composition-invocation.sh";
      files = "^(packages/[^/]+/bin/.*\\.ts|packages/[^/]+/src/.*\\.ts|scripts/validate/composition-invocation\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    a-no-legacy-state = {
      enable = true;
      name = "No legacy package state";
      entry = validator "scripts/validate/no-legacy-state.sh";
      files = "^(packages/.*|scripts/validate/no-legacy-state\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    a-enforce-exec = {
      enable = true;
      name = "Executable shell scripts";
      entry = validator "scripts/validate/executable-shells.sh";
      files = ".*\\.sh$";
      pass_filenames = false;
      language = "system";
    };

    a-commit-msg = {
      enable = true;
      name = "Conventional commit";
      entry = validator "scripts/validate/commit-msg.sh";
      stages = [ "commit-msg" ];
      pass_filenames = true;
      language = "system";
    };

    a-shellcheck = {
      enable = true;
      name = "Shellcheck";
      entry = "${packages.shellcheck}/bin/shellcheck";
      files = ".*\\.sh$";
      pass_filenames = true;
      language = "system";
    };

    a-biome = {
      enable = true;
      name = "Biome lint";
      entry = bun-tool "biome lint --no-errors-on-unmatched";
      files = "(^biome\\.json$|\\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$)";
      pass_filenames = true;
      language = "system";
    };

    a-deadcode = {
      enable = true;
      name = "Knip repository dead code";
      entry = bun-tool "knip --config knip.json";
      files = "((^|/)package\\.json$|(^|/)tsconfig\\.json$|^knip\\.json$|\\.(ts|tsx)$)";
      pass_filenames = false;
      language = "system";
    };

    a-deadcode-production = {
      enable = true;
      name = "Knip production dead code";
      entry = bun-tool "knip --config knip.production.json";
      files = "((^|/)package\\.json$|(^|/)tsconfig\\.json$|^knip\\.production\\.json$|\\.(ts|tsx)$)";
      pass_filenames = false;
      language = "system";
    };

    typecheck = {
      enable = true;
      name = "TypeScript typecheck";
      entry = bun-script "scripts/validate/typecheck.sh";
      files = "((^|/)package\\.json$|(^|/)tsconfig\\.json$|\\.(ts|tsx|mts|cts)$)";
      pass_filenames = false;
      language = "system";
    };
  };
}
