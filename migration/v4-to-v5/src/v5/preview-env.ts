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

/** The preview's harness settings item that carries the environment below (`config/claude-code/settings/<name>.yaml`). */
export const PREVIEW_SETTINGS_ITEM = 'fy-preview';

/** The settings `env` for every preview ferret: the guard, and the preview's home and address (the shim pins them too). */
export function previewShellEnv(home: string, port: number): Readonly<Record<string, string>> {
  return Object.freeze({
    ...SHELL_GUARD_ENV,
    FY_HOME: home,
    FY_PORT: String(port),
    FY_URL: `http://127.0.0.1:${port}`,
  });
}
