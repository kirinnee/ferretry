{ pkgs }:
# TODO(nice-to-have): add the CLI's nix package build (fixed-output node_modules derivation +
# `bun build --compile`, as in diene's nix/packages.nix `cli` attrset) once the dependency hash
# is worth maintaining. Deferred at P0.
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
