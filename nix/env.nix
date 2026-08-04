{ pkgs, packages }:
with packages;
{
  dev = [
    git
    go-task
    jq
  ];

  lint = [
    actionlint
    pre-commit
    ripgrep
    shellcheck
    treefmt
    yq-go
  ];

  main = [
    bash
    bun
    git
    go-task
    jq
    ripgrep
    wrangler
    yq-go
  ];

  releaser = [
    git
    go
    goreleaser
  ];
}
