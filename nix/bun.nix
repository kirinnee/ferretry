{ pkgs }:
/*
  Bun 1.4.4, ahead of the 1.3.13 this flake's nixpkgs pins. Bun 1.3.13 and 1.3.14 segfault when a
  Worker is terminated while it is still transpiling its modules (`SavedSourceMap.putValue` on the
  transpiler thread pool, measured in #777); 1.4.0, 1.4.2 and 1.4.4 do not.

  This is nixpkgs' own recipe with only the version and its three release archives replaced: it reads
  `src` from `passthru.sources` through `finalAttrs`, so the override builds exactly what nixpkgs would
  at 1.4.4 — a download and a patchelf, nothing compiled. That is still one derivation cache.nixos.org
  does not hold, which is why it is a leaf here and not an overlay on `pkgs`: nothing else in the
  closure changes hash (see flake.nix). The archives are the ones the stock recipe names, checked
  against the release's SHASUMS256.txt.

  The one owner of the Bun version: the dev shells take it through nix/packages.nix, and the flake's
  own fy and fyd builds (nix/ferretry.nix) are compiled with it. Delete this file, and take `bun` from
  `inherit (pkgs)` again, once flake.lock's nixpkgs carries 1.4.4 or later.
*/
pkgs.bun.overrideAttrs (
  finalAttrs: previousAttrs: {
    version = "1.4.4";
    # The recipe already reads this from `sources` below; naming it is what tells nixpkgs' "version
    # overridden but not src" check that the archive changed with the version.
    src =
      finalAttrs.passthru.sources.${pkgs.stdenvNoCC.hostPlatform.system}
        or (throw "nix/bun.nix pins no Bun archive for ${pkgs.stdenvNoCC.hostPlatform.system}");
    passthru = previousAttrs.passthru // {
      sources = {
        "aarch64-darwin" = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-darwin-aarch64.zip";
          hash = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
        };
        "aarch64-linux" = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
          hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
        };
        "x86_64-linux" = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64.zip";
          hash = "sha256-v4zL+ysLgBWeD5ptFcVTF63YB3U028YTCj7bUvzLOVw=";
        };
      };
    };
  }
)
