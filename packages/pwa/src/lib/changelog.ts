/**
 * THE CHANGELOG THIS BUILD SHIPS WITH, parsed once into what a person reads in "What's new".
 *
 * `Changelog.md` is semantic-release's output: one `## [version](compare) (date)` section per release,
 * `### Features` / `### Fixes` / `### Performance` groups under it, and one `* **scope:** subject ([#PR])
 * ([hash])` bullet per change (`docs/standards/semantic-release`). The build copies the newest
 * sections into `__FY_CHANGELOG__` (`vite.config.ts`), so this app never fetches release notes at run
 * time: the notes a reader sees are the notes of the build they are running, and they work offline.
 *
 * Everything here is pure — text in, values out — so the grouping, the wording and the "New" rule are
 * asserted without a DOM. The `localStorage` reads are the only effects, and they say nothing rather
 * than throw: a private window must not make the page fail to open.
 */

import { compareProtocolVersions } from '@ferretry/protocol';

declare const __FY_CHANGELOG__: string | undefined;

type ChangeKind = 'breaking' | 'features' | 'fixes' | 'performance' | 'reverts';

export interface ChangelogChange {
  /** The commit scope, shown as a small tag; absent when the subject carried none. */
  readonly scope?: string;
  /** The plain subject, with its `feat(scope):` prefix and trailing links already removed. */
  readonly text: string;
  readonly pr?: { readonly number: number; readonly url: string };
}

interface ChangelogGroup {
  readonly kind: ChangeKind;
  /** The group's short plain-language title. */
  readonly title: string;
  readonly changes: readonly ChangelogChange[];
}

export interface ChangelogRelease {
  readonly version: string;
  /** `YYYY-MM-DD`, the day the release was cut. */
  readonly date: string;
  readonly releaseUrl: string | undefined;
  readonly groups: readonly ChangelogGroup[];
}

const GROUP_HEADINGS: Readonly<Record<string, { readonly kind: ChangeKind; readonly title: string }>> = {
  '⚠ BREAKING CHANGES': { kind: 'breaking', title: 'Breaking changes' },
  Features: { kind: 'features', title: 'New' },
  Fixes: { kind: 'fixes', title: 'Fixed' },
  Performance: { kind: 'performance', title: 'Faster' },
  Reverts: { kind: 'reverts', title: 'Reverted' },
};

const GROUP_ORDER: readonly ChangeKind[] = ['breaking', 'features', 'fixes', 'performance', 'reverts'];

