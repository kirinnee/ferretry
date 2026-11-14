import {
  type RuntimeSkillAssets,
  SkillFolderChanged,
  type SkillFilesReading,
  type SkillFolderReading,
} from '@ferretry/plugin-catalogs/contract';
import type { SkillStore } from '../lib/skill-store.ts';
import { sha256Hex } from './sha256.ts';
import { SKILL_FILE_MAX_BYTES, SKILL_MAX_BYTES } from './skill-bounds.ts';

/**
 * The skills a catalog installed into this machine's runtimes, as the installer reads and prunes them: Skills' own
 * `installed/<name>/` tree (today's `<fleet>/assets/skills/<name>/`). It sees the paths the store wrote and nothing
 * else, so what a person put there by hand is neither listed nor removed. The installer writes through
 * `installCatalogItem`; this only reads, and deletes the exact files it is handed, each only while it still has the
 * hash the person's review showed.
 */
export class InstalledSkillAssets implements RuntimeSkillAssets {
  constructor(private readonly store: Pick<SkillStore, 'holds' | 'paths' | 'read' | 'removePaths'>) {}

  async inspect(name: string): Promise<SkillFolderReading> {
    const exists = await this.store.holds(name);
    if (!exists) return { exists: false, files: new Map() };
    return { exists: true, files: await this.#hashes(name) };
  }

  async read(name: string, paths: readonly string[]): Promise<SkillFilesReading> {
    const files = new Map<string, string>();
    const tooLarge: string[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    for (const path of new Set(paths)) {
      const bytes = await this.store.read(name, path);
      if (bytes === undefined) continue;
      if (bytes.byteLength > SKILL_FILE_MAX_BYTES || total + bytes.byteLength > SKILL_MAX_BYTES) {
        tooLarge.push(path);
        continue;
      }
      total += bytes.byteLength;
      try {
        files.set(path, decoder.decode(bytes));
      } catch {
        tooLarge.push(path);
      }
    }
    return { files, tooLarge };
  }

  async remove(name: string, expected: ReadonlyMap<string, string | null>): Promise<void> {
    const now = await this.#hashes(name);
    for (const [path, hash] of expected) if ((now.get(path) ?? null) !== hash) throw new SkillFolderChanged();
    await this.store.removePaths(name, [...expected.keys()]);
  }

  async #hashes(name: string): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const path of await this.store.paths(name)) {
      const bytes = await this.store.read(name, path);
      if (bytes !== undefined) hashes.set(path, await sha256Hex(bytes));
    }
    return hashes;
  }
}
