{ pkgs }:
{
  inherit (pkgs)
    actionlint
    bash
    bun
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
}
