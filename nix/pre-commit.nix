{
  gitHooks,
  packages,
  formatter,
  pkgs,
  pre-commit-lib,
}:
let
  # Deliberate simplification vs diene: hooks call the workspace's own node_modules tooling
  # (installed by `task setup`) instead of a nix-built fixed-output tooling derivation. This
  # keeps the flake hash-free; the trade-off is that `nix flake check` cannot run these hooks
  # hermetically — run `pre-commit run --all-files` inside the devshell instead.
  validator-runtime = pkgs.buildEnv {
    name = "workspace-validator-runtime";
    paths = [
      packages.bash
      # The reachability gate walks the real module graph, so its validator shells out to bun.
      packages.bun
      packages.git
      packages.jq
      packages.ripgrep
      packages.yq-go
      pkgs.coreutils
      pkgs.findutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.gawk
    ];
  };
  validator =
    command:
    ''${packages.bash}/bin/bash -c 'export PATH=${validator-runtime}/bin; exec ${packages.bash}/bin/bash ${command} "$@"' --'';
  # The one gate that proves the devshell's own hook installation rather than a repository fact, so
  # it lives beside the installer under `nix/` instead of in `scripts/validate/`. It brings its own
  # PATH for the same reason the validator wrapper does, plus `cmp`, which compares an installed
  # launcher with the generated one.
  hook-proof =
    arguments:
    "${packages.bash}/bin/bash -c 'export PATH=${gitHooks.runtime}/bin:$PATH; exec ${packages.bash}/bin/bash nix/git-hooks/worktree-proof.sh ${arguments}' --";
  bun-tool = name: "${packages.bash}/bin/bash -c 'exec ./node_modules/.bin/${name} \"$@\"' --";
  # Like bun-tool, a repo script that drives a node_modules binary keeps the ambient
  # devshell PATH: the validator runtime deliberately has no node for tsc's shebang.
  bun-script = script: "${packages.bash}/bin/bash -c 'exec ${script} \"$@\"' --";
