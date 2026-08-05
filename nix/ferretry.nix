{
  pkgs,
  lib,
  src,
}:
let
  # VERSION already stamps both shipped manifests and is pinned by cli-contracts' released-version
  # check, so derivation metadata can follow the same release source instead of going stale silently.
  releaseVersion = lib.removeSuffix "\n" (builtins.readFile "${src}/VERSION");

  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "ferretry-bun-deps";
    version = releaseVersion;
    inherit src;

    nativeBuildInputs = [ pkgs.bun ];
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-qCWGenWSkwSI1S0ZyRcQ6SWoPYpJuz8S4zLKfHaaEaw=";
    dontFixup = true;

    buildPhase = ''
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      bun install --frozen-lockfile --filter=fy --filter=@ferretry/daemon
    '';
    installPhase = ''
      mkdir -p "$out"
      cp -R node_modules "$out/node_modules"
      rm -rf "$out/node_modules/@ferretry"
    '';
  };

  mkBinary =
    {
      pname,
      entry,
    }:
    pkgs.stdenvNoCC.mkDerivation {
      inherit pname src;
      version = releaseVersion;
      nativeBuildInputs = [
        pkgs.bun
        pkgs.jq
      ];

      buildPhase = ''
        mkdir node_modules
        ln -s ${bunDeps}/node_modules/.bun/chalk@5.6.2/node_modules/chalk node_modules/chalk
        ln -s ${bunDeps}/node_modules/.bun/commander@15.0.0/node_modules/commander node_modules/commander
        ln -s ${bunDeps}/node_modules/.bun/inquirer@14.0.2+7cb241fc07b679d9/node_modules/inquirer node_modules/inquirer
        ln -s ${bunDeps}/node_modules/.bun/ora@9.4.1/node_modules/ora node_modules/ora
        ln -s ${bunDeps}/node_modules/.bun/qrcode-terminal@0.12.0/node_modules/qrcode-terminal node_modules/qrcode-terminal
        ln -s ${bunDeps}/node_modules/.bun/smol-toml@1.7.1/node_modules/smol-toml node_modules/smol-toml
        ln -s ${bunDeps}/node_modules/.bun/zod@4.4.3/node_modules/zod node_modules/zod
        # Derive every scoped link from package.json's workspaces. Linking the full workspace is a
        # deliberate superset of the direct dependency list, so transitive imports cannot require a
        # second hand-maintained edit when a package or dependency edge is added.
        ./scripts/validate/nix-workspace-links.sh link node_modules
        ./scripts/validate/nix-workspace-links.sh check node_modules
        bun build ${entry} --compile --outfile ${pname}
      '';
      installPhase = ''
        install -Dm755 ${pname} "$out/bin/${pname}"
      '';
    };

  fy = mkBinary {
    pname = "fy";
    entry = "packages/cli/bin/fy.ts";
  };
  fyd = mkBinary {
    pname = "fyd";
    entry = "packages/daemon/bin/fyd.ts";
  };
in
{
  inherit fy fyd;
  default = pkgs.symlinkJoin {
    name = "ferretry";
    paths = [
      fy
      fyd
    ];
  };
}
