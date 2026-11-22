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
import { belowHome, holdsSignIn, isBroadRoot, isDeniedName, isPrivateBelowHome, parsePath } from './fence.ts';
import { type FolderPolicy, folderPolicy } from './policy.ts';
import type { FolderBrowser, HeldFolder, RawFolderEntry } from './port.ts';

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
 * The folder explorer: lists folders so one can be picked as a project, and makes one new folder under the home. It reads
 * names, kinds and times only: never a file's content, never a link's target. It lists nothing private (see `fence.ts`),
 * nothing in a tree no project is read from, and no link.
 *
 * It lists ANYWHERE on the disk, but a place outside the owner's home is only for a caller who passes the `outsideHome` gate
 * (`outside-gate.ts`: `filesystem.configure`, a passkey step-up for a remote device): the gate is asked before the disk is
 * touched for a name spelled outside the home, and again for a link inside the home that leads out. A folder is only ever
 * MADE under the home. GAP (stated, not closed): a name inside the home that is a link to an existing folder outside it
 * answers the gate's refusal where a missing name answers `folder_refused`; a use-only device could learn that such a link
 * exists, by guessing its name (a link is never listed).
 *
 * A private name is judged by its spelling only BEFORE the disk is touched (that answer is `private_folder` and says nothing
 * about what exists). Everything the disk decided (a sign-in folder, a link into a private folder, a folder under either)
 * answers the one `folder_refused`, so a guess cannot tell an existing private place from a missing one.
 *
 * ONE policy judges every folder it touches (`policy.ts`): the real path (never the spelling alone) is not in a skipped
 * tree, is not a private folder (by name, and by where each private folder REALLY is: `~/.gnupg` linked to `~/dotfiles/gnupg`
 * makes both private) or another user's home, and neither it nor any ancestor holds a sign-in file. It judges the folder
 * being listed, each folder listed, every ancestor, the parent a folder is made in and the place it is made. A folder is
 * held open once and everything is read or made through that held object (see `adapter.ts`).
 */
export class FolderExplorer {
  constructor(
    private readonly deps: {
      readonly browser: FolderBrowser;
      /** The registry's own folder port: `mayName` is the `imports` fence (never inside Ferretry's own home). */
      readonly folders: Pick<ProjectFolders, 'mayName'>;
    },
  ) {}

