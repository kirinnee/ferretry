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
  # `run` otherwise defaults to pre-commit-hooks.nix's own nixpkgs package.
  # Keep its upstream suite intact except for the runner-dependent isatty test
  # disabled on packages.pre-commit in flake.nix.
  package = packages.pre-commit;

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

    # Nix used to restate the workspace links by hand. When fyd added the relay transport, that list
    # stayed unchanged and the documented Nix install stopped building while every CI gate passed.
    # Exercise the generated tree in Pre-Commit, the CI job that actually runs repository contracts.
    a-nix-workspace-links = {
      enable = true;
      name = "Nix workspace package links";
      entry = validator "scripts/validate/nix-workspace-links.sh self-test";
      files = "^(nix/ferretry\\.nix|package\\.json|packages/.*|scripts/validate/nix-workspace-links\\.sh)$";
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

    # The hosted relay is the one subsystem whose configuration meets its code only in production:
    # no test reads a wrangler config or a workflow's shell. Includes the adapter sources because
    # the gate cross-checks the routes and Durable Object classes they declare against the two.
    a-relay-config = {
      enable = true;
      name = "Hosted relay configuration";
      entry = validator "scripts/validate/relay-config.sh";
      files = "^(packages/relay/wrangler\\.(hosted\\.json|jsonc)|packages/relay/src/adapters/(worker|hosted-control)\\.ts|\\.github/workflows/relay-hosted\\.yaml|scripts/validate/relay-config\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    # One browser, several paired daemons: the ids a daemon mints are unique only within it, so
    # anything the bundle remembers about daemon-owned data has to be keyed by (daemonId, …). Runs
    # on the whole PWA rather than the touched files because two of its three passes are questions
    # about the bundle as a whole — which caches the connection registry reaches, and which stores
    # nothing constructs.
    a-daemon-scope = {
      enable = true;
      name = "PWA daemon scoping";
      entry = validator "scripts/validate/daemon-scope.sh";
      files = "^(packages/pwa/src/.*\\.tsx?|scripts/validate/daemon-scope\\.(sh|ts)|scripts/validate/daemon-scope-allowlist\\.txt)$";
      pass_filenames = false;
      language = "system";
    };

    # An unbound `fetch` stored on an object throws "Illegal invocation" the first time it is
    # invoked as a member, and no suite that injects a fetcher can see it — an injected plain
    # function does not care what its receiver is. It has shipped twice, both times as every paired
    # daemon reading unreachable at once, so the shape is refused at the point it is written rather
    # than defended against at each call site.
    a-fetch-binding = {
      enable = true;
      name = "PWA fetch binding";
      entry = validator "scripts/validate/fetch-binding.sh";
      files = "^(packages/pwa/src/.*\\.tsx?|scripts/validate/fetch-binding\\.sh)$";
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
