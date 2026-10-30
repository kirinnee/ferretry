/**
 * The configuration directory and the accepted record, over the state home's own filesystem port
 * (docs/config-files.md).
 *
 * THROUGH THE STATE FILESYSTEM, NOT AROUND IT. That port refuses a symbolic link anywhere inside the
 * state home and writes atomically, owner-only. Both matter more here than anywhere: `GET
 * /v1/config/file` returns a file's text to a caller off this machine, so a link planted in the config
 * directory — `logins/x.yaml → ~/.ssh/id_ed25519` — would otherwise read any file this user can. A link
 * is listed as unreadable instead, and its last good version stays in effect.
 */

import { join } from 'node:path';
import { type AcceptedConfigFiles, AcceptedConfigFilesSchema, type ConfigFileText } from '@ferretry/fleet';
import { CONFIG_FILE_MAX_BYTES, type ConfigSchemaId, configSchemaPath } from '@ferretry/protocol';
import type { AcceptedConfigStore, ConfigDirectoryPort } from '../../lib/config-files/index.ts';
import type { FileSystemPort } from '../../lib/ports.ts';

/** How deep the layout goes: `components/<kind>/<name>.yaml`. Anything deeper is not a config file. */
const MAX_DEPTH = 3;

const isConfigName = (name: string): boolean => name.endsWith('.yaml') || name.endsWith('.yml');

export class FileConfigDirectory implements ConfigDirectoryPort {
  constructor(
    readonly directory: string,
    private readonly files: FileSystemPort,
  ) {}

  /** Every config-looking path under the directory, each with whether it may be read. */
  async #walk(): Promise<readonly { readonly path: string; readonly readable: boolean }[]> {
    return (await this.#tree()).found;
  }

  /** The walk itself: the config-looking paths, and every directory it looked in, the root first. */
  async #tree(): Promise<{
    readonly found: readonly { readonly path: string; readonly readable: boolean }[];
    readonly directories: readonly string[];
  }> {
    const found: { path: string; readable: boolean }[] = [];
    const directories: string[] = [];
    const visit = async (relative: string, depth: number): Promise<void> => {
      const absolute = relative === '' ? this.directory : join(this.directory, relative);
      directories.push(absolute);
      const entries = await this.files.listDirectory(absolute);
      for (const entry of entries) {
        // A hidden entry is an editor's swap file or the schema directory (`.schema`), never a config file.
        if (entry.name.startsWith('.')) continue;
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.directory) {
          if (depth < MAX_DEPTH) await visit(path, depth + 1);
          continue;
        }
        // A link is never followed, whatever its name — a linked `logins/` directory included.
        if (isConfigName(entry.name) || entry.regularFile !== true)
          found.push({ path, readable: entry.regularFile === true });
      }
    };
    await visit('', 1);
    return { found, directories };
  }

  /** Every directory the walk reads, absolute, the root included: what the config watcher watches. */
  async directories(): Promise<readonly string[]> {
    return (await this.#tree()).directories;
  }

  async list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }> {
    const files: ConfigFileText[] = [];
    const unreadable: string[] = [];
    for (const entry of await this.#walk()) {
      const information = entry.readable ? await this.files.information(join(this.directory, entry.path)) : undefined;
      const text =
        information !== undefined && information.size <= CONFIG_FILE_MAX_BYTES
          ? await this.files.readText(join(this.directory, entry.path))
          : undefined;
      if (text === undefined) unreadable.push(entry.path);
      else files.push({ path: entry.path, text });
    }
    return { files, unreadable };
  }

  async fingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const entry of await this.#walk()) {
      // Never stat through a link: the state filesystem refuses one, and its name is all that matters.
      const information = entry.readable ? await this.files.information(join(this.directory, entry.path)) : undefined;
      parts.push(
        `${entry.path}:${String(information?.size)}:${String(information?.modifiedAtMs)}:${String(information?.inode)}`,
      );
    }
    return parts.toSorted().join('\n');
  }

  async read(path: string): Promise<string | undefined> {
    return await this.files.readText(join(this.directory, path));
  }

  async write(path: string, text: string): Promise<void> {
    await this.files.writeTextAtomic(join(this.directory, path), text);
  }

  async remove(path: string): Promise<void> {
    await this.files.removeFile(join(this.directory, path));
  }

  /** Each schema rewritten only when it changed, so a restart does not touch a file an editor has open. */
  async writeSchemas(schemas: ReadonlyMap<string, string>): Promise<void> {
    for (const [id, text] of schemas) {
      const target = join(this.directory, configSchemaPath(id as ConfigSchemaId));
      if ((await this.files.readText(target)) !== text) await this.files.writeTextAtomic(target, text);
    }
  }
}

/**
 * The accepted record, one JSON document in the state directory. A document that is missing or does
 * not parse reads as EMPTY: every file is then judged against the defaults, which holds back any
 * loosening until the owner confirms it again — the safe direction to be wrong in.
 */
export class FileAcceptedConfigStore implements AcceptedConfigStore {
  constructor(
    private readonly path: string,
    private readonly files: FileSystemPort,
  ) {}

  async read(): Promise<AcceptedConfigFiles> {
    const text = await this.files.readText(this.path);
    if (text === undefined) return {};
    try {
      const parsed = AcceptedConfigFilesSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async write(accepted: AcceptedConfigFiles): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(accepted, null, 2)}\n`);
  }
}
