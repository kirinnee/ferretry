{
  pkgs,
  packages,
  env,
  shellHook,
}:
with env;
{
  ci = pkgs.mkShell {
    buildInputs = lint ++ main;
    inherit shellHook;
  };

  # `ci` with tmux 3.8 in place of the pinned tmux: the realworld workflow's 3.8 leg (nix/env.nix).
  ci-tmux38 = pkgs.mkShell {
    buildInputs = lint ++ builtins.filter (input: input != packages.tmux) main ++ [ packages.tmux_3_8 ];
    inherit shellHook;
  };

  default = pkgs.mkShell {
    buildInputs = main ++ lint ++ dev ++ releaser;
    inherit shellHook;
  };

  releaser = pkgs.mkShell {
    buildInputs = lint ++ main ++ releaser;
    inherit shellHook;
  };
}
