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
 * THE SWITCH: whether the preview converts Codex runtimes. OFF, because 5.0 does not apply Codex settings items yet,
 * so a Codex preview ferret's login shell would carry FY_HOME but no FY_PORT/FY_URL and reach v4's `fy` (owner hard
 * rule 4: never write a v4 path). Turn it on only when the Runtimes compose unit applies Codex settings items. While it
 * is off the converter writes no Codex runtime, no profile only Codex runtimes use, and no Codex settings item.
 */
export const PREVIEW_CODEX_RUNTIMES: boolean = false;

/** The one sentence that says why a Codex runtime is held; plan.ts GAPS and the driver's dry run use these words. */
export const CODEX_HELD_SENTENCE =
  "held: a Codex ferret's login shell would find v4's fy (FY_HOME is the preview home, no FY_PORT/FY_URL) and v4's `fy daemon stop|restart|update` writes v4 lifecycle files before any ownership check; it is added once 5.0 applies Codex settings items";

/**
 * The shell environment for every preview ferret: the guard, and the preview's home and address (the shim pins them
 * too). It has no PATH: a settings environment is literal, so a PATH here would replace the ferret's own. Only `fy5`
 * puts the preview's `bin` first (the shim leaves PATH alone), and a ferret inherits that PATH from the daemon; the
 * guard is what keeps a login shell from putting it behind v4's.
 */
export function previewShellEnv(home: string, port: number): Readonly<Record<string, string>> {
  return Object.freeze({
    ...SHELL_GUARD_ENV,
    FY_HOME: home,
    FY_PORT: String(port),
    FY_URL: `http://127.0.0.1:${port}`,
  });
}
