{
  pkgs,
  lib,
  # nix/bun.nix: the same pinned Bun the dev shells run, never `pkgs.bun`.
  bun,
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
    version = "0.109.0";
    inherit src;

    nativeBuildInputs = [ bun ];
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-U28VhuWoxrbYeoQi99vwckRx+OuQhzjz48r3oKUEOx0=";
    dontFixup = true;

    buildPhase = ''
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      # Every shipped platform's optional prebuilds, not only this builder's: the daemon's WebRTC engine is a
      # native addon per platform, and installing only the host's would make this output differ between a
      # Linux and a macOS builder — a fixed-output derivation with one hash cannot.
      bun install --frozen-lockfile --os=linux --os=darwin --cpu=x64 --cpu=arm64 --filter=fy --filter=@ferretry/daemon
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

  # One derivation per shipped package, compiling EVERY executable it ships into the same bin/: the
  # daemon runs its browser worker from beside its own resolved path, so a worker in a different
  # store path would be invisible to it. Every executable goes through the release compile script so
  # the flake and the archives apply the same build-time fixes.
  mkBinary =
    {
      pname,
      executables,
      postInstall ? "",
    }:
    pkgs.stdenvNoCC.mkDerivation {
      inherit pname src postInstall;
      version = releaseVersion;
      nativeBuildInputs = [
        bun
        pkgs.makeWrapper
      ];

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
        ${lib.concatMapStringsSep "\n" (
          executable:
          "bun scripts/release/compile-executable.ts --entry ${executable.entry} --outfile ${executable.name}"
        ) executables}
      '';
      # A custom installPhase runs no hooks of its own, so `postInstall` (fyd's cloudflared wrapper) is
      # run here explicitly.
      installPhase = ''
        runHook preInstall
        ${lib.concatMapStringsSep "\n" (
          executable: "install -Dm755 ${executable.name} \"$out/bin/${executable.name}\""
        ) executables}
        runHook postInstall
      '';
    };

  fy = mkBinary {
    pname = "fy";
    executables = [
      {
        name = "fy";
        entry = "packages/cli/bin/fy.ts";
      }
    ];
  };
  fyd = mkBinary {
    pname = "fyd";
    # The hosted tunnel carrier runs `cloudflared` (docs/relay-protocol.md §15). It is a DEPENDENCY,
    # never a download: this package names the store's own binary through FY_CLOUDFLARED, which the
    # daemon reads before searching PATH. `--set-default` keeps an operator's own FY_CLOUDFLARED
    # winning, and naming the binary rather than prefixing PATH keeps it off every agent's PATH.
    postInstall = ''
      wrapProgram "$out/bin/fyd" --set-default FY_CLOUDFLARED ${lib.getExe pkgs.cloudflared}
    '';
    executables = [
      {
        name = "fyd";
        entry = "packages/daemon/bin/fyd.ts";
      }
      {
        name = "fyd-browser-worker";
        entry = "packages/daemon/bin/browser-worker.ts";
      }
    ];
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
