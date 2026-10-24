{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";
    # pre-commit-hooks resolves the `pre-commit` binary from ITS OWN nixpkgs. Following ours keeps one
    # pin for both, so the devshell and the hook runner share one cache.nixos.org-substituted package.
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
            Stock nixpkgs, with NO overlay — and that is a CI-speed property, not an omission. Hydra
            has already built and tested every package at this pin, so `nix develop` substitutes the
            whole closure from cache.nixos.org. The overlay that used to sit here (`disabledTests` on
            `pre-commit`, #246) changed the derivation hash, so EVERY CI job rebuilt pre-commit from
            source and ran its ~715 upstream tests: ~45s of each job's ~80s Nix setup, on twelve jobs a
            run, and the source of the `Cannot build pre-commit-4.5.1.drv` failures. Those upstream
            tests are not this repository's to run; Hydra runs them. Do not override a package here
            without checking it still substitutes (`nix build --dry-run .#devShells.<system>.ci`
            must list nothing under "will be built" beyond this flake's own derivations). The one
            pinned leaf, Bun (nix/bun.nix), is one of those: a download and a patchelf, overridden
            where this flake uses it rather than here, so no nixpkgs package changes hash with it.
          */
          pkgs = import nixpkgs { inherit system; };
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
            inherit (devPackages) bun;
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
