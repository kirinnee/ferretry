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
    # Every session lives in a tmux pane, and the integration tier drives a real tmux. It used to be the
    # runner image's (3.6a on Linux, Homebrew's 3.8 on macOS), so two machines ran two programs with two
    # sets of races: 3.6a wedges a server whose control client loses its daemon mid-kill-server, and 3.8
    # prints no pid for a dead pane. Three of the integration flakes of the week to 2026-10-29 were those
    # two versions. One flake-locked tmux on every runner makes it one program;
    # scripts/validate/pinned-toolchain.sh refuses a tmux from anywhere else and prints its version.
    tmux
    wrangler
    yq-go
  ]
  # The private display a Linux agent browser in Browser mode "Real window" draws into
  # (docs/browser-mode.md), so its integration tests run a real headed Chrome here and in CI.
  # strace counts the daemon's file system calls for the per-tick budget test
  # (packages/daemon/tests/realworld/runtime/state-syscalls.test.ts).
  ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
    pkgs.xvfb
    pkgs.strace
  ];

  releaser = [
    git
    go
    goreleaser
  ];
}
