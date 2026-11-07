import type { CopyClock } from './ports.ts';

/** The most documents a session's READS are kept for: enough for a ferret's working pages, never unbounded. */
const READS_PER_SESSION = 64;

interface Held {
  /** The copy it is held for: it ends when that copy's mask does, discarded or not. */
  readonly copy: string;
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
 *   is taken (no mask can be drawn on pixels); its text stays readable, masked. A hold ends when its copy's mask
 *   does (`retime` brings that forward for a discarded copy), and the moment the page shows another document it
 *   no longer matches. A live hold is never dropped to make room: a session's copies are bounded already.
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
  hold(
    sessionId: string,
    copy: string,
    names: readonly (string | undefined)[],
    navigationId: string,
    until: number,
  ): void {
    const now = this.clock.now();
    const live = (this.holds.get(sessionId) ?? []).filter(held => held.until > now);
    this.holds.set(sessionId, [...live, { copy, names: known(names), navigationId, until }]);
  }

  /** The copy's mask now ends at `until` (it was discarded): its holds end then too, never later than they were. */
  retime(sessionId: string, copy: string, until: number): void {
    const holds = this.holds.get(sessionId);
    if (holds === undefined) return;
    this.holds.set(
      sessionId,
      holds.map(held => (held.copy === copy ? { ...held, until: Math.min(held.until, until) } : held)),
    );
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
    this.reads.set(sessionId, [...kept, { names: known(names), navigationId }].slice(-READS_PER_SESSION));
  }

  /** The documents of this page the agent has read. */
  seen(sessionId: string, names: readonly (string | undefined)[]): readonly string[] {
    const wanted = known(names);
    return (this.reads.get(sessionId) ?? [])
      .filter(seen => seen.names.some(name => wanted.includes(name)))
      .map(seen => seen.navigationId);
  }

  /** Every session anything is kept for, so a sweep can let go of the ones that ended. */
  sessions(): readonly string[] {
    return [...new Set([...this.holds.keys(), ...this.reads.keys()])];
  }

  /** The session ended: nothing about its pages is kept. */
  drop(sessionId: string): void {
    this.holds.delete(sessionId);
    this.reads.delete(sessionId);
  }
}

const known = (names: readonly (string | undefined)[]): readonly string[] =>
  names.filter((name): name is string => name !== undefined && name !== '');
