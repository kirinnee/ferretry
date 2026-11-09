/**
 * What a preview ferret's shells are told so that a LOGIN or interactive shell started inside it still finds the
 * preview's own `fy` and not v4's. One owner: the converter writes it into the preview's harness settings, and the
 * preview's start check (`preview/start-checks.ts`) probes with exactly this environment.
 *
 * Why: this box's `/etc/profile.d/nix.sh` (and `/etc/zsh/zshrc`) put the nix profile, where v4's `fy` lives, ahead of
 * whatever PATH a shell started with. Their guard variable is `__ETC_PROFILE_NIX_SOURCED`: with it set they do nothing.
 */

/** Variables that stop this box's login and interactive shells re-prepending the nix profile. */
export const SHELL_GUARD_ENV: Readonly<Record<string, string>> = Object.freeze({
  __ETC_PROFILE_NIX_SOURCED: '1',
});

/**
 * The preview's settings item that carries the environment below, one per harness: `config/claude-code/settings/<name>.yaml`
 * (`settings.env`) and `config/codex/settings/<name>.yaml` (`settings.shell_environment_policy.set`).
 */
export const PREVIEW_SETTINGS_ITEM = 'fy-preview';

/**
 * The shell environment for every preview ferret: the guard, and the preview's home and address (the shim pins them
 * too). It has no PATH: a settings environment is literal, so a PATH here would replace the ferret's own; `fy5` and the
 * shim put the preview's `bin` first themselves, and the guard is what keeps a login shell from putting it behind v4's.
 */
export function previewShellEnv(home: string, port: number): Readonly<Record<string, string>> {
  return Object.freeze({
    ...SHELL_GUARD_ENV,
    FY_HOME: home,
    FY_PORT: String(port),
    FY_URL: `http://127.0.0.1:${port}`,
  });
}
