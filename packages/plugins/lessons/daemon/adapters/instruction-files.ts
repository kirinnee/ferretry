import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { GLOBAL_LESSONS_FILE, type GlobalLessonsPort, type LessonFilesPort } from '../lib/index.ts';
import type { LessonsStorePort } from '../lib/store.ts';

const trim = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);
const inside = (folder: string, path: string): boolean => path === trim(folder) || path.startsWith(`${trim(folder)}/`);
const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
};

/**
 * The instruction files an Apply writes. A Repo lesson goes into the project's own AGENTS.md / CLAUDE.md, reached through
 * the `work` root of the ferret whose folder holds the project (never by a bare path); the Global lessons document is
 * this plugin's own state. Written atomically by the root, so a crash never leaves an owner's file half written.
 */
export class WorkRootLessonFiles implements LessonFilesPort {
  constructor(
    private readonly ferrets: Pick<FerretsApi, 'list'>,
    private readonly roots: Pick<RootsPort, 'root'>,
    private readonly store: Pick<LessonsStorePort, 'readGlobal' | 'writeGlobal'>,
  ) {}

  /** The ferret whose folder holds `path` (the deepest one wins) and its root. */
  private async rootFor(path: string): Promise<{ readonly root: RootHandle; readonly folder: string } | undefined> {
    const holders = (await this.ferrets.list())
      .filter(ferret => inside(ferret.folder, path))
      .toSorted((left, right) => right.folder.length - left.folder.length);
    const holder = holders[0];
    return holder === undefined
      ? undefined
      : { root: this.roots.root('work', { ferret: holder.id as FerretId }), folder: trim(holder.folder) };
  }

  private async exists(path: string): Promise<boolean> {
    const held = await this.rootFor(path);
    if (held === undefined) return false;
    const fenced = held.root.resolve(path);
    return fenced.ok && (await held.root.stat(fenced.value).catch(() => undefined)) !== undefined;
  }

  /** The git root at or above `cwd`, as far as the ferret's folder reaches; else the folder itself. */
  async projectRoot(cwd: string): Promise<string> {
    const held = await this.rootFor(cwd);
    let directory = trim(cwd);
    while (held !== undefined && inside(held.folder, directory)) {
      if (await this.exists(`${directory}/.git`)) return directory;
      if (directory === held.folder) break;
      directory = parentOf(directory);
    }
    return cwd;
  }

  async read(path: string): Promise<string | undefined> {
    if (path === GLOBAL_LESSONS_FILE) return await this.store.readGlobal();
    const held = await this.rootFor(path);
    if (held === undefined) return undefined;
    const fenced = held.root.resolve(path);
    if (!fenced.ok || (await held.root.stat(fenced.value).catch(() => undefined)) === undefined) return undefined;
    return await held.root.readText(fenced.value);
  }

  async write(path: string, text: string): Promise<void> {
    if (path === GLOBAL_LESSONS_FILE) return await this.store.writeGlobal(text);
    const held = await this.rootFor(path);
    if (held === undefined) throw new Error(`${path} is outside every ferret folder, so Ferretry will not write it`);
    const fenced = held.root.resolve(path);
    if (!fenced.ok) throw new Error(`${path} cannot be written: ${fenced.error}`);
    await held.root.writeText(fenced.value, text);
  }

  join(directory: string, name: string): string {
    return `${trim(directory)}/${name}`;
  }
}

/** The Global lessons document: `state/lessons/global.json`, shown to the owner as `instructions/lessons.md`. */
export class StateGlobalLessons implements GlobalLessonsPort {
  async locate(): Promise<{ readonly path: string; readonly notes: readonly string[] }> {
    return {
      path: GLOBAL_LESSONS_FILE,
      notes: ['Every ferret reads this document at its next launch.'],
    };
  }

  /** There is no component file to create: the document is read by every launch. */
  async ensureComponent(): Promise<void> {}
}
