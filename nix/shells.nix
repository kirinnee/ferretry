{
  pkgs,
  packages,
  env,
  shellHook,
}:
with env;
let
  # A real fonts configuration for the browser tests. Chrome (the visual and browser tiers) finds fonts through
  # fontconfig, and a shell on a host with none (a minimal image, a nix-only box) hands it an empty font set: text
  # draws as blanks, and every measurement of a label's width is wrong. One flake-locked DejaVu on every Linux shell
  # makes it one font set; macOS has system fonts, so it gets nothing.
  #
  # The file is written here, not made by `pkgs.makeFontsConf`: that one also reads `/etc/fonts/conf.d`, `~/.nix-profile`,
  # the XDG font directories and the host's `/usr/share/fonts`, so a font planted on the machine changed what the tests
  # measured. This one names ONE font root (the DejaVu store path), has no `<include>`, no home or XDG directory and no
  # host directory, and the generic families are aliased to DejaVu so they never fall through to something else.
  # scripts/validate/fonts-config.ts fails when any of that stops being true.
  fontsConf = pkgs.writeText "fonts.conf" ''
    <?xml version="1.0"?>
    <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
    <fontconfig>
      <dir>${pkgs.dejavu_fonts}</dir>
      <alias binding="same"><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
      <alias binding="same"><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
      <alias binding="same"><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
    </fontconfig>
  '';
  fonts = pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
    FONTCONFIG_FILE = fontsConf;
  };
  # `fc-list` rides along on Linux so the guard can ask fontconfig what it really resolves under this file.
  fontTools = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.fontconfig ];
  shell = attrs: pkgs.mkShell (attrs // fonts // { buildInputs = attrs.buildInputs ++ fontTools; });
in
{
  ci = shell {
    buildInputs = lint ++ main;
    inherit shellHook;
  };

  # `ci` with tmux 3.8 in place of the pinned tmux: the realworld workflow's 3.8 leg (nix/env.nix).
  ci-tmux38 = shell {
    buildInputs = lint ++ builtins.filter (input: input != packages.tmux) main ++ [ packages.tmux_3_8 ];
    inherit shellHook;
  };

  default = shell {
    buildInputs = main ++ lint ++ dev ++ releaser;
    inherit shellHook;
  };

  releaser = shell {
    buildInputs = lint ++ main ++ releaser;
    inherit shellHook;
  };
}