const RELEASE_HEADING = /^## \[?(\d+\.\d+\.\d+[^\]\s)]*)\]?(?:\(([^)]*)\))? \((\d{4}-\d{2}-\d{2})\)\s*$/u;
const SCOPED_BULLET = /^\* \*\*([^*]+?):\*\* (.*)$/u;
const TRAILING_CLOSES = /,?\s*closes\s+\[[^\]]+\]\([^)]*\)(?:[,\s]+\[[^\]]+\]\([^)]*\))*\s*$/u;
const TRAILING_HASH = /\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)\s*$/u;
const TRAILING_PR = /\s*\(\[#(\d+)\]\(([^)]*)\)\)\s*$/u;

/** The release page for a version, derived from the compare link the heading carries. */
function releasePage(compareUrl: string | undefined, version: string): string | undefined {
  const at = compareUrl?.indexOf('/compare/') ?? -1;
  return compareUrl === undefined || at < 0 ? undefined : `${compareUrl.slice(0, at)}/releases/tag/v${version}`;
}

function parseChange(first: string, continuation: readonly string[], kind: ChangeKind): ChangelogChange | undefined {
  const scoped = SCOPED_BULLET.exec(first);
  // A breaking-change body quotes the commits around it as plain bullets; only the scoped line is the change.
  if (scoped === null && kind === 'breaking') return undefined;
  const lead = scoped === null ? first.slice(2) : (scoped[2] ?? '');
  let text = [lead, ...continuation].join(' ').trim().replace(TRAILING_CLOSES, '').replace(TRAILING_HASH, '');
  // A subject may mention an earlier pull request before its own; the last link is the change's.
  let pr: RegExpExecArray | null = null;
  for (let next = TRAILING_PR.exec(text); next !== null; next = TRAILING_PR.exec(text)) {
    pr ??= next;
    text = text.replace(TRAILING_PR, '');
  }
  text = text.trim();
  if (text === '') return undefined;
  const change: { scope?: string; text: string; pr?: { number: number; url: string } } = { text };
  if (scoped?.[1] !== undefined) change.scope = scoped[1].trim();
  if (pr?.[1] !== undefined && pr[2] !== undefined) {
    change.pr = { number: Number(pr[1]), url: pr[2].replace('/issues/', '/pull/') };
  }
  return change;
}

function parseSection(lines: readonly string[]): readonly ChangelogGroup[] {
  const groups = new Map<ChangeKind, ChangelogChange[]>();
  let kind: ChangeKind | undefined;
  let bullet: { first: string; rest: string[] } | undefined;
  const flush = (): void => {
    if (bullet !== undefined && kind !== undefined) {
      const change = parseChange(bullet.first, bullet.rest, kind);
      if (change !== undefined) groups.set(kind, [...(groups.get(kind) ?? []), change]);
    }
    bullet = undefined;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('### ')) {
      flush();
      kind = GROUP_HEADINGS[line.slice(4).trim()]?.kind;
    } else if (line.startsWith('* ')) {
      flush();
      bullet = { first: line, rest: [] };
    } else if (line.trim() === '') {
      flush();
    } else if (bullet !== undefined) {
      bullet.rest.push(line.trim());
    }
  }
  flush();
  return GROUP_ORDER.flatMap(order => {
    const changes = groups.get(order);
    const title = Object.values(GROUP_HEADINGS).find(entry => entry.kind === order)?.title ?? order;
    return changes === undefined || changes.length === 0 ? [] : [{ kind: order, title, changes }];
  });
}

/** Every release in the text, newest first as the file lists them. A section with no changes is kept. */
export function parseChangelog(markdown: string): readonly ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let heading: RegExpExecArray | undefined;
  let body: string[] = [];
  const close = (): void => {
    if (heading === undefined) return;
    const [, version, compareUrl, date] = heading;
    if (version === undefined || date === undefined) return;
    releases.push({ version, date, releaseUrl: releasePage(compareUrl, version), groups: parseSection(body) });
  };
  for (const line of markdown.split('\n')) {
    const next = RELEASE_HEADING.exec(line);
    if (next !== null) {
      close();
      heading = next;
      body = [];
    } else if (heading !== undefined) {
      body.push(line);
    }
  }
  close();
  return releases;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "28 Oct 2026" from `2026-10-28`. A calendar day, so no timezone is ever applied. */
export function releaseDateLabel(date: string): string {
  const [year, month, day] = date.split('-');
  const name = MONTHS[Number(month) - 1];
  return name === undefined || day === undefined ? date : `${String(Number(day))} ${name} ${year ?? ''}`.trim();
}

/** The releases this build carries, parsed from the text the build stamped in; none when it stamped none. */
export function bundledReleases(): readonly ChangelogRelease[] {
  const stamped = typeof __FY_CHANGELOG__ === 'string' ? __FY_CHANGELOG__ : '';
  return stamped === '' ? [] : parseChangelog(stamped);
}

/** The versions strictly newer than the last one this device viewed. No baseline means nothing is new. */
export function newVersions(releases: readonly ChangelogRelease[], lastViewed: string | null): ReadonlySet<string> {
  if (lastViewed === null) return new Set();
  return new Set(
    releases.filter(release => compareProtocolVersions(release.version, lastViewed) === 1).map(r => r.version),
  );
}

/** The slice of `localStorage` the page uses. */
export interface ChangelogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_VIEWED_KEY = 'fy-whats-new-viewed-v1';

/** `localStorage`, or nothing: reading the property itself throws in some private modes. */
export function browserChangelogStorage(): ChangelogStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The newest version this device has viewed, or `null` when it has none or cannot say. */
export function readLastViewed(storage: ChangelogStorage | undefined): string | null {
  try {
    return storage?.getItem(LAST_VIEWED_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Records the version as viewed; a store that refuses is ignored. */
export function writeLastViewed(storage: ChangelogStorage | undefined, version: string): void {
  try {
    storage?.setItem(LAST_VIEWED_KEY, version);
  } catch {
    // The chip simply stays; nothing else depends on this write.
  }
}

/**
 * The baseline for a device that has never opened the page: the newest version it already has, so the
 * first release AFTER this one is what shows "New" — thirty old releases are not news.
 */
export function seedLastViewed(storage: ChangelogStorage | undefined, releases: readonly ChangelogRelease[]): void {
  const newest = releases[0]?.version;
  if (newest !== undefined && readLastViewed(storage) === null) writeLastViewed(storage, newest);
}
