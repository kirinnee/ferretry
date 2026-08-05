{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";
    # pre-commit-hooks builds the `pre-commit` binary from ITS OWN nixpkgs, so an override applied to
    # ours never reached the package that actually runs. Following ours makes one overlay govern both.
    pre-commit-hooks.inputs.nixpkgs.follows = "nixpkgs";

    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };
  outputs =
    {
      self,
      flake-utils,
      treefmt-nix,
      pre-commit-hooks,
      nixpkgs,
    }:
    (flake-utils.lib.eachSystem
      [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ]
      (
        system:
        let
          /*
            One overlay, so every consumer of `pre-commit` gets the same package — ours in the
            devshell and pre-commit-hooks' own. `tests/repository_test.py::test_output_isatty`
            asserts on whether stdout is a terminal, so it measures the CI runner rather than the
            tool: it failed Containment (macOS) on three pull requests in one evening, twice on
            commits whose sibling run of the identical commit passed, without reaching a line of this
            repository's code.

            `disabledTests` rather than `doCheck = false` — the other 714 upstream tests still run,
            and a rename upstream fails the build loudly instead of silently skipping nothing.
          */
          pkgs = import nixpkgs {
            inherit system;
            overlays = [
              (_: previous: {
                pre-commit = previous.pre-commit.overridePythonAttrs (old: {
                  disabledTests = (old.disabledTests or [ ]) ++ [ "test_output_isatty" ];
                });
              })
            ];
          };
          pre-commit-lib = pre-commit-hooks.lib.${system};
        in
        with rec {
          pre-commit = import ./nix/pre-commit.nix {
            inherit
              packages
              pkgs
              pre-commit-lib
              formatter
              ;
          };
          formatter = import ./nix/fmt.nix {
            inherit treefmt-nix pkgs;
          };
          devPackages = import ./nix/packages.nix {
            inherit pkgs;
          };
          releasePackages = import ./nix/ferretry.nix {
            inherit pkgs;
            lib = pkgs.lib;
            src = self;
          };
          packages = devPackages // releasePackages;
          env = import ./nix/env.nix {
            inherit pkgs;
            packages = devPackages;
          };
          devShells = import ./nix/shells.nix {
            inherit pkgs env packages;
            shellHook = checks.pre-commit-check.shellHook + ''
              # Linked worktrees share the hooks directory but not their generated
              # .pre-commit-config.yaml. The hook launcher must therefore use a config
              # retained under the Git common directory, not a relative path in the
              # worktree that most recently entered this devshell.
              if git rev-parse --git-dir &> /dev/null; then
                git_worktree="$(git rev-parse --show-toplevel)"
                git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
                common_config="''${git_common_dir}/ferretry-pre-commit-config.yaml"
                generated_config="$(readlink -f "''${git_worktree}/.pre-commit-config.yaml")"

                nix-store --add-root "''${common_config}" --indirect --realise "''${generated_config}"
                git config --local --unset-all core.hooksPath || true
                for hook_type in pre-commit commit-msg; do
                  pre-commit install -c "''${common_config}" -t "''${hook_type}"

                  # pre-commit rewrites an absolute config to a path relative to the
                  # worktree that installed the hook. Git runs this shared launcher from
                  # every linked worktree, so resolve from the launcher's common hooks
                  # directory instead.
                  hook_path="$(git rev-parse --git-path hooks)/''${hook_type}"
                  config_from_hook_dir='$(cd "$(dirname "$0")/.."; pwd)/ferretry-pre-commit-config.yaml'
                  sed -i "s|^ARGS=(hook-impl --config=.* --hook-type=''${hook_type})$|ARGS=(hook-impl --config=\"''${config_from_hook_dir}\" --hook-type=''${hook_type})|" "''${hook_path}"
                done
                git config --local core.hooksPath "''${git_common_dir}/hooks"
              fi
            '';
          };
          checks = {
            pre-commit-check = pre-commit;
            format = formatter;
            release-bundle = releasePackages.default;
          };
        };
        {
          inherit
            checks
            formatter
            packages
            devShells
            ;
          apps = {
            default = {
              type = "app";
              program = "${releasePackages.default}/bin/fy";
            };
            fy = {
              type = "app";
              program = "${releasePackages.fy}/bin/fy";
            };
            fyd = {
              type = "app";
              program = "${releasePackages.fyd}/bin/fyd";
            };
          };
        }
      )
    );
}
