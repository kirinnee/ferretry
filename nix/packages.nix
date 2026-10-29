{ pkgs }:
{
  inherit (pkgs)
    actionlint
    bash
    git
    go
    go-task
    goreleaser
    jq
    nodejs_24
    pre-commit
    ripgrep
    shellcheck
    treefmt
    wrangler
    yq-go
    ;
  # Not `pkgs.bun`: the Bun version is pinned ahead of nixpkgs, and nix/bun.nix says why.
  bun = import ./bun.nix { inherit pkgs; };
}
