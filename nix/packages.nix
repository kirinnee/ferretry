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
    pre-commit
    ripgrep
    shellcheck
    treefmt
    yq-go
    ;
}
