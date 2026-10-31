import type { CopyClock } from './ports.ts';

/** The most documents kept per session for each list: enough for a ferret's working pages, never unbounded. */
const PER_SESSION = 64;

interface Held {
  readonly names: readonly string[];
  readonly navigationId: string;
  readonly until: number;
}

interface Seen {
  readonly names: readonly string[];
  readonly navigationId: string;
}

/**
 * WHAT SECURE COPY KNOWS ABOUT PAGES (docs/secure-copy.md, "Hiding"), by DOCUMENT: a page is known by its
 * surface names and the document it showed (the main frame's loader id, which every navigation changes).
 *
 * - `hold` / `documents`: a page a value was copied FROM. While it still shows that document, no picture of it
 *   is taken (no mask can be drawn on pixels); its text stays readable, masked. A hold ends when the copy's mask
 *   does, at the latest, and the moment the page shows another document it no longer matches.
 * - `saw` / `seen`: a document the agent read, screenshotted or evaluated. A copy read from a document the agent
 *   had already seen says so (`exposure.pageReadBeforeCapture`), because masking cannot take back what it read.
 *
 * Kept in memory only, like the copies: a daemon restart forgets both, as it forgets every copy.
 */
export class PageCopyRecords {
  private readonly holds = new Map<string, readonly Held[]>();
  private readonly reads = new Map<string, readonly Seen[]>();

  constructor(private readonly clock: CopyClock) {}

  /** A value was copied from this page's document: pictures of it wait until `until` or a navigation. */
  hold(sessionId: string, names: readonly (string | undefined)[], navigationId: string, until: number): void {
    const now = this.clock.now();
    const live = (this.holds.get(sessionId) ?? []).filter(held => held.until > now);
    this.holds.set(sessionId, [...live, { names: known(names), navigationId, until }].slice(-PER_SESSION));
  }

  /** The documents of this page a value was copied from, still held. */
  documents(sessionId: string, names: readonly (string | undefined)[]): readonly string[] {
    const now = this.clock.now();
    const wanted = known(names);
    return (this.holds.get(sessionId) ?? [])
      .filter(held => held.until > now && held.names.some(name => wanted.includes(name)))
      .map(held => held.navigationId);
  }

  /** The agent read, screenshotted or evaluated this page while it showed `navigationId`. */
  saw(sessionId: string, names: readonly (string | undefined)[], navigationId: string): void {
    const kept = (this.reads.get(sessionId) ?? []).filter(seen => seen.navigationId !== navigationId);
    this.reads.set(sessionId, [...kept, { names: known(names), navigationId }].slice(-PER_SESSION));
  }

  /** The documents of this page the agent has read. */
  seen(sessionId: string, names: readonly (string | undefined)[]): readonly string[] {
    const wanted = known(names);
    return (this.reads.get(sessionId) ?? [])
      .filter(seen => seen.names.some(name => wanted.includes(name)))
      .map(seen => seen.navigationId);
  }

  /** The session ended: nothing about its pages is kept. */
  drop(sessionId: string): void {
    this.holds.delete(sessionId);
    this.reads.delete(sessionId);
  }
}

const known = (names: readonly (string | undefined)[]): readonly string[] =>
  names.filter((name): name is string => name !== undefined && name !== '');
