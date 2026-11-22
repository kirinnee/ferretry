import type { ProjectIndexCache } from './cache.ts';

/** A path without its trailing slashes (a lone `/` stays). */
const bare = (path: string): string => path.replace(/(?<=.)\/+$/u, '');

/** Whether `folder` is the project's folder or somewhere below it (a ferret in a linked worktree under the project counts). */
export function folderInProject(folder: string, projectPath: string): boolean {
  const inside = bare(folder);
  const root = bare(projectPath);
  return inside === root || inside.startsWith(root === '/' ? '/' : `${root}/`);
}

/** The part of a `ferrets.changed` event that says a ferret stopped working: a turn ended, or the ferret did. */
export interface FerretChange {
  readonly ferret: string;
  readonly state?: string | undefined;
  readonly gone?: true | undefined;
}

/** What the refresh reads: the registered projects, and the folder a ferret was started in (none when it is unknown). */
export interface RefreshSources {
  readonly projects: () => Promise<readonly { readonly id: string; readonly path: string }[]>;
  readonly folderOf: (ferret: string) => Promise<string | undefined>;
}

/**
 * When the file index is told to refresh (&F6061 U6, plan §3.5). There is no watcher (owner decision D5), so a change is
 * heard of instead: a ferret in the project STOPPED WORKING (its turn ended — `idle` — or the ferret stopped), the project
 * was registered again, or it was removed. A turn end only marks the project's index out of date; the next read answers the
 * old index and rebuilds behind it, so a burst of turns is one build. A removal forgets the index outright.
 */
export class FilesRefresh {
  constructor(
    private readonly cache: ProjectIndexCache,
    private readonly sources: RefreshSources,
  ) {}

  /** A ferret changed state: when it stopped working, every project whose folder holds it is marked out of date. */
  async ferretChanged(change: FerretChange): Promise<void> {
    if (change.gone === true || (change.state !== 'idle' && change.state !== 'stopped')) return;
    const folder = await this.sources.folderOf(change.ferret);
    if (folder === undefined) return;
    for (const project of await this.sources.projects()) {
      if (folderInProject(folder, project.path)) this.cache.invalidate(project.id);
    }
  }

  /** A project was registered (again): what it points at may have moved. */
  registered(id: string): void {
    this.cache.invalidate(id);
  }

  /** A project was removed: nothing about it is answered from memory any longer. */
  removed(id: string): void {
    this.cache.evict(id);
  }
}
