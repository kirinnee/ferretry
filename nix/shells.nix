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

  default = pkgs.mkShell {
    buildInputs = main ++ lint ++ dev ++ releaser;
    inherit shellHook;
  };

  releaser = pkgs.mkShell {
    buildInputs = lint ++ main ++ releaser;
    inherit shellHook;
  };
}
