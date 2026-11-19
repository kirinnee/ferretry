import type { DIFF_SIDES, ReviewThread } from '../../../contract/index.ts';

export type DiffSide = (typeof DIFF_SIDES)[number];

/**
 * What E5's diff viewer knows about the rows it drew: whether a file's old (`left`) or new (`right`) line number is a row
 * of a hunk. E5 owns the hunk parser (`pulls/lib/diff-hunks.ts`); this is the one question E6 asks of it.
 */
export interface DiffRows {
  hasLine(path: string, side: DiffSide, line: number): boolean;
}

/** Where threads go: on a diff row, or in a list. Nothing is ever dropped. */
export interface Placement {
  /** Threads drawn under a diff row, keyed by file, side and line. */
  readonly onLine: ReadonlyMap<string, readonly ReviewThread[]>;
  /** The line they were made on no longer exists in the current diff (GitHub says so): listed, never placed. */
  readonly outdated: readonly ReviewThread[];
  /** Not outdated, but no row of the diff drawn here has their line (a file not in the diff, a collapsed gap, no line). */
  readonly elsewhere: readonly ReviewThread[];
}

const rowKey = (path: string, side: DiffSide, line: number): string => `${path}\u0000${side}:${line}`;

const firstTime = (thread: ReviewThread): string => thread.comments[0]?.createdAt ?? '';

/**
 * Sorts every thread to where it belongs. A thread sits under the LAST line of the range it was made on (GitHub's own
 * placement), on the side it was made on: an old-side thread on a deleted line is not drawn on a new-side row that has
 * the same number.
 */
export function placeThreads(threads: readonly ReviewThread[], rows: DiffRows): Placement {
  const onLine = new Map<string, ReviewThread[]>();
  const outdated: ReviewThread[] = [];
  const elsewhere: ReviewThread[] = [];
  for (const thread of threads) {
    if (thread.outdated) outdated.push(thread);
    else if (thread.line === undefined || !rows.hasLine(thread.path, thread.side, thread.line)) elsewhere.push(thread);
    else {
      const key = rowKey(thread.path, thread.side, thread.line);
      onLine.set(key, [...(onLine.get(key) ?? []), thread]);
    }
  }
  const byTime = (a: ReviewThread, b: ReviewThread): number => firstTime(a).localeCompare(firstTime(b));
  for (const list of onLine.values()) list.sort(byTime);
  return { onLine, outdated: outdated.sort(byTime), elsewhere: elsewhere.sort(byTime) };
}

/** The threads under one diff row: what E5's viewer asks for as it draws that row. */
export const threadsAt = (placement: Placement, path: string, side: DiffSide, line: number): readonly ReviewThread[] =>
  placement.onLine.get(rowKey(path, side, line)) ?? [];

/** A link is only shown for an `https://github.com` address: a thread's `url` is data from GitHub, never trusted as a scheme. */
export const safeGithubUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};
