{ treefmt-nix, pkgs, ... }:
let
  # Code is Biome's: TypeScript, JavaScript, JSON(C) and CSS. Prettier keeps what Biome does not
  # format (Markdown, YAML, HTML). Biome formats the whole repository in ~2 s where Prettier took
  # ~40 s on 32 cores (~93 s on a CI 2x4), and its rules live in biome.json beside the linter's.
  #
  # The formatter is the workspace's own `node_modules/.bin/biome`, the same binary and version the
  # `a-biome` lint hook runs, so formatting and linting never disagree about a Biome release.
  # treefmt runs formatters from the tree root, where `bun install` (scripts/ci/setup.sh) put it.
  biomeIncludes = [
    "*.ts"
    "*.tsx"
    "*.mts"
    "*.cts"
    "*.js"
    "*.jsx"
    "*.mjs"
    "*.cjs"
    "*.json"
    "*.jsonc"
    "*.css"
  ];

  fmt = {
    projectRootFile = "flake.nix";

    programs = {
      actionlint.enable = true;
      nixfmt.enable = true;
      prettier = {
        enable = true;
        excludes = [
          "Changelog.md"
          "Changelog.old.md"
        ]
        ++ biomeIncludes;
      };
      shfmt.enable = true;
    };

    settings.formatter.biome = {
      command = "${pkgs.bash}/bin/bash";
      options = [
        "-c"
        "exec ./node_modules/.bin/biome format --write --no-errors-on-unmatched \"$@\""
        "--"
      ];
      includes = biomeIncludes;
    };
  };
in
(treefmt-nix.lib.evalModule pkgs fmt).config.build.wrapper
