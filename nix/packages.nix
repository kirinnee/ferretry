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
    tmux
    treefmt
    wrangler
    yq-go
    ;
  # Not `pkgs.bun`: the Bun version is pinned ahead of nixpkgs, and nix/bun.nix says why.
  bun = import ./bun.nix { inherit pkgs; };
  # tmux 3.8, the release Homebrew ships, for the realworld workflow's 3.8 leg only (nix/env.nix says
  # why CI pins nixpkgs' 3.7b). nixpkgs has no 3.8 yet, so this is its own derivation at the 3.8 tag —
  # built from source, which is why no blocking job uses it.
  tmux_3_8 = pkgs.tmux.overrideAttrs (_: {
    version = "3.8";
    src = pkgs.fetchFromGitHub {
      owner = "tmux";
      repo = "tmux";
      rev = "3.8";
      hash = "sha256-pv2wlr3coo+E0pfpb58giJJQn9PGgMFqtVA6nk+9JdE=";
    };
  });
}
