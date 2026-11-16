import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { SkillDirectoryEntry, SkillFilesPort } from '../lib/inventory.ts';

const SKILL_FILE = 'SKILL.md';

/**
 * Skill folders and SKILL.md reads through a kernel root handle. The handle resolves links before every read and
 * refuses one that leaves the root (`link_escape`), so a folder swapped for a link elsewhere is neither listed nor
 * read; `confinedTo` is the handle's own root. A refusal or a missing folder is an empty listing, as before.
 */
export class RootSkillFiles implements SkillFilesPort {
  /** `base` is the folder the handle is rooted at: paths in and out are absolute, the handle is asked relative ones. */
  constructor(
    private readonly root: RootHandle,
    private readonly base: string,
  ) {}

  async list(directory: string, limit: number): Promise<readonly SkillDirectoryEntry[]> {
    const listed = await this.#fenced(directory);
    if (listed === undefined) return [];
    const names = await this.root.list(listed).catch(() => [] as readonly string[]);
    const found: SkillDirectoryEntry[] = [];
    for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
      if (found.length > limit) break;
      if (name.startsWith('.')) continue;
      const folder = await this.#fenced(`${directory}/${name}`);
      if (folder === undefined || (await this.root.stat(folder).catch(() => undefined))?.kind !== 'directory') continue;
      const manifest = await this.#fenced(`${directory}/${name}/${SKILL_FILE}`);
      if (manifest === undefined || (await this.root.stat(manifest).catch(() => undefined))?.kind !== 'file') continue;
      found.push({ manifest: `${directory}/${name}/${SKILL_FILE}` });
    }
    return found;
  }

  async read(path: string, maxBytes: number): Promise<string | undefined> {
    const fenced = await this.#fenced(path);
    if (fenced === undefined) return undefined;
    const stat = await this.root.stat(fenced).catch(() => undefined);
    if (stat === undefined || stat.kind !== 'file' || stat.size > maxBytes) return undefined;
    return await this.root.readText(fenced, maxBytes).catch(() => undefined);
  }

  async #fenced(path: string): Promise<FencedPath | undefined> {
    const base = this.base.replace(/\/+$/u, '');
    if (path !== base && !path.startsWith(`${base}/`)) return undefined;
    const resolved = this.root.resolve(path.slice(base.length).replace(/^\//u, ''));
    return resolved.ok ? resolved.value : undefined;
  }
}
