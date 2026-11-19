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
import type { FolderBrowser, FolderReach } from './port.ts';

const PRIVATE_MESSAGE = 'that folder holds keys or sign-ins and is not listed';

/**
 * The folder explorer: lists the folders under the owner's home so one can be picked as a project, and makes one new
 * folder. It reads names, kinds and times only: never a file's content, never a link's target. It lists nothing outside
 * the home, nothing private (see `fence.ts`) and nothing through a link that leaves the home.
 */
export class FolderExplorer {
  constructor(
    private readonly deps: {
      readonly browser: FolderBrowser;
      /** The registry's own folder port: `mayName` (the `imports` fence) and `makeDirectory` (one level, `0700`). */
      readonly folders: Pick<ProjectFolders, 'mayName' | 'makeDirectory'>;
    },
  ) {}

  /** The listing of `path` (default `~`). */
  async list(path: string, hidden: boolean): Promise<FolderListing> {
    const { browser } = this.deps;
    const home = await browser.home();
    const reached = await this.reachInside(path, home);
    const entries = await browser.entries(reached.real);
    if (entries === undefined)
      throw new ApiError(403, 'that folder is not there, or cannot be listed', 'folder_refused');
    // A sign-in file lives at one level; the home itself often holds a few and is the starting point, so it is exempt.
    if (reached.below.length > 0 && holdsSignIn(entries.map(entry => entry.name)))
      throw new ApiError(403, PRIVATE_MESSAGE, 'private_folder');

    const kept = entries
      .filter(entry => entry.kind === 'directory' || entry.kind === 'file')
      .filter(entry => hidden || !entry.name.startsWith('.'))
      .filter(entry => entry.kind !== 'directory' || !isPrivateFolder([...reached.below, entry.name]))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    const shown = kept.slice(0, MAX_FOLDER_ENTRIES);
    const listed: FolderEntry[] = [];
    for (const entry of shown) {
      const folder = entry.kind === 'directory';
      listed.push({
        name: entry.name,
        kind: folder ? 'folder' : 'file',
        isRepo: folder && (await browser.hasGit(reached.real, entry.name)),
        hidden: entry.name.startsWith('.'),
        modifiedAt: entry.modified,
      });
    }
    return {
      path: reached.real,
      crumbs: crumbsOf(home, reached.below),
      entries: listed,
      truncated: kept.length > shown.length,
    };
  }

  /** Makes `<parent>/<name>`: one level, owner-only, never over something that is already there. */
  async make(request: MakeFolderRequest): Promise<MakeFolderResult> {
    const { browser, folders } = this.deps;
    const home = await browser.home();
    const reached = await this.reachInside(request.parent, home);
    if (await browser.exists(reached.real, request.name))
      throw new ApiError(409, 'something with that name is already there', 'folder_exists');
    const target = `${reached.real === '/' ? '' : reached.real}/${request.name}`;
    if (!(await folders.mayName(target))) throw new ApiError(403, 'that folder cannot be made there', 'folder_refused');
    try {
      await folders.makeDirectory(target);
    } catch {
      throw new ApiError(422, 'the folder could not be created', 'folder_not_created');
    }
    return { path: target };
  }

  /** `path` named, reached, and proved to be the home or inside it and not private. */
  private async reachInside(path: string, home: string): Promise<{ real: string; below: readonly string[] }> {
    const parsed = parsePath(path, home);
    if (!parsed.ok) throw new ApiError(400, parsed.message, 'invalid_path');
    // By the spelling first, before the disk is touched: a private folder answers the same whether or not it exists.
    const named = belowHome(parsed.absolute, home);
    if (named !== undefined && isPrivateFolder(named)) throw new ApiError(403, PRIVATE_MESSAGE, 'private_folder');
    const reached: FolderReach = await this.deps.browser.reach(parsed.absolute);
    if (!reached.ok) {
      if (reached.reason === 'missing') throw new ApiError(404, 'there is no such folder', 'folder_not_found');
      if (reached.reason === 'not_folder') throw new ApiError(422, 'that is not a folder', 'not_a_folder');
      throw new ApiError(403, 'that folder is not there, or cannot be listed', 'folder_refused');
    }
    // The real path, not the spelling: a link under the home that leaves it lands outside here.
    const below = belowHome(reached.path, home);
    if (below === undefined) throw new ApiError(403, 'only folders under your home are listed', 'outside_home');
    if (isPrivateFolder(below)) throw new ApiError(403, PRIVATE_MESSAGE, 'private_folder');
    return { real: reached.path, below };
  }
}

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
