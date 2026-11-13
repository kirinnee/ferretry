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

  # The workspace package directories, from the root manifest's own `workspaces` globs (`packages/*`,
  # `packages/core/*`, `packages/plugins/*`), so a new package is in the install the moment it is a workspace.
  workspaceGlobs = (lib.importJSON "${src}/package.json").workspaces;
  globDirs =
    glob:
    let
      parent = lib.removeSuffix "/*" glob;
    in
    if lib.hasSuffix "/*" glob then
      map (name: "${parent}/${name}") (
        builtins.attrNames (
          lib.filterAttrs (
            name: type: type == "directory" && builtins.pathExists "${src}/${parent}/${name}/package.json"
          ) (builtins.readDir "${src}/${parent}")
        )
      )
    else
      [ glob ];
  workspaceDirs = lib.concatMap globDirs workspaceGlobs;
  # Every directory on the way to a workspace package, which the filter below must keep to reach it.
  ancestorsOf =
    dir:
    let
      parts = lib.splitString "/" dir;
    in
    map (n: lib.concatStringsSep "/" (lib.take n parts)) (lib.range 1 (builtins.length parts));
  # Every directory a `file:` entry of the root manifest's `overrides` names (the vendored `sharp` and
  # `onnxruntime-node` stand-ins): `bun install` links those packages from the source tree, so they are
  # install inputs too, derived from the manifest rather than listed by hand.
  overrideDirs = map (lib.removePrefix "file:./") (
    lib.filter (lib.hasPrefix "file:./") (
      lib.attrValues ((lib.importJSON "${src}/package.json").overrides or { })
    )
  );
  # Every file under those directories, as a source-relative path (a store path would move the digest
  # with the commit), for the digest below.
  overrideFiles = lib.concatMap (
    dir:
    map (file: lib.removePrefix "${toString src}/" (toString file)) (
      lib.filesystem.listFilesRecursive (src + "/${dir}")
    )
  ) overrideDirs;
  installDirs = lib.unique (lib.concatMap ancestorsOf (workspaceDirs ++ overrideDirs));
  isUnderOverride =
    relative: lib.any (dir: relative == dir || lib.hasPrefix "${dir}/" relative) overrideDirs;

  # The only files `bun install` reads: the lockfile, the workspace manifests and the packages the
  # root `overrides` vendor by `file:` path. The dependency derivation is built from exactly these, so
  # nothing outside them can move its output unseen.
  isInstallInput =
    path: type:
    let
      relative = lib.removePrefix "${toString src}/" (toString path);
    in
    builtins.elem relative [
      "bun.lock"
      "package.json"
    ]
    || (type == "directory" && builtins.elem relative installDirs)
    || builtins.elem relative (map (dir: "${dir}/package.json") workspaceDirs)
    || isUnderOverride relative;
  installInputs = builtins.path {
    name = "ferretry-bun-install-inputs";
    path = src;
    filter = isInstallInput;
  };

  # Every workspace package is installed (`--filter='*'`, production dependencies only): the registry generator loads each
  # package's manifest at build time, and a manifest resolves `@ferretry/kernel` through its own package-scoped links.
  bunInstall = "bun install --frozen-lockfile --production --ignore-scripts --os=linux --os=darwin --cpu=x64 --cpu=arm64 --filter='*'";

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
        [ "package.json" ] ++ map (dir: "${dir}/package.json") workspaceDirs
      );
      # The vendored packages' bytes are install inputs, so editing one is a cache miss like any other.
      vendored = map (file: {
        inherit file;
        content = builtins.readFile "${src}/${file}";
      }) overrideFiles;
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
    outputHash = "sha256-6RfDOsXQhauNSlgjEASN5E0kTC8tew1hGXYhyQE7sGQ=";
    dontFixup = true;

    # Read by scripts/validate/bun-deps-hash.sh, which fails a change to the install inputs that did not
    # refresh `outputHash` in minutes instead of inside this build. Neither moves the store path.
    passthru = {
      inherit installDigest;
      # The digest the committed `outputHash` was taken at: nix/bun-deps.inputs, refreshed in the same
      # commit as `outputHash`.
      pinnedInstallDigest = lib.removeSuffix "\n" (builtins.readFile "${src}/nix/bun-deps.inputs");
    };

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
      for packageModules in ${lib.concatMapStringsSep " " (dir: "${dir}/node_modules") workspaceDirs}; do
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

  # One derivation per shipped package, compiling EVERY executable it ships into the same bin/: a helper
  # a package runs from beside its own resolved path would be invisible to it in a different store path. Every executable goes through the release compile script so
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
        # already include transitive edges such as fy -> kernel -> std.
        cp -R ${bunDeps}/node_modules node_modules
        foundWorkspaceModules=
        for packageDir in ${lib.concatStringsSep " " workspaceDirs}; do
          [ -d "${bunDeps}/$packageDir/node_modules" ] || continue
          cp -R "${bunDeps}/$packageDir/node_modules" "$packageDir/node_modules"
          foundWorkspaceModules=1
        done
        [ -n "$foundWorkspaceModules" ] || {
          echo "cached Bun dependencies contain no package-scoped node_modules trees" >&2
          exit 1
        }
        # The hosts import the git-ignored generated registries; the source tree has none, so generate them
        # (scripts/local/gen.sh).
        bash scripts/local/gen.sh
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
        entry = "packages/cli/${(lib.importJSON "${src}/packages/cli/package.json").bin.fy}";
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
    # The daemon host is the kernel package's (docs/rebuild/spine.md D1): its first `bin` entry. Every
    # `bin` entry of the Browsers package ships beside it: the browser worker the daemon runs from its
    # own directory (the kernel never points into a plugin, so the worker's bin is the plugin's).
    executables = [
      {
        name = "fyd";
        entry = "packages/core/kernel/${(lib.importJSON "${src}/packages/core/kernel/package.json").bin.fyd}";
      }
    ]
    ++ lib.mapAttrsToList (name: entry: {
      inherit name;
      entry = "packages/plugins/browsers/${entry}";
    }) (lib.importJSON "${src}/packages/plugins/browsers/package.json").bin;
  };
in
{
  inherit fy fyd;
  # The dependency derivation, exposed so scripts/validate/bun-deps-hash.sh can read its installDigest.
  inherit bunDeps;
  default = pkgs.symlinkJoin {
    name = "ferretry";
    paths = [
      fy
      fyd
    ];
  };
}
