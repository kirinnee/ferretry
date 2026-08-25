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
    # This fixed-output derivation's name is part of its cache identity. Keep it paired with the
    # pinned outputHash; release-facing fy/fyd metadata derives from VERSION below.
    version = "0.107.0";
    inherit src;

    nativeBuildInputs = [ pkgs.bun ];
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-dnexLakLHvEhEw1n2yCePx9T0O+JIdKfR8ZkEd+ggz0=";
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

      # Bun records the filtered workspace graph under each package. Preserve those relative links
      # alongside its content-addressed store; mkBinary relocates them back into the source tree.
      foundWorkspaceModules=
      for packageModules in packages/*/node_modules; do
        [ -d "$packageModules" ] || continue
        packageDir="$(dirname "$packageModules")"
        mkdir -p "$out/$packageDir"
        cp -R "$packageModules" "$out/$packageDir/node_modules"
        foundWorkspaceModules=1
      done
      [ -n "$foundWorkspaceModules" ] || {
        echo "filtered Bun install produced no package-scoped node_modules trees" >&2
        exit 1
      }
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
      nativeBuildInputs = [ pkgs.bun ];

      buildPhase = ''
        # Restore Bun's own filtered install tree instead of flattening package dependencies into a
        # hand-maintained root list. Its relative workspace links preserve declared boundaries and
        # already include transitive edges such as daemon -> relay -> protocol.
        cp -R ${bunDeps}/node_modules node_modules
        foundWorkspaceModules=
        for packageModules in ${bunDeps}/packages/*/node_modules; do
          [ -d "$packageModules" ] || continue
          packageName="$(basename "$(dirname "$packageModules")")"
          cp -R "$packageModules" "packages/$packageName/node_modules"
          foundWorkspaceModules=1
        done
        [ -n "$foundWorkspaceModules" ] || {
          echo "cached Bun dependencies contain no package-scoped node_modules trees" >&2
          exit 1
        }
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
