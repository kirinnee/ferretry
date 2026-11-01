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

  # The only files `bun install` reads: the lockfile and the workspace manifests. The dependency
  # derivation is built from exactly these, so nothing outside them can move its output unseen.
  isInstallInput =
    path: type:
    let
      relative = lib.removePrefix "${toString src}/" (toString path);
    in
    builtins.elem relative [
      "bun.lock"
      "package.json"
      "packages"
    ]
    || (type == "directory" && builtins.match "packages/[^/]+" relative != null)
    || builtins.match "packages/[^/]+/package.json" relative != null;
  installInputs = builtins.path {
    name = "ferretry-bun-install-inputs";
    path = src;
    filter = isInstallInput;
  };

  bunInstall = "bun install --frozen-lockfile --production --ignore-scripts --os=linux --os=darwin --cpu=x64 --cpu=arm64 --filter=fy --filter=@ferretry/daemon";

  # A fixed-output derivation's store path is its name and its outputHash, nothing else, so a store
  # that already holds that path never re-runs `bun install` — not when the lockfile moves, not when
  # Bun does. A stale outputHash then passed on every warm Namespace cache volume and failed only on a
  # cold one (#1244 added a dependency and kept the old hash). The name therefore carries a digest of
  # every install input: change one and no store can hold the new path, so the very next build re-runs
  # the install and a stale hash fails on that PR, every time. `version` is dropped from each manifest
  # first, because the release commit restamps it and it never reaches node_modules.
  installDigest = builtins.hashString "sha256" (
    builtins.toJSON {
      bun = bun.version;
      command = bunInstall;
      lockfile = builtins.readFile "${src}/bun.lock";
      manifests = map (manifest: removeAttrs (lib.importJSON "${src}/${manifest}") [ "version" ]) (
        [ "package.json" ]
        ++ map (package: "packages/${package}/package.json") (
          builtins.filter (package: builtins.pathExists "${src}/packages/${package}/package.json") (
            builtins.attrNames (
              lib.filterAttrs (_: type: type == "directory") (builtins.readDir "${src}/packages")
            )
          )
        )
      );
    }
  );

  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "ferretry-bun-deps";
    # Part of the store path, so it is what makes a changed input a cache miss (see installDigest).
    version = builtins.substring 0 16 installDigest;
    src = installInputs;

    nativeBuildInputs = [ bun ];
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    # When a build reports a hash mismatch here, the install inputs changed what it installs: take the
    # `got:` hash. It is the same on every builder, so a mismatch is never fixed by rerunning.
    outputHash = "sha256-wQ1WrkiBZdJSa411EFNY7b9Vw30AxW8N0NvTY5lRtPs=";
    dontFixup = true;

    buildPhase = ''
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      # Every shipped platform's optional prebuilds, not only this builder's: the daemon's WebRTC engine is a
      # native addon per platform, and installing only the host's would make this output differ between a
      # Linux and a macOS builder — a fixed-output derivation with one hash cannot. Those prebuilds arrive as
      # optional packages, so no lifecycle script is needed, and the shipped binaries need no devDependency.
      ${bunInstall}
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
