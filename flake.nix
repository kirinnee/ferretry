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
              gitHooks
              packages
              pkgs
              pre-commit-lib
              formatter
              ;
          };
          # Deliberately independent of `pre-commit` above: one of that hook set's own gates proves
          # these launchers, so the launchers cannot be derived from it. `shellHookFor` asserts the
          # two agree on the stages installed and the config filename resolved.
          gitHooks = import ./nix/git-hooks.nix {
            inherit pkgs;
            preCommit = packages.pre-commit;
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
          /*
            `checks.pre-commit-check.shellHook` is deliberately NOT sourced here. It calls
            `pre-commit install` without `-f`, which engages migration mode against whatever
            already occupies the hook path — including its own launcher from a previous entry —
            and it rewrites the shared `core.hooksPath` on every entry from every one of this
            repository's mandatory linked worktrees. `nix/git-hooks.nix` owns installation
            instead; the check itself is untouched and still runs under `nix flake check`.
          */
          devShells = import ./nix/shells.nix {
            inherit pkgs env packages;
            shellHook = gitHooks.shellHookFor {
              configFile = pre-commit.config.configFile;
              generatedConfigPath = pre-commit.config.configPath;
              installStages = pre-commit.config.installStages;
            };
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