in
pre-commit-lib.run {
  src = ./..;
  # `run` otherwise defaults to pre-commit-hooks.nix's own nixpkgs package.
  # Keep its upstream suite intact except for the runner-dependent isatty test
  # disabled on packages.pre-commit in flake.nix.
  package = packages.pre-commit;

  hooks = {
    treefmt = {
      enable = true;
      package = formatter;
      excludes = [
        "^Changelog\\.md$"
        "^Changelog\\.old\\.md$"
      ];
    };

    a-action-pins-non-trusted = {
      enable = true;
      name = "Non-trusted action SHA pins";
      entry = validator "scripts/validate/action-pins.sh non-trusted";
      files = "^(\\.github/(workflows|actions)/.*\\.ya?ml|config/action-trust\\.json)$";
      pass_filenames = false;
      language = "system";
    };

    a-action-pins-trusted = {
      enable = true;
      name = "Trusted action major pins";
      entry = validator "scripts/validate/action-pins.sh trusted";
      files = "^(\\.github/(workflows|actions)/.*\\.ya?ml|config/action-trust\\.json)$";
      pass_filenames = false;
      language = "system";
    };

    a-cli-contracts = {
      enable = true;
      name = "Workspace and CLI release contracts";
      entry = validator "scripts/validate/cli-contracts.sh all";
      files = "^(\\.goreleaser\\.yaml|\\.releaserc\\.yaml|Casks/.*|INSTALLATION\\.md|Taskfile\\.yaml|flake\\.nix|go\\.mod|nix/ferretry\\.nix|package\\.json|packages/.*|scripts/release/.*|scripts/validate/cli-contracts\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    # The all-loop, contract tables, hook inventory and hook/CI wiring are independently edited
    # registries. Compare them before another contract runs but disappears from its documentation.
    a-contract-registry = {
      enable = true;
      name = "Contract registry agreement";
      entry = validator "scripts/validate/contract-registry.sh";
      files = "^(docs/standards/(contracts/README|linting/index)\\.md|nix/pre-commit\\.nix|scripts/ci/test\\.sh|scripts/validate/.*\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    # The macOS runner policy: the darwin smoke is advisory on a pull request, required and retried on
    # main and a release tag, and only the free standard macos-15 runner is ever asked for.
    a-macos-policy = {
      enable = true;
      name = "macOS runner policy";
      entry = validator "scripts/validate/macos-policy.sh";
      files = "^(scripts/(ci/(macos-smoke-verdict|macos-smoke-skipped)|validate/macos-policy)\\.sh|\\.github/(workflows/.*\\.ya?ml|actions/smoke-darwin/.*))$";
      pass_filenames = false;
      language = "system";
    };

    # A test's tier is where it lives, and the blocking tiers' promise is a deterministic outcome: an
    # integration test that asserts a wall-clock or memory bound belongs in the realworld tier, which
    # files an issue instead of failing a merge. This also holds config/test-groups.json to the files
    # that exist and counts the unit tier's real-clock escapes.
    # Every workflow job states `timeout-minutes`, so a wedged job is a red job in minutes instead of a
    # runner held for GitHub's six-hour default (docs/standards/ci-cd, "Job ceilings").
    a-job-ceilings = {
      enable = true;
      name = "Workflow job ceilings";
      entry = validator "scripts/validate/job-ceilings.sh";
      files = "^(\\.github/workflows/.*\\.ya?ml|scripts/validate/job-ceilings\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    a-test-tiers = {
      enable = true;
      name = "Test tiers";
      entry = validator "scripts/validate/test-tiers.sh";
      files = "^(packages/(.*/)?tests/.*\\.test\\.tsx?|config/test-groups\\.json|nix/fmt\\.nix|scripts/(validate/test-tiers\\.sh|test/ci-sets\\.ts|ci/((quick|quick-part|parallel|integration|full-status|e2e-summary|pre-commit|gate-hook|full-gates)\\.sh|(unit-timings|gate-hooks)\\.ts))|\\.github/workflows/(ci|realworld)\\.yaml)$";
      pass_filenames = false;
      language = "system";
    };

    # The app build and the Pages deployment publish the same directory. Cheap and whole-repo, so it
    # runs on any change to the files it reads; `Pre-Commit (gates)` runs it on every CI run.
    a-pages-config = {
      enable = true;
      name = "Cloudflare Pages configuration";
      entry = validator "scripts/validate/pages-config.sh";
      files = "^(wrangler\\.jsonc|packages/app/(vite\\.config\\.ts|package\\.json|public/_(headers|redirects))|scripts/(ci/build-pwa|validate/pages-config)\\.sh|\\.github/workflows/pwa-pages\\.yaml)$";
      pass_filenames = false;
      language = "system";
    };

    # The hosted relay is the one subsystem whose configuration meets its code only in production:
    # no test reads a wrangler config or a workflow's shell. Includes the adapter sources because
    # the gate cross-checks the routes and Durable Object classes they declare against the two.
    a-relay-config = {
      enable = true;
      name = "Hosted relay configuration";
      entry = validator "scripts/validate/relay-config.sh";
      # Both ends import the same source default, and the release compiler is deliberately included
      # so a per-build define cannot return while Nix remains direct-only.
      files = "^(packages/plugins/(connections|catalogs)/worker/.*|scripts/(ci/(relay-directory-origin|relay-bundle-fingerprint|build-checks|quick|quick-part|setup)|local/setup|release/compile|validate/relay-config)\\.sh|\\.github/workflows/(ci|relay-hosted|link-store-hosted|cd|pwa-pages)\\.yaml)$";
      pass_filenames = false;
      language = "system";
    };

    # An unbound `fetch` stored on an object throws "Illegal invocation" the first time it is
    # invoked as a member, and no suite that injects a fetcher can see it — an injected plain
    # function does not care what its receiver is. It has shipped twice, both times as every paired
    # daemon reading unreachable at once, so the shape is refused at the point it is written rather
    # than defended against at each call site.
    a-fetch-binding = {
      enable = true;
      name = "App fetch binding";
      entry = validator "scripts/validate/fetch-binding.sh";
      files = "^(packages/(app/src|core/[^/]+/app|plugins/[^/]+/app)/.*\\.tsx?|scripts/validate/fetch-binding\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    # The 5.0 checks (redesign §7.9) through their one entry, scripts/gen/check.ts: the import, graph,
    # manifest, guarantee, host-file and no-compat rules over the whole workspace. Whole-tree, so it runs on
    # any source, manifest or generator change. See scripts/validate/rebuild-checks.sh.
    a-rebuild-checks = {
      enable = true;
      name = "Ferretry 5.0 checks";
      entry = bun-script "scripts/validate/rebuild-checks.sh";
      files = "^(packages/.*|scripts/(gen|validate)/.*|ports-pending\\.json|release\\.json|docs/rebuild/guarantees\\.tsv|package\\.json)$";
      pass_filenames = false;
      language = "system";
    };

    a-no-legacy-state = {
      enable = true;
      name = "No legacy package state";
      entry = validator "scripts/validate/no-legacy-state.sh";
      files = "^(packages/.*|scripts/validate/no-legacy-state\\.sh)$";
      pass_filenames = false;
      language = "system";
    };

    # Runs on EVERY file rather than a subset, and scans the whole tree rather than the staged paths:
    # a marker reaches `main` through the file somebody was not looking at. `docs/grants.md` shipped
    # with three of them behind eleven green checks, one of which treefmt had rewritten into valid
    # Markdown. Teaching documents that must quote a shape declare an exact path and reason in the
    # gate's allowlist; everything else is damage — see the script for both populations.
    a-conflict-markers = {
      enable = true;
      name = "No conflict markers";
      entry = validator "scripts/validate/conflict-markers.sh";
      files = ".*";
      pass_filenames = false;
      language = "system";
    };

    # An `fy-render` block renders an illustration in ONE surface — an assistant's own transcript
    # message — and is inert everywhere else in the app by a defaulted-off prop. In a durable file it
    # is not inert, it is wrong: a diagram in a document is an ordinary fenced block in that
    # document's own format. Runs on EVERY file and scans the whole tree, for the same reason the
    # conflict-markers gate does — the opener reaches `main` through the file nobody was looking at.
    # The two files that must SHOW the syntax to teach it are exempt by exact path; see
    # scripts/validate/no-fy-render-in-docs.sh and docs/fy-render.md.
    # The one-time v4 -> v5 converter stays outside the product: no workspace glob or root tsconfig include reaches
    # `migration/`, no file outside it, docs and this wiring names it, and it is private with no bin. Runs on every
    # commit and scans the whole tree, because a leak arrives through the file nobody was looking at; its own
    # planted-violation self-test runs first. See scripts/validate/migration-isolated.sh.
    a-migration-isolated = {
      enable = true;
      name = "v4 to v5 converter stays outside the product";
      entry = validator "scripts/validate/migration-isolated.sh";
      pass_filenames = false;
      language = "system";
    };

    # Test code never kills by pattern. Suites run from inside live agents' panes, and `pkill -f`
    # matches a regular expression against every command line on the machine — the live tmux server's
    # included. Teardowns kill by pid or by an exact `-S <own temp socket>` argv; see
    # scripts/validate/no-pattern-kill.sh.
    a-no-pattern-kill = {
      enable = true;
      name = "No pattern kills in test code";
      entry = validator "scripts/validate/no-pattern-kill.sh";
      files = "(^|/)(tests|scripts/test)/";
      pass_filenames = false;
      language = "system";
    };

    # Daemon code holds exactly the synchronous file calls its ledger declares. The daemon's main thread
    # answers every client, and on 2026-11-05 it stalled up to 61.9 s while swap saturated the disk; a sync
    # call holds every client for as long as the disk takes. See scripts/validate/no-sync-io.sh and
    # scripts/validate/sync-io-allowlist.txt.
    a-no-sync-io = {
      enable = true;
      name = "Daemon code declares every synchronous IO call";
      entry = validator "scripts/validate/no-sync-io.sh";
      files = "^(packages/(core/kernel/host|core/[^/]+/daemon|plugins/[^/]+/daemon)/.*\\.ts|scripts/validate/(no-sync-io\\.(sh|ts)|sync-io-allowlist\\.txt))$";
      pass_filenames = false;
      language = "system";
    };

    # No product code parses YAML with a reader of its own unless the ledger says why it is safe. One long
    # string aliased many times made `Bun.YAML.parse` of a 256 KiB gate.yaml cost 2.3 s and 5.4 GB at every
    # boot; the kernel's bounded reader refuses it in one pass. See scripts/validate/no-raw-yaml.sh and
    # scripts/validate/raw-yaml-allowlist.txt.
    a-no-raw-yaml = {
      enable = true;
      name = "Product code reads YAML only through the bounded reader";
      entry = validator "scripts/validate/no-raw-yaml.sh";
      files = "^(packages/.*\\.([cm]?[jt]s|[jt]sx)|scripts/validate/(no-raw-yaml\\.(sh|ts)|raw-yaml-allowlist\\.txt))$";
      pass_filenames = false;
      language = "system";
    };

    # A dead-code keep marker (`@pending`, `@public`, a knip `ignore`, any other knip setting that keeps code
    # alive) must name an open gap of a pending port, a kept guarantee row, a declared surface or an
    # ALLOWED_KNIP reason, so the knip gates cannot be quieted by a tag. A package.json change can make a
    # package a subsystem, so it runs here too.
    # See scripts/validate/pending-tags.sh.
    a-pending-tags = {
      enable = true;
      name = "Dead-code keep markers name an open fact";
      entry = validator "scripts/validate/pending-tags.sh";
      files = "^((.*/)?package\\.json|packages/.*\\.(ts|tsx|mts)|knip(\\.production)?\\.json|ports-pending\\.json|docs/rebuild/guarantees\\.tsv|scripts/validate/(pending-tags(\\.test)?\\.(sh|ts)|ports-pending\\.ts|guarantees\\.ts)|scripts/gen/lib/(workspace|imports)\\.ts)$";
      pass_filenames = false;
      language = "system";
    };

    a-no-fy-render-in-docs = {
      enable = true;
      name = "No fy-render fences in durable files";
      entry = validator "scripts/validate/no-fy-render-in-docs.sh";
      files = ".*";
      pass_filenames = false;
      language = "system";
    };

    a-enforce-exec = {
      enable = true;
      name = "Executable shell scripts";
      entry = validator "scripts/validate/executable-shells.sh";
      files = "(.*\\.sh|^scripts/host/ferretry-loopback-firewall)$";
      pass_filenames = false;
      language = "system";
    };

    a-commit-msg = {
      enable = true;
      name = "Conventional commit";
      entry = validator "scripts/validate/commit-msg.sh";
      stages = [ "commit-msg" ];
      pass_filenames = true;
      language = "system";
    };

    a-git-hooks-worktree = {
      enable = true;
      name = "Worktree commit linting";
      entry = hook-proof "${gitHooks.launchers} ${packages.pre-commit}";
      files = "^(flake\\.nix|nix/git-hooks\\.nix|nix/git-hooks/.*)$";
      pass_filenames = false;
      language = "system";
    };

    a-shellcheck = {
      enable = true;
      name = "Shellcheck";
      entry = "${packages.shellcheck}/bin/shellcheck";
      files = "(.*\\.sh|^scripts/host/ferretry-loopback-firewall)$";
      pass_filenames = true;
      language = "system";
    };

    a-biome = {
      enable = true;
      name = "Biome lint";
      entry = bun-tool "biome lint --no-errors-on-unmatched";
      files = "(^biome\\.json$|\\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$)";
      pass_filenames = true;
      language = "system";
    };

    a-deadcode = {
      enable = true;
      name = "Knip repository dead code";
      entry = bun-tool "knip --config knip.json";
      files = "((^|/)package\\.json$|(^|/)tsconfig\\.json$|^knip\\.json$|\\.(ts|tsx)$)";
      pass_filenames = false;
      language = "system";
    };

    a-deadcode-production = {
      enable = true;
      name = "Knip production dead code";
      entry = bun-tool "knip --config knip.production.json";
      files = "((^|/)package\\.json$|(^|/)tsconfig\\.json$|^knip\\.production\\.json$|\\.(ts|tsx)$)";
      pass_filenames = false;
      language = "system";
    };

    typecheck = {
      enable = true;
      name = "TypeScript typecheck";
      entry = bun-script "scripts/validate/typecheck.sh";
      files = "((^|/)package\\.json$|(^|/)tsconfig\\.json$|\\.(ts|tsx|mts|cts)$)";
      pass_filenames = false;
      language = "system";
    };

  };
}
