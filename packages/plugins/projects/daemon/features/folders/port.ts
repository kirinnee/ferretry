import type { WorkBudget } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';

/** One name in a folder as the machine reports it: the leaf as it is, a link never followed. */
export interface RawFolderEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly modified: Instant;
}

/**
 * Why a folder was not opened: the machine refused it (or the fence did, or nothing verified is there), it is a file, or the
 * policy's own judgment of where it REALLY is said no (`outside`: a tree no project is read from, or outside the project a
 * scan reads; `private`: keys, sign-ins, another user's home).
 */
export type FolderOpenFailure = 'refused' | 'not_folder' | 'outside' | 'private';

/** The explorer's verdict on a real folder path: `undefined` to accept it, or why not. Asked on the real path, never the spelling. */
export type FolderVerdict = (real: string) => Promise<'outside' | 'private' | undefined>;

export type FolderOpen =
  | { readonly ok: true; readonly folder: HeldFolder }
  | { readonly ok: false; readonly reason: FolderOpenFailure };

/** What making one new folder did. */
export type LeafMade =
  | { readonly kind: 'made'; readonly path: string }
  | { readonly kind: 'exists' }
  | { readonly kind: 'failed' }
  /** The new folder was not where it should be (a link, or a place the verdict refuses): it was taken back. */
  | { readonly kind: 'refused'; readonly reason: 'outside' | 'private' };

/**
 * A folder HELD OPEN: everything the explorer reads or makes in it goes through the one object that was judged, never
 * through its name again. The real one keeps a descriptor; a test double keeps a map entry.
 */
export interface HeldFolder {
  /** The real path of the object held (links resolved), as the machine says it NOW. */
  readonly real: string;
  /** The names in the held folder, files and folders only (a link is never listed); `more` when it held more than `limit`. */
  entries(limit: number): Promise<{ readonly entries: readonly RawFolderEntry[]; readonly more: boolean } | undefined>;
  /**
   * What is AT `<held>/<name>`, the leaf never followed: nothing, a link (or a name the machine refuses to look at), or
   * something else that is there.
   */
  lookup(name: string): Promise<'missing' | 'link' | 'present'>;
  /**
   * The text of the file at `rel` inside the held folder (at most `limit` bytes), read through the held object: the leaf
   * is looked at without following it first, no link at any component is followed, and only a regular file is read.
   * `undefined` when it is not there, is not a regular file, is a link, is larger than `limit` or cannot be read.
   */
  readText(rel: string, limit: number): Promise<string | undefined>;
  /** Whether `<held>/<name>/.git` exists (a folder, or the file a work tree keeps). */
  hasGit(name: string): Promise<boolean>;
  /**
   * The device (`st_dev`) of the folder `<held>/<rel>` (`''` is the held folder itself): the disk it is on, so a reader can
   * stay on one disk the way `find -xdev` does. `undefined` when it is not a folder there now or cannot be looked at; a
   * link is never followed.
   */
  device(rel: string): Promise<string | undefined>;
  /**
   * Makes ONE new folder `name` (owner-only, not recursive, never over anything) inside the held folder, then proves it
   * is a real folder at `<real>/<name>` that `verdict` accepts; when it is not, only that just-made empty folder is
   * removed and the refusal answers.
   */
  makeLeaf(name: string, verdict: FolderVerdict): Promise<LeafMade>;
  close(): Promise<void>;
}

/**
 * What the folder explorer asks of the machine, as one port. The real one (`adapter.ts`) goes through the kernel's
 * `imports` root and holds folders open; tests give a map of folders. Every path handed to it is absolute.
 */
export interface FolderBrowser {
  /** The owner's home folder, resolved (no link on the way). */
  home(): Promise<string>;
  /**
   * Holds the folder open. The real path is resolved, judged by `verdict`, held, and judged AGAIN as what the held
   * object really is; a folder that fails either is never returned. The caller closes it.
   */
  open(path: string, verdict: FolderVerdict): Promise<FolderOpen>;
  /**
   * Whether the real folder `path` directly holds a sign-in or key file: each known marker is asked for by name (a link
   * counts, not followed), so the width of the folder never matters, and the names it holds are judged by the one fold in
   * `fence.ts`, so a differently spelled marker is a marker. A folder whose names cannot be asked for answers `true`; a
   * file or a missing name, `false`. A folder is never "private" for being wide.
   *
   * `'partial'` is the third answer: no marker was found, but the folder holds more names than were read for the
   * spelling-fold look, so a differently spelled marker past the bound was NOT ruled out. A caller that only asks "is it a
   * sign-in folder" reads that as `false` (width alone never makes a folder private); the repository scan reads it as "not
   * proved safe": the folder is skipped and the scan is truncated.
   *
   * A reader on a deadline passes its `budget`: a budget already spent starts no listing, and one that runs out part-way
   * stops the listing where it stands. Either way the look is not whole, so the answer is `'partial'`.
   */
  holdsSignIn(path: string, budget?: WorkBudget): Promise<boolean | 'partial'>;
  /** What is AT the absolute `path`, the leaf never followed (a link anywhere above it is the machine's to resolve): nothing, a link, or something else. */
  leaf(path: string): Promise<'missing' | 'link' | 'present'>;
  /** The real path (links resolved) of each of `paths` that exists and resolves; the others are left out. */
  realPaths(paths: readonly string[]): Promise<readonly string[]>;
}
