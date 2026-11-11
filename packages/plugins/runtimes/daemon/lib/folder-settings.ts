/**
 * What a folder's own Claude settings may not do to a runtime's login (B190).
 *
 * A login's NON-secret variables are pinned in the runtime's `--settings` overlay, which beats the
 * repository's `.claude/settings*.json`. A variable bound to the secret store cannot be: it never goes in a
 * settings file or on a command line (docs/secrets.md), so it is process environment only, and a repository
 * that sets that same variable under `env` replaces it. The runtime would then start signed out, and a ferret
 * would sit on "Not logged in" with nothing on this machine to point at.
 *
 * So the start is refused, naming the file and the variable. Pure but for the injected reader.
 */

/** The settings files Claude Code reads from a project folder, shared first. */
const PROJECT_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'] as const;

/** Raised when a folder's settings would override a secret-backed variable of the runtime's login. */
export class FolderSettingsOverrideError extends Error {
  constructor(
    readonly runtime: string,
    readonly file: string,
    readonly variables: readonly string[],
  ) {
    super(
      `this folder's ${file} sets ${variables.join(', ')}, which overrides runtime ${runtime}'s login, so it would start signed out. Remove it there, or keep that key out of the secret store.`,
    );
    this.name = 'FolderSettingsOverrideError';
  }
}

/** The names under `env` in one settings file's text; nothing for text that is not a settings object. */
function envNames(text: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const env = (parsed as { readonly env?: unknown }).env;
  return typeof env === 'object' && env !== null && !Array.isArray(env) ? Object.keys(env) : [];
}

/**
 * Throws {@link FolderSettingsOverrideError} when any of `folders` (the launch folder, and the git root when it
 * differs) holds a Claude settings file that sets one of `secretEnvNames`. A file that is missing or does not
 * parse is Claude Code's to complain about, not a reason to refuse here.
 */
export async function assertFolderLeavesLoginAlone(input: {
  readonly runtime: string;
  /** The variables of the runtime's login that name a secret (the manifest's `secretEnv` keys). */
  readonly secretEnvNames: readonly string[];
  readonly folders: readonly string[];
  readonly read: (path: string) => Promise<string | undefined>;
}): Promise<void> {
  if (input.secretEnvNames.length === 0) return;
  for (const folder of input.folders) {
    for (const relative of PROJECT_SETTINGS) {
      const file = `${folder.replace(/\/+$/u, '')}/${relative}`;
      const text = await input.read(file);
      if (text === undefined) continue;
      const hit = envNames(text).filter(name => input.secretEnvNames.includes(name));
      if (hit.length > 0) throw new FolderSettingsOverrideError(input.runtime, file, hit);
    }
  }
}
