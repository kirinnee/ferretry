/**
 * The configuration directory as `fy config` reads it, with no daemon: every config file under
 * `<state home>/config`, and the daemon's accepted record, read only.
 *
 * NEVER FOLLOWS A LINK, for the reason the daemon does not: a link in the config directory could point
 * a reader at any file this user can read. A link — or a file too large to be configuration — is named
 * as unreadable instead, exactly as the daemon reports it.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AcceptedConfigFiles, AcceptedConfigFilesSchema, type ConfigFileText } from '@ferretry/fleet';
import { CONFIG_ACCEPTED_FILE, CONFIG_FILE_MAX_BYTES } from '@ferretry/protocol';
import type { IConfigFiles } from '../../lib/config/ports.ts';

/** How deep the layout goes: `components/<kind>/<name>.yaml`. */
const MAX_DEPTH = 3;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

export class FileConfigFiles implements IConfigFiles {
  constructor(
    readonly directory: string,
    private readonly stateDirectory: string,
  ) {}

  async list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }> {
    const files: ConfigFileText[] = [];
    const unreadable: string[] = [];
    const visit = async (relative: string, depth: number): Promise<void> => {
      let entries: string[];
      try {
        entries = await readdir(relative === '' ? this.directory : join(this.directory, relative));
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      for (const name of entries.toSorted()) {
        // A hidden entry is an editor's swap file or the schema directory, never a config file.
        if (name.startsWith('.')) continue;
        const path = relative === '' ? name : `${relative}/${name}`;
        const information = await lstat(join(this.directory, path));
        if (information.isDirectory()) {
          if (depth < MAX_DEPTH) await visit(path, depth + 1);
          continue;
        }
        // A link is never followed, whatever its name — a linked `logins/` directory included.
        if (information.isSymbolicLink()) {
          unreadable.push(path);
          continue;
        }
        if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
        if (!information.isFile() || information.size > CONFIG_FILE_MAX_BYTES) {
          unreadable.push(path);
          continue;
        }
        files.push({ path, text: await readFile(join(this.directory, path), 'utf8') });
      }
    };
    await visit('', 1);
    return { files, unreadable };
  }

  /** The daemon's record; empty when there is none, or when it does not parse — the stricter reading. */
  async accepted(): Promise<AcceptedConfigFiles> {
    let text: string;
    try {
      text = await readFile(join(this.stateDirectory, CONFIG_ACCEPTED_FILE), 'utf8');
    } catch (error) {
      if (missing(error)) return {};
      throw error;
    }
    try {
      const parsed = AcceptedConfigFilesSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }
}
