import { basename, dirname } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type {
  SkillFileRead,
  SkillTreeEntry,
  SkillTreeListing,
  SkillTreePort,
  SkillWalkLimits,
} from '@ferretry/plugin-catalogs/contract';
import type { RuntimeHome, RuntimeHomeReader } from '@ferretry/plugin-runtimes/contract';

const SKILL_FILE = 'SKILL.md';
/** `<folder>/skills/<name>/SKILL.md`: a runtime home's skill, as the inventory lists it. */
const HOME_MANIFEST = /^(.+)\/skills\/([^/]+)\/SKILL\.md$/u;
/** `<registered root>/.claude/skills` or `.agents/skills`: where a project's skills are. */
const PROJECT_SKILLS = /^(.+)\/(?:\.claude|\.agents)\/skills$/u;

const withoutTrailingSlash = (path: string): string => path.replace(/(?<=.)\/+$/u, '');

export interface CatalogSkillTreeDeps {
  /** Runtimes' published homes, asked on every call. */
  readonly homes: () => Promise<readonly RuntimeHome[]>;
  /** The bounded reader of one published home. */
  readonly home: (id: string) => RuntimeHomeReader | undefined;
  /** The registered project roots. */
  readonly roots: () => Promise<readonly string[]>;
  /** The kernel's read-only `imports` root scoped to ONE skills folder of a registered project, anchored at that project. */
  readonly open: (folder: string, within: string) => RootHandle;
}

/**
 * A skill folder as a catalog publish walks it (v4's `NodeSkillFolder`), by the SKILL.md path the inventory lists: a
 * runtime home's skill through Runtimes' bounded reader, a project's through the `imports` root scoped to that one skills
 * folder. Nothing is followed: a link is listed and left alone, a file with a second name is listed and never read. A
 * path that is neither a published home's nor a registered project's reads as a folder that is gone.
 */
export class CatalogSkillTree implements SkillTreePort {
  constructor(private readonly deps: CatalogSkillTreeDeps) {}

  async list(
    manifestPath: string,
    limits: SkillWalkLimits,
    confinedTo?: string,
  ): Promise<SkillTreeListing | undefined> {
    const home = await this.#home(manifestPath);
    if (home !== undefined) return await home.reader.skillTree(home.name, limits);
    const project = await this.#project(manifestPath, confinedTo);
    if (project === undefined) return undefined;
    return await this.#walk(project.handle, project.name, limits);
  }

  async read(
    manifestPath: string,
    relativePath: string,
    maxBytes: number,
    confinedTo?: string,
  ): Promise<SkillFileRead> {
    const home = await this.#home(manifestPath);
    if (home !== undefined) return await home.reader.skillFile(home.name, relativePath, maxBytes);
    const project = await this.#project(manifestPath, confinedTo);
    if (project === undefined || relativePath.split('/').some(part => part === '' || part === '.' || part === '..'))
      return { ok: false, reason: 'unreadable' };
    try {
      const at = project.handle.resolve(`${project.name}/${relativePath}`);
      if (!at.ok) return { ok: false, reason: 'unreadable' };
      const found = await project.handle.lstat(at.value);
      if (found?.kind !== 'file' || found.links > 1) return { ok: false, reason: 'unreadable' };
      if (found.size > maxBytes) return { ok: false, reason: 'too_big' };
      return { ok: true, bytes: await project.handle.readBytes(at.value, maxBytes) };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

  async #home(manifestPath: string) {
    const match = HOME_MANIFEST.exec(manifestPath);
    if (match === null) return undefined;
    const [, folder, name] = match as unknown as [string, string, string];
    const home = (await this.deps.homes()).find(candidate => candidate.home === folder);
    const reader = home === undefined ? undefined : this.deps.home(home.id);
    return reader === undefined ? undefined : { reader, name };
  }

  async #project(manifestPath: string, confinedTo: string | undefined) {
    if (basename(manifestPath) !== SKILL_FILE) return undefined;
    const folder = dirname(dirname(manifestPath));
    const match = PROJECT_SKILLS.exec(folder);
    if (match === null) return undefined;
    const root = withoutTrailingSlash(match[1] as string);
    const known = (await this.deps.roots()).map(withoutTrailingSlash);
    if (!known.includes(root)) return undefined;
    if (confinedTo !== undefined && withoutTrailingSlash(confinedTo) !== root) return undefined;
    try {
      return { handle: this.deps.open(folder, root), name: basename(dirname(manifestPath)) };
    } catch {
      return undefined;
    }
  }

  /** The skill folder's whole tree: a folder counts as much as a file, so a tree of empty folders is as long a walk. */
  async #walk(handle: RootHandle, name: string, limits: SkillWalkLimits): Promise<SkillTreeListing | undefined> {
    const entries: SkillTreeEntry[] = [];
    let truncated = false;
    let seen = 0;
    const pending: { readonly at: string; readonly prefix: readonly string[] }[] = [{ at: name, prefix: [] }];
    for (const next of pending) {
      if (truncated) break;
      const resolved = handle.resolve(next.at);
      if (!resolved.ok) return next.prefix.length === 0 ? undefined : this.#other(entries, next.prefix, truncated);
      let listed: Awaited<ReturnType<RootHandle['entries']>>;
      try {
        listed = [...(await handle.entries(resolved.value as FencedPath))].toSorted((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
      } catch {
        if (next.prefix.length === 0) return undefined;
        entries.push({ path: next.prefix.join('/'), type: 'other', size: 0 });
        continue;
      }
      for (const entry of listed) {
        if (seen >= limits.entries) {
          truncated = true;
          break;
        }
        seen += 1;
        const segments = [...next.prefix, entry.name];
        const path = segments.join('/');
        if (entry.kind === 'symlink') entries.push({ path, type: 'symlink', size: 0 });
        else if (entry.kind === 'directory') {
          if (segments.length >= limits.depth) entries.push({ path, type: 'deep', size: 0 });
          else pending.push({ at: `${next.at}/${entry.name}`, prefix: segments });
        } else if (entry.kind === 'file')
          entries.push(
            entry.links > 1 ? { path, type: 'hardlink', size: 0 } : { path, type: 'file', size: entry.size },
          );
        else entries.push({ path, type: 'other', size: 0 });
      }
    }
    return { entries, truncated };
  }

  #other(entries: SkillTreeEntry[], prefix: readonly string[], truncated: boolean): SkillTreeListing {
    return { entries: [...entries, { path: prefix.join('/'), type: 'other', size: 0 }], truncated };
  }
}
