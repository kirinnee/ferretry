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
  # PROOF BRANCH ONLY: tmux 3.8, the version Homebrew ships, to run the integration tier on it.
  tmux = pkgs.tmux.overrideAttrs (_: {
    version = "3.8";
    src = pkgs.fetchFromGitHub {
      owner = "tmux";
      repo = "tmux";
      rev = "3.8";
      hash = "sha256-pv2wlr3coo+E0pfpb58giJJQn9PGgMFqtVA6nk+9JdE=";
    };
  });
}
