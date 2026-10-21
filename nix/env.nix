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
    nodejs_24
    ripgrep
    wrangler
    yq-go
  ]
  # The private display a Linux agent browser in Browser mode "Real window" draws into
  # (docs/browser-mode.md), so its integration tests run a real headed Chrome here and in CI.
  ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.xvfb ];

  releaser = [
    git
    go
    goreleaser
  ];
}
