import { basename, dirname } from 'node:path';
import type { StatePort } from '@ferretry/kernel/contract';
import { SKILLS_INSTALLED_STATE } from '../../contract/index.ts';
import type { SkillDirectoryEntry } from '../lib/inventory.ts';
import { usableSkillName } from '../lib/skill-store.ts';

const SKILL_FILE = 'SKILL.md';

/**
 * Skills' own installed store (`state/skills/installed/<folder>/`), read through its own state port: the skill items a
 * runtime's profile selects, as the inventory lists them, and the SKILL.md of one of them. Nothing outside the store is
 * reachable: a path is served only when it is exactly the path the port gives for `<folder>/SKILL.md`, and the entry
 * under it is a regular file (a link or a folder is never read).
 */
export class InstalledSkillFiles {
  constructor(private readonly state: Pick<StatePort, 'read' | 'stat' | 'pathOf'>) {}

  /** The path of an installed skill's SKILL.md, as the inventory lists it and the file route serves it. */
  manifestPath(folder: string): string {
    return this.state.pathOf(SKILLS_INSTALLED_STATE, `${folder}/${SKILL_FILE}`);
  }

  /** The folders among `folders` the store holds with a regular SKILL.md, in the order given. */
  async entries(folders: readonly string[]): Promise<readonly SkillDirectoryEntry[]> {
    const held: SkillDirectoryEntry[] = [];
    for (const folder of folders) {
      if (!usableSkillName(folder)) continue;
      const found = await this.state.stat(SKILLS_INSTALLED_STATE, `${folder}/${SKILL_FILE}`).catch(() => undefined);
      if (found?.kind === 'file') held.push({ manifest: this.manifestPath(folder), managed: true });
    }
    return held;
  }

  /** Whether `path` is shaped as one installed skill's SKILL.md (the router sends only such a path here). */
  claims(path: string): boolean {
    if (basename(path) !== SKILL_FILE) return false;
    const folder = basename(dirname(path));
    return usableSkillName(folder) && path === this.manifestPath(folder);
  }

  async read(path: string, maxBytes: number): Promise<string | undefined> {
    if (!this.claims(path)) return undefined;
    const name = `${basename(dirname(path))}/${SKILL_FILE}`;
    const found = await this.state.stat(SKILLS_INSTALLED_STATE, name).catch(() => undefined);
    if (found?.kind !== 'file') return undefined;
    const read = await this.state.read(SKILLS_INSTALLED_STATE, name).catch(() => undefined);
    if (read === undefined || !read.ok || read.value === undefined) return undefined;
    const text = typeof read.value === 'string' ? read.value : new TextDecoder().decode(read.value as Uint8Array);
    return new TextEncoder().encode(text).byteLength > maxBytes ? undefined : text;
  }
}