  /**
   * The listing of `path` (default `~`). `outsideHome` is the gate a caller who is not the owner at the machine must pass for
   * a place outside the home (it throws the refusal); without one, every place the policy accepts is listed.
   */
  async list(path: string, hidden: boolean, outsideHome?: () => Promise<void>): Promise<FolderListing> {
    const { browser } = this.deps;
    const home = await browser.home();
    const policy = await folderPolicy(browser, home, outsideHome);
    const { folder, below } = await this.hold(path, home, policy, 'anywhere');
    try {
      const read = await folder.entries(READ_LIMIT);
      if (read === undefined) throw refused();
      // The held folder's own names are checked too: the home itself often holds a few and is the starting point, `/` has none.
      const anchor = below === undefined ? folder.real === '/' : below.length === 0;
      if (!anchor && holdsSignIn(read.entries.map(entry => entry.name))) throw refused();

      const base = folder.real === '/' ? '' : folder.real;
      const kept = read.entries
        .filter(entry => hidden || !entry.name.startsWith('.'))
        // A name the shared list denies (a key store, `.env`, `*.pem`, …) is never returned, file or folder, anywhere.
        .filter(entry => !isDeniedName(entry.name))
        .filter(
          entry => entry.kind !== 'directory' || below === undefined || !isPrivateBelowHome([...below, entry.name]),
        )
        .filter(
          entry =>
            entry.kind !== 'directory' ||
            !(policy.isPrivateReal(`${base}/${entry.name}`) || policy.isSkippedReal(`${base}/${entry.name}`)),
        )
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
        crumbs: crumbsOf(home, folder.real, below),
        entries: listed,
        truncated: read.more || shown.cut,
        ...(isBroadRoot(folder.real, home) ? { broad: true as const } : {}),
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
      if (named !== undefined && isPrivateBelowHome([...named, request.name])) throw priv();
    }
    const policy = await folderPolicy(browser, home);
    const { folder, below } = await this.hold(request.parent, home, policy, 'home');
    try {
      // A folder is only made under the home: the hold refused anything else.
      if (below === undefined) throw refused();
      // The destination against the private names BEFORE the existence test, so it cannot be probed through it. The parent
      // is a real path by now: this is the disk's answer, so it is the one refusal.
      if (isPrivateBelowHome([...below, request.name])) throw refused();
      const target = `${folder.real === '/' ? '' : folder.real}/${request.name}`;
      if (policy.isPrivateReal(target)) throw refused();
      // What is already there is looked at WITHOUT following it: a link (to anywhere) is only "already there" and nothing
      // beyond the link is touched, so the answer says nothing about a folder outside the home.
      const found = await folder.lookup(request.name);
      if (found === 'link') throw new ApiError(409, 'something with that name is already there', 'folder_exists');
      if (!(await folders.mayName(target))) throw refused();
      // A real folder that already exists and holds a sign-in marker (any spelling) is refused as the folder it is, BEFORE
      // "already there" can say so.
      if (found === 'present' && (await browser.holdsSignIn(target)) === true) throw refused();
      const made = await folder.makeLeaf(request.name, policy.confined);
      switch (made.kind) {
        case 'made':
          return { path: made.path };
        case 'exists':
          throw new ApiError(409, 'something with that name is already there', 'folder_exists');
        case 'refused':
          throw refused();
        case 'failed':
          throw new ApiError(422, 'the folder could not be created', 'folder_not_created');
      }
    } finally {
      await folder.close();
    }
  }

  /**
   * `path` named, held open, and proved by where it REALLY is to be a place the policy accepts: `anywhere` on the disk
   * (outside the home only through the gate), or only `home` or inside it. `below` is where the real folder sits below the
   * home, `undefined` outside it.
   */
  private async hold(
    path: string,
    home: string,
    policy: FolderPolicy,
    scope: 'anywhere' | 'home',
  ): Promise<{ folder: HeldFolder; below: readonly string[] | undefined }> {
    const parsed = parsePath(path, home);
    if (!parsed.ok) throw new ApiError(400, parsed.message, 'invalid_path');
    // The home boundary (when confined), the gate for a place outside it, and the private names, by the spelling, BEFORE any
    // probe: a place outside the home, or a private one, answers the same whether or not it exists.
    const named = belowHome(parsed.absolute, home);
    if (named === undefined) {
      if (scope === 'home') throw refused();
      await policy.enterOutside();
    } else if (isPrivateBelowHome(named)) throw priv();
    const opened = await this.deps.browser.open(parsed.absolute, scope === 'home' ? policy.confined : policy.verdict);
    if (!opened.ok) {
      switch (opened.reason) {
        case 'not_folder':
          throw new ApiError(422, 'that is not a folder', 'not_a_folder');
        default:
          throw refused();
      }
    }
    const below = belowHome(opened.folder.real, home);
    if (below === undefined && scope === 'home') {
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
      // Only a proved marker hides a folder from the listing: `'partial'` (a wide folder) is shown, as before.
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

/** From the home (`~`), or from `/` for a folder outside it, down to the folder, each with its absolute path. */
function crumbsOf(home: string, real: string, below: readonly string[] | undefined): FolderCrumb[] {
  const crumbs: FolderCrumb[] = [below === undefined ? { name: '/', path: '/' } : { name: '~', path: home }];
  let path = below === undefined ? '' : home.replace(/\/+$/, '');
  for (const segment of below ?? real.split('/').filter(part => part !== '')) {
    path = `${path}/${segment}`;
    crumbs.push({ name: segment, path });
  }
  return crumbs;
}
