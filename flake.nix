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
    (flake-utils.lib.eachDefaultSystem (
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
        packages = import ./nix/packages.nix {
          inherit pkgs;
        };
        env = import ./nix/env.nix {
          inherit pkgs packages;
        };
        devShells = import ./nix/shells.nix {
          inherit pkgs env packages;
          shellHook = checks.pre-commit-check.shellHook;
        };
        checks = {
          pre-commit-check = pre-commit;
          format = formatter;
        };
      };
      {
        inherit
          checks
          formatter
          packages
          devShells
          ;
      }
    ));
}
