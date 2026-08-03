{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

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
          pkgs = nixpkgs.legacyPackages.${system};
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
            shellHook = checks.pre-commit-check.shellHook;
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
