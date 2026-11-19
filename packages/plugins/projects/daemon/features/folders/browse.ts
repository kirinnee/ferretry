import { ApiError } from '@ferretry/kernel/contract';
import {
  type FolderCrumb,
  type FolderEntry,
  type FolderListing,
  MAX_FOLDER_ENTRIES,
  type MakeFolderRequest,
  type MakeFolderResult,
} from '../../../contract/index.ts';
import type { ProjectFolders } from '../../lib/ports.ts';
import { belowHome, holdsSignIn, isPrivateFolder, parsePath } from './fence.ts';
import type { FolderBrowser, FolderVerdict, HeldFolder, RawFolderEntry } from './port.ts';

const PRIVATE_MESSAGE = 'that folder holds keys or sign-ins and is not listed';
/** One answer for every way a folder is out of reach (outside the home, a link out, missing and refused alike). */
const REFUSED_MESSAGE = 'that folder is not there, or cannot be listed';

/** The most names read from one folder before the cut; the listing keeps {@link MAX_FOLDER_ENTRIES} of what survives. */
const READ_LIMIT = 5000;
/** How many child folders are checked for a sign-in file at once. */
const CHECK_BATCH = 16;

const refused = (): ApiError => new ApiError(403, REFUSED_MESSAGE, 'folder_refused');
const priv = (): ApiError => new ApiError(403, PRIVATE_MESSAGE, 'private_folder');

/**
 * The folder explorer: lists the folders under the owner's home so one can be picked as a project, and makes one new
 * folder. It reads names, kinds and times only: never a file's content, never a link's target. It lists nothing outside
 * the home, nothing private (see `fence.ts`) and nothing through a link that leaves the home.
 *
 * ONE policy judges every folder it touches: the real path (never the spelling alone) is the home or below it, is not
 * a private folder, and neither it nor any ancestor below the home holds a sign-in file. It judges the folder being
 * listed, each folder listed, every ancestor, the parent a folder is made in and the place it is made. A folder is held
 * open once and everything is read or made through that held object (see `adapter.ts`).
 */
export class FolderExplorer {
  constructor(
    private readonly deps: {
      readonly browser: FolderBrowser;
      /** The registry's own folder port: `mayName` is the `imports` fence (never inside Ferretry's own home). */
      readonly folders: Pick<ProjectFolders, 'mayName'>;
    },
  ) {}

  /** The listing of `path` (default `~`). */
  async list(path: string, hidden: boolean): Promise<FolderListing> {
    const { browser } = this.deps;
    const home = await browser.home();
    const { folder, below } = await this.hold(path, home);
    try {
      const read = await folder.entries(READ_LIMIT);
      if (read === undefined) throw refused();
      // The held folder's own names are checked too: the home itself often holds a few and is the starting point.
      if (below.length > 0 && holdsSignIn(read.entries.map(entry => entry.name))) throw priv();

      const kept = read.entries
        .filter(entry => hidden || !entry.name.startsWith('.'))
        .filter(entry => entry.kind !== 'directory' || !isPrivateFolder([...below, entry.name]))
        .sort(byKindThenName);
      const shown = await this.firstShown(kept, folder.real);
      const listed: FolderEntry[] = [];
      for (const entry of shown.entries) {
        const isFolder = entry.kind === 'directory';
        listed.push({
          name: entry.name,
          kind: isFolder ? 'folder' : 'file',
          isRepo: isFolder && (await folder.hasGit(entry.name)),
          hidden: entry.name.startsWith('.'),
          modifiedAt: entry.modified,
        });
      }
      return {
        path: folder.real,
        crumbs: crumbsOf(home, below),
        entries: listed,
        truncated: read.more || shown.cut,
      };
    } finally {
      await folder.close();
    }
  }

