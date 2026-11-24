/**
 * Where Claude Code and Codex are looked for AFTER the daemon's own `PATH` found nothing: the folders their installers
 * write to, which a daemon whose `PATH` was captured before the install (a systemd or launchd definition) never sees.
 *
 * ONE list, owned here, used by every lookup that answers "is Claude / Codex on this machine": the setup scan (Runtimes),
 * and the Claude Code and Codex update views the onboarding "Check again" reads. A second list would let the pages
 * disagree about the same machine.
 *
 * Order and precedence: the config's `binary` override first, then the config's search directories, then the daemon's
 * `PATH` (all unchanged), then these, in this order. Only the two harness commands are looked up here; no other command
 * ever searches these folders (the daemon names them: `harness-lookup.ts`).
 */

/** What the list depends on. All plain facts the caller already holds; nothing is read from the disk here. */
export interface HarnessFallbackFacts {
  /** The person's home folder; empty or relative: the folders under it are left out. */
  readonly home: string;
  /** `uname -s`, lower-cased. `darwin` adds Homebrew's Apple-silicon folder. */
  readonly platform: string;
  /** `XDG_STATE_HOME` as the person's environment has it; unset, empty or relative: `~/.local/state`. */
  readonly xdgStateHome?: string | undefined;
}

const under = (folder: string, relative: string): string => `${folder.replace(/\/+$/u, '')}/${relative}`;

/** The folders to search after `PATH`, in order, each once. Bounded: at most seven. */
export function harnessFallbackDirectories(facts: HarnessFallbackFacts): readonly string[] {
  const home = facts.home.startsWith('/') ? facts.home : '';
  const xdg = facts.xdgStateHome?.trim() ?? '';
  const stateHome = xdg.startsWith('/') ? xdg : home === '' ? '' : under(home, '.local/state');
  const directories = [
    ...(home === '' ? [] : [under(home, '.local/bin'), under(home, '.npm-global/bin'), under(home, '.bun/bin')]),
    ...(home === '' ? [] : [under(home, '.nix-profile/bin')]),
    ...(stateHome === '' ? [] : [under(stateHome, 'nix/profile/bin')]),
    '/usr/local/bin',
    ...(facts.platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
  ];
  return [...new Set(directories)];
}
