import type { Instant } from '@ferretry/std';

/** One name in a folder as the machine reports it: the leaf as it is, a link never followed. */
export interface RawFolderEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly modified: Instant;
}

/**
 * Why a folder was not opened: the machine refused it (or the fence did), nothing is there, it is not a folder, or the
 * explorer's own judgment of where it REALLY is said no (`outside` the home, `private`).
 */
export type FolderOpenFailure = 'refused' | 'missing' | 'not_folder' | 'outside' | 'private';

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
  /** Whether `<held>/<name>/.git` exists (a folder, or the file a work tree keeps). */
  hasGit(name: string): Promise<boolean>;
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
  /** Whether the real folder `path` directly holds a sign-in or key file (by name, a link counts, not followed). */
  holdsSignIn(path: string): Promise<boolean>;
}