  /** Makes `<parent>/<name>`: one level, owner-only, never over something that is already there. */
  async make(request: MakeFolderRequest): Promise<MakeFolderResult> {
    const { browser, folders } = this.deps;
    const home = await browser.home();
    // The place named is judged by its spelling before the disk is touched, so a private name answers the same whether or
    // not it exists.
    const parsed = parsePath(request.parent, home);
    if (parsed.ok) {
      const named = belowHome(parsed.absolute, home);
      if (named !== undefined && isPrivateFolder([...named, request.name])) throw priv();
    }
    const { folder, below } = await this.hold(request.parent, home);
    try {
      // The destination against the private names BEFORE the existence test, so it cannot be probed through it.
      if (isPrivateFolder([...below, request.name])) throw priv();
      const target = `${folder.real === '/' ? '' : folder.real}/${request.name}`;
      if (!(await folders.mayName(target))) throw refused();
      const made = await folder.makeLeaf(request.name, this.verdict(home));
      switch (made.kind) {
        case 'made':
          return { path: made.path };
        case 'exists':
          throw new ApiError(409, 'something with that name is already there', 'folder_exists');
        case 'refused':
          throw made.reason === 'private' ? priv() : refused();
        case 'failed':
          throw new ApiError(422, 'the folder could not be created', 'folder_not_created');
      }
    } finally {
      await folder.close();
    }
  }

  /**
   * The one policy, on a REAL path: the home or inside it, not a private folder, and no folder from the first below the
   * home down to this one holds a sign-in file (the home itself often does and is the starting point).
   */
  private verdict(home: string): FolderVerdict {
    return async real => {
      const below = belowHome(real, home);
      if (below === undefined) return 'outside';
      if (isPrivateFolder(below)) return 'private';
      let path = home.replace(/\/+$/, '');
      for (const segment of below) {
        path = `${path}/${segment}`;
        if (await this.deps.browser.holdsSignIn(path)) return 'private';
      }
      return undefined;
    };
  }

  /** `path` named, held open, and proved by where it REALLY is to be the home or inside it and not private. */
  private async hold(path: string, home: string): Promise<{ folder: HeldFolder; below: readonly string[] }> {
    const parsed = parsePath(path, home);
    if (!parsed.ok) throw new ApiError(400, parsed.message, 'invalid_path');
    // The home boundary and the private names, by the spelling, BEFORE any probe: a place outside the home, or a private
    // one, answers the same whether or not it exists.
    const named = belowHome(parsed.absolute, home);
    if (named === undefined) throw refused();
    if (isPrivateFolder(named)) throw priv();
    const opened = await this.deps.browser.open(parsed.absolute, this.verdict(home));
    if (!opened.ok) {
      switch (opened.reason) {
        case 'private':
          throw priv();
        case 'missing':
          throw new ApiError(404, 'there is no such folder', 'folder_not_found');
        case 'not_folder':
          throw new ApiError(422, 'that is not a folder', 'not_a_folder');
        default:
          throw refused();
      }
    }
    const below = belowHome(opened.folder.real, home);
    if (below === undefined) {
      await opened.folder.close();
      throw refused();
    }
    return { folder: opened.folder, below };
  }

  /** The first {@link MAX_FOLDER_ENTRIES} of `kept` that pass the sign-in check, in order; `cut` when more were left. */
  private async firstShown(
    kept: readonly RawFolderEntry[],
    real: string,
  ): Promise<{ entries: RawFolderEntry[]; cut: boolean }> {
    const entries: RawFolderEntry[] = [];
    const base = real === '/' ? '' : real;
    for (let at = 0; at < kept.length; at += CHECK_BATCH) {
      const batch = kept.slice(at, at + CHECK_BATCH);
      const holds = await Promise.all(
        batch.map(entry =>
          entry.kind === 'directory' ? this.deps.browser.holdsSignIn(`${base}/${entry.name}`) : false,
        ),
      );
      for (const [index, entry] of batch.entries()) {
        if (holds[index] === true) continue;
        if (entries.length === MAX_FOLDER_ENTRIES) return { entries, cut: true };
        entries.push(entry);
      }
    }
    return { entries, cut: false };
  }
}

const byKindThenName = (a: RawFolderEntry, b: RawFolderEntry): number => {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/** From the home (`~`) down to the folder, each with its absolute path. */
function crumbsOf(home: string, below: readonly string[]): FolderCrumb[] {
  const crumbs: FolderCrumb[] = [{ name: '~', path: home }];
  let path = home.replace(/\/+$/, '');
  for (const segment of below) {
    path = `${path}/${segment}`;
    crumbs.push({ name: segment, path });
  }
  return crumbs;
}
