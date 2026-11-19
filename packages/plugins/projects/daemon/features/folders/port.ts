import type { Instant } from '@ferretry/std';

/** One name in a folder as the machine reports it: the leaf as it is, a link never followed. */
export interface RawFolderEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly modified: Instant;
}

/** Why a folder could not be reached: the fence said no (or a link left it), nothing is there, or it is not a folder. */
export type FolderReach =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'refused' | 'missing' | 'not_folder' };

/**
 * What the folder explorer asks of the machine, as one port. The real one (`adapter.ts`) goes through the kernel's
 * `imports` root; tests give a map of folders. Every path handed to it is absolute.
 */
export interface FolderBrowser {
  /** The owner's home folder, resolved (no link on the way). */
  home(): Promise<string>;
  /** The real path of an existing folder (links resolved), or why it cannot be reached. */
  reach(path: string): Promise<FolderReach>;
  /** The names in a reached folder; undefined when the machine refuses the listing. */
  entries(folder: string): Promise<readonly RawFolderEntry[] | undefined>;
  /** Whether `<folder>/<name>` exists at all, as anything (a link counts, not followed). */
  exists(folder: string, name: string): Promise<boolean>;
  /** Whether `<folder>/<name>/.git` exists (a folder, or the file a work tree keeps). */
  hasGit(folder: string, name: string): Promise<boolean>;
}
