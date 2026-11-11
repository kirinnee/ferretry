import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FolderSettingsVariables } from '../../lib/fleet/launch-environment.ts';

/** The two project files Claude Code reads from a folder, in the order it ranks them (local wins). */
const PROJECT_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;

/**
 * The names a folder's Claude settings files put in their `env`.
 *
 * Reads the launch folder's own files only. A file that is absent, unreadable or not a JSON object
 * contributes nothing: Claude ignores a settings file it cannot parse, and a start is not refused
 * over a file that has no effect. Values are dropped here, so nothing above this adapter can hold one.
 */
export class FolderClaudeSettingsFiles implements FolderSettingsVariables {
  async variables(cwd: string): Promise<readonly { readonly file: string; readonly names: readonly string[] }[]> {
    const found: { file: string; names: string[] }[] = [];
    for (const file of PROJECT_SETTINGS_FILES) {
      const text = await readFile(join(cwd, file), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const env = (parsed as { env?: unknown } | null)?.env;
      if (typeof env !== 'object' || env === null || Array.isArray(env)) continue;
      found.push({ file, names: Object.keys(env) });
    }
    return found;
  }
}
