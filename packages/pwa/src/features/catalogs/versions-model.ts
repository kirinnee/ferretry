/**
 * What the owner's version screens say, worked out from what the daemon answered. Pure functions; the sheet and
 * the changes view only draw them.
 *
 * Nothing here compares text or decides what may be current: the daemon did both. The only thing worked out here
 * is REACH ("N people can see it"), because the wire carries no head count and the members list already does.
 */

import type {
  CatalogChange,
  CatalogChangeFlag,
  CatalogChanges,
  CatalogMemberView,
  OwnedCatalog,
  OwnedSharedItem,
  OwnedSharedItemVersion,
} from '@ferretry/protocol';
import { relativeWords } from '../../lib/security-log.ts';
import { formatBytes, plural } from './catalog-review-model.ts';

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

export interface VersionLine {
  readonly version: number;
  readonly current: boolean;
  readonly retired: boolean;
  /** `v3 · current · 2 days ago · 4 files · 12.0 KB` */
  readonly text: string;
  /** The version just before this one, which "What changed" compares against; `null` for the first. */
  readonly previous: number | null;
}

const lineText = (entry: OwnedSharedItemVersion, current: number, nowMs: number): string =>
  [
    `v${String(entry.version)}`,
    ...(entry.version === current ? ['current'] : []),
    ...(entry.retiredAt === undefined ? [] : ['retired']),
    relativeWords(entry.publishedAt, nowMs),
    ...(entry.fileCount === undefined ? [] : [plural(entry.fileCount, 'file')]),
    formatBytes(entry.size),
  ].join(' · ');

/** Every version of the item, newest first, each with the version it is compared against. */
export function versionLines(item: OwnedSharedItem, nowMs: number): readonly VersionLine[] {
  const ascending = item.versions.toSorted((left, right) => left.version - right.version);
  return ascending
    .map(
      (entry, index): VersionLine => ({
        version: entry.version,
        current: entry.version === item.current,
        retired: entry.retiredAt !== undefined,
        text: lineText(entry, item.current, nowMs),
        previous: ascending[index - 1]?.version ?? null,
      }),
    )
    .toReversed();
}

/** The names of the catalogs that serve the current version: the live ones, in the order the item lists them. */
export function usedByNames(item: OwnedSharedItem, catalogs: readonly OwnedCatalog[]): readonly string[] {
  const used = item.versions.find(entry => entry.version === item.current)?.usedBy.catalogIds ?? [];
  return used.map(id => catalogs.find(catalog => catalog.id === id)?.name ?? 'A catalog that is gone');
}

/** "Used by Team skills and Friends", or the plain fact that no catalog lists it. */
export function usedByLine(names: readonly string[]): string {
  if (names.length === 0) return 'No catalog lists it now.';
  if (names.length === 1) return `Used by ${names[0] as string}.`;
  return `Used by ${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}.`;
}

// ── Reach ────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many people can see the item: members who may read at least one catalog that lists it live. This is reach,
 * not installs; nobody here says who installed what. `null` when the members could not be read, so the sheet
 * says nothing rather than a wrong number.
 */
export function reachOf(item: OwnedSharedItem, members: readonly CatalogMemberView[] | null): number | null {
  if (members === null) return null;
  const live = new Set(item.catalogs.filter(entry => entry.state === 'live').map(entry => entry.catalogId));
  return members.filter(member => member.catalogIds.some(id => live.has(id))).length;
}

export function reachLine(count: number | null): string | null {
  if (count === null) return null;
  if (count === 0) return 'Nobody can see it yet.';
  return count === 1 ? '1 person can see it.' : `${String(count)} people can see it.`;
}

// ── What an owner may do with a line ─────────────────────────────────────────────────────────────

export interface VersionActions {
  readonly makeCurrent: boolean;
  readonly retire: boolean;
  readonly unretire: boolean;
}

/**
 * Owner acts per line. The current version cannot be retired and is already current, and a retired one cannot be
 * made current until it is back, so each line offers only what the daemon would accept. Without
 * `catalogs.versions.2` it offers nothing: the list is for reading.
 */
export function versionActions(line: VersionLine, versions2: boolean): VersionActions {
  return {
    makeCurrent: versions2 && !line.current && !line.retired,
    retire: versions2 && !line.current && !line.retired,
    unretire: versions2 && line.retired,
  };
}

export const makeCurrentSentence = (version: number): string =>
  `Every catalog that lists it will offer version ${String(version)} from now on. Copies people already have stay as they are.`;

export const retireSentence = (version: number): string =>
  `Version ${String(version)} will stop being offered. Copies people already have keep working.`;

export const unretireSentence = (version: number): string =>
  `Version ${String(version)} can be offered again, and be made current.`;

export const retiredDoneSentence = (version: number, retired: boolean): string =>
  retired ? `Version ${String(version)} is retired.` : `Version ${String(version)} is back in use.`;

export const currentDoneSentence = (version: number): string => `Version ${String(version)} is current now.`;

/** The item moved on while the sheet was open: the list was read again. */
export const READ_AGAIN_SENTENCE = 'The current version changed since you opened this. The list is up to date now.';

// ── Publishing ───────────────────────────────────────────────────────────────────────────────────

/** What a preview that is the same as an older kept version says; the button beside it makes that version current. */
export const sameAsVersionSentence = (version: number): string =>
  `That is version ${String(version)}. Make version ${String(version)} current instead.`;

/** A warning, not a refusal: publishing still makes a new number. */
export const sameAsRetiredSentence = (version: number): string =>
  `This is the content of retired version ${String(version)}. Publishing makes a new version number anyway.`;

// ── The changes ──────────────────────────────────────────────────────────────────────────────────

const FLAG_WORDS: Readonly<Record<CatalogChangeFlag, string>> = {
  command: 'Command or address',
  script: 'Script',
  'runs-on-its-own': 'Runs on its own',
};

export const flagLabel = (flag: CatalogChangeFlag): string => FLAG_WORDS[flag];

const CHANGE_WORDS: Readonly<Record<CatalogChange['change'], string>> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

export const changeLabel = (change: CatalogChange['change']): string => CHANGE_WORDS[change];

/** "2 things changed · 5 the same", or the plain fact that nothing differs. */
export function changesSummary(changes: CatalogChanges): string {
  const changed = changes.entries.length;
  const same = changes.unchanged;
  if (changed === 0)
    return same === 0 ? 'Nothing to compare.' : `No difference in what people read (${String(same)} the same).`;
  return `${plural(changed, 'thing')} changed · ${String(same)} the same`;
}

export const TRUNCATED_SENTENCE =
  'This is a big change. Some files are not shown line by line here; each says so. Read them whole in the full review.';

export const TOO_LARGE_SENTENCE = 'Too big to compare line by line. Read the whole file in the full review.';

/** The `@@ -3,4 +3,6 @@` line over a hunk. */
export const hunkHeader = (hunk: {
  readonly beforeStart: number;
  readonly beforeLines: number;
  readonly afterStart: number;
  readonly afterLines: number;
}): string =>
  `@@ -${String(hunk.beforeStart)},${String(hunk.beforeLines)} +${String(hunk.afterStart)},${String(hunk.afterLines)} @@`;

/** The line marks of a diff: the sign is the meaning, so it never rests on colour alone. */
export const LINE_SIGN = { context: ' ', add: '+', remove: '−' } as const;
