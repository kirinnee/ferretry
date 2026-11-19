/**
 * THE EXPLORER'S PURE HALF: which view to draw, how the keyboard moves, what a listing says about itself.
 */
import type { FolderEntry, FolderListing } from '../../../contract/index.ts';

/** `auto` is the default: list on a phone, cards elsewhere. A person's own choice replaces it and is kept per device. */
export const EXPLORER_VIEW_CHOICES = ['auto', 'card', 'list'] as const;
export type ExplorerViewChoice = (typeof EXPLORER_VIEW_CHOICES)[number];
export type ExplorerView = 'card' | 'list';

/** The view to draw: a chosen one as it is, `auto` by whether the screen is phone-sized. */
export const resolveView = (choice: ExplorerViewChoice, phone: boolean): ExplorerView =>
  choice === 'auto' ? (phone ? 'list' : 'card') : choice;

/** A folder's own path, from the listing it was seen in. The daemon resolves and fences it again on the next read. */
export const childPath = (listing: FolderListing, entry: FolderEntry): string =>
  `${listing.path === '/' ? '' : listing.path}/${entry.name}`;

/** The folder above the one listed, or `null` at the top of the crumbs (the home folder: the explorer never leaves it). */
export const parentPath = (listing: FolderListing): string | null =>
  listing.crumbs.length > 1 ? (listing.crumbs[listing.crumbs.length - 2]?.path ?? null) : null;

/** The folders of a listing, in order: the only entries a keyboard visits and a press opens. */
export const folderEntries = (listing: FolderListing): readonly FolderEntry[] =>
  listing.entries.filter(entry => entry.kind === 'folder');

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/**
 * Where the highlight goes for a key, over `count` folders laid out `columns` wide (`1` for a list). Always inside
 * `0..count-1`; `-1` (nothing highlighted) is only ever the answer for an empty folder. A key that would leave the
 * grid stays where it is, so a held arrow does not wrap around and lose its place.
 */
export const moveHighlight = (current: number, key: NavKey, count: number, columns: number): number => {
  if (count <= 0) return -1;
  const at = Math.min(Math.max(current, 0), count - 1);
  const width = Math.max(1, columns);
  const next = {
    ArrowUp: at - width,
    ArrowDown: at + width,
    ArrowLeft: at - 1,
    ArrowRight: at + 1,
    Home: 0,
    End: count - 1,
  }[key];
  // Nothing was highlighted yet: the first press lands on the first folder rather than skipping past it.
  if (current < 0) return 0;
  return next < 0 || next > count - 1 ? at : next;
};

/** How many entries a listing hides from the person, to be said out loud. */
export const truncationSentence = (listing: FolderListing): string | null =>
  listing.truncated
    ? 'This folder has more entries than can be listed here. Open a subfolder to narrow it down.'
    : null;
