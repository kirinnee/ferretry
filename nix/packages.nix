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
    ripgrep
    shellcheck
    treefmt
    wrangler
    yq-go
    ;

  /*
    pre-commit, with ONE of its own upstream tests skipped.

    `tests/repository_test.py::test_output_isatty` asserts on whether stdout is a terminal, so it
    depends on how the runner allocates a TTY rather than on anything about the package. It failed
    the Containment (macOS) job on three separate pull requests in one evening — twice on commits
    whose sibling run passed — while never reaching a line of this repository's code. A job that
    fails for reasons a contributor cannot act on is a job people learn to re-run until it is green,
    and a suite that is re-run until green has stopped meaning anything.

    Deliberately `disabledTests` rather than `doCheck = false`: the rest of upstream's suite still
    runs, so this skips the one test that measures the runner instead of the tool. It also fails
    loudly if upstream ever renames it, which a blanket disable would not.
  */
  pre-commit = pkgs.pre-commit.overridePythonAttrs (previous: {
    disabledTests = (previous.disabledTests or [ ]) ++ [ "test_output_isatty" ];
  });
}
