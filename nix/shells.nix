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
  fonts = pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
    FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
  };
  shell = attrs: pkgs.mkShell (attrs // fonts);
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
