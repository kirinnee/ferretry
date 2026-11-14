/**
 * WHERE A PAGE HAS BEEN, as the BROWSER saw it happen (docs/pairing.md, "Never show it to an agent").
 *
 * Kept by the worker from DevTools' own frame events (`Page.frameNavigated`, `Page.navigatedWithinDocument`,
 * `Page.frameAttached`, `Page.frameDetached`) and Playwright's mirror of them for frames in other processes: nothing a
 * page script runs can write it, and a navigation or a frame swap leaves a mark behind it that the DOM does not — the
 * document that held a code is gone, its history here is not. The daemon asks for it with every page document check and
 * compares two answers: a changed {@link NavigationEvidence.seq} says the page or one of its frames moved between them.
 */

/** One origin the target's frames have committed, with when it first did and the last move that touched it. */
interface CommittedOrigin {
  /** `scheme://host[:port]`, `null` for an opaque origin (`about:blank`, `data:`), `?` for an address nobody could read. */
  readonly origin: string;
  /** Epoch milliseconds of the first commit of this origin in the target's life. */
  readonly firstAt: number;
  /** The {@link NavigationEvidence.seq} of the latest event that committed it. */
  readonly lastSeq: number;
}

/**
 * WHAT THE WORKER HAS COUNTED ACROSS EVERY PAGE IT HAS EVER WATCHED, the closed and the departed ones included. Held by the
 * worker (not by any one page's ledger), so a page that leaves the group or closes takes none of it away, and only ever
 * going up, so an operation that overlapped a change can always tell.
 */
export interface NavigationTotals {
  /**
   * Addresses that carried the pairing-fragment grammar, committed by any frame of any page, counted under their origin
   * (`null` for an opaque one, `?` for one nobody could read). Past {@link MAX_COMMITTED_ORIGINS} origins the rest are
   * counted under {@link TOTALS_OVERFLOW}, which a reader takes for every origin.
   */
  readonly links: Readonly<Record<string, number>>;
  /**
   * How many times the worker lost track of a page's navigation (a page it could not watch, a frame event it could not
   * read, an origin it had to forget). Non-zero is BLIND for the rest of the worker's life: a missed address could have
   * been a pairing link, so the history cannot be proved complete until a fresh worker starts a fresh ledger.
   */
  readonly lost: number;
}

/** The bucket for every origin past the bound: a reader takes it for every origin, so the bound can only refuse more. */
export const TOTALS_OVERFLOW = '*';

/** The worker's {@link NavigationTotals}, shared by every page's {@link NavigationLedger}. Pure state. */
export class NavigationTotalsLedger {
  readonly #links = new Map<string, number>();
  #lost = 0;

  /** A frame committed an address carrying the pairing grammar. */
  linked(origin: string): void {
    const key = this.#links.has(origin) || this.#links.size < MAX_COMMITTED_ORIGINS ? origin : TOTALS_OVERFLOW;
    this.#links.set(key, (this.#links.get(key) ?? 0) + 1);
  }

  /** A navigation could not be followed. */
  lost(): void {
    this.#lost += 1;
  }

  snapshot(): NavigationTotals {
    return { links: Object.fromEntries(this.#links), lost: this.#lost };
  }
}

/** Two answers about the same worker, as one: the larger of every count (they only ever go up). */
export function mergeTotals(first: NavigationTotals, second: NavigationTotals): NavigationTotals {
  const links: Record<string, number> = { ...first.links };
  for (const [origin, count] of Object.entries(second.links)) links[origin] = Math.max(links[origin] ?? 0, count);
  return { links, lost: Math.max(first.lost, second.lost) };
}

export interface NavigationEvidence {
  /** Counts every frame event this target has seen, and only goes up. Equal across two looks: nothing moved. */
  readonly seq: number;
  /** Every origin a frame of the target committed, bounded; see {@link NavigationEvidence.overflow}. */
  readonly origins: readonly CommittedOrigin[];
  /** More origins than the bound were committed: the earliest are forgotten, so a reader must not rely on absence. */
  readonly overflow: boolean;
  /** The origins of the frames this target has right now (the main frame first), one entry per frame. */
  readonly frames: readonly string[];
  /**
   * The {@link NavigationEvidence.seq} of the latest event whose address, in any frame, carried the pairing-fragment
   * grammar; `0` when none ever did. Non-zero for the rest of the target's life, even after the address is replaced.
   */
  readonly taintSeq: number;
  /** Epoch milliseconds the ledger began watching: a commit before it is not in `origins`. */
  readonly watchedSince: number;
  /** The worker's totals over every page (see {@link NavigationTotals}); the same whichever page is asked. */
  readonly totals: NavigationTotals;
}

/** The most distinct origins one target is remembered to have committed. A page hand-built to exceed it is `overflow`. */
export const MAX_COMMITTED_ORIGINS = 64;

/** The shape of the CDP events and of the page the ledger listens to, so a test can drive it without a browser. */
export interface NavigationSource {
  on(event: string, listener: (params: never) => void): unknown;
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * Whether a fragment reads as a pairing link or carries a credential part. A SUPERSET of the daemon's address rule
 * (`../../address-rule.ts`, which owns the fact): spelled here because the worker is a process that does not load the
 * kernel, and wider on purpose — a taint only refuses an agent's script on this one target, so too wide costs a script.
 */
export function carriesCredentialFragment(fragment: string): boolean {
  let text = fragment;
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(/%([0-9a-f]{2})/giu, (sequence, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code < 0x80 ? String.fromCharCode(code) : sequence;
    });
    if (next === text) break;
    text = next;
  }
  const normal = text.replace(/[\u200b-\u200d\u2060\ufeff]/gu, '').toLowerCase();
  return [normal.replace(/\s+/gu, ''), normal.trim().replace(/\s+/gu, ';')].some(
    reading => /(?:^|[#;&])v1(?:[;&]|$)/u.test(reading) || /(?:^|[#;&])(?:c|code|share)=/u.test(reading),
  );
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** `scheme://host[:port]`; `null` for an opaque origin; `?` when the address cannot be read at all. */
export function originOf(address: string): string {
  try {
    const { origin } = new URL(address);
    return origin;
  } catch {
    return '?';
  }
}

/** One target's navigation history. Pure state: fed by {@link NavigationLedger.attach} or by its `commit*` methods. */
export class NavigationLedger {
  #seq = 0;
  readonly #origins = new Map<string, { firstAt: number; lastSeq: number }>();
  readonly #frames = new Map<string, string>();
  #mainFrame: string | undefined;
  #overflow = false;
  #taintSeq = 0;
  readonly #watchedSince: number;

  constructor(
    private readonly now: () => number,
    private readonly totals: NavigationTotalsLedger = new NavigationTotalsLedger(),
  ) {
    this.#watchedSince = now();
  }

  /** The ledger lost track of where the page is: counted for the whole worker, and a never-matching origin is noted. */
  lose(): void {
    this.totals.lost();
    this.commit('?', '?:unreadable');
  }

  /** A frame committed an address (DevTools: `frameNavigated`, or `navigatedWithinDocument` for a hash or a pushState). */
  commit(frameId: string, address: string, main?: boolean): void {
    this.#seq += 1;
    const origin = originOf(address);
    if (main === true) this.#mainFrame = frameId;
    this.#frames.set(frameId, origin);
    const known = this.#origins.get(origin);
    if (known !== undefined) known.lastSeq = this.#seq;
    else if (this.#origins.size >= MAX_COMMITTED_ORIGINS) this.#overflow = true;
    else this.#origins.set(origin, { firstAt: this.now(), lastSeq: this.#seq });
    const hash = address.indexOf('#');
    if (hash >= 0 && carriesCredentialFragment(address.slice(hash))) {
      this.#taintSeq = this.#seq;
      this.totals.linked(origin);
    }
  }

  /** A frame appeared. Its address is not known until it commits one. */
  attached(frameId: string): void {
    this.#seq += 1;
    if (!this.#frames.has(frameId)) this.#frames.set(frameId, 'null');
  }

  /** A frame went away: its documents are gone, and this ledger is what is left of what they were. */
  detached(frameId: string): void {
    this.#seq += 1;
    this.#frames.delete(frameId);
  }

  evidence(): NavigationEvidence {
    const frames = [...this.#frames.entries()]
      .sort(([left], [right]) => (left === this.#mainFrame ? -1 : right === this.#mainFrame ? 1 : 0))
      .map(([, origin]) => origin);
    return {
      seq: this.#seq,
      origins: [...this.#origins.entries()].map(([origin, seen]) => ({ origin, ...seen })),
      overflow: this.#overflow,
      frames,
      taintSeq: this.#taintSeq,
      watchedSince: this.#watchedSince,
      totals: this.totals.snapshot(),
    };
  }

  /**
   * Starts listening on a page's DevTools session and seeds the ledger from the frame tree as it is now, so a page that
   * had already moved before the ledger began still counts. A tree that cannot be read is a ledger that cannot prove
   * where the page is: {@link NavigationLedger.seed} marks it unreadable (an origin of `?`) rather than empty.
   */
  async attach(session: NavigationSource): Promise<void> {
    session.on('Page.frameNavigated', ((params: unknown) => this.#navigated(params)) as never);
    session.on('Page.navigatedWithinDocument', ((params: unknown) => {
      const event = objectOf(params);
      if (typeof event.frameId === 'string' && typeof event.url === 'string') this.commit(event.frameId, event.url);
    }) as never);
    session.on('Page.frameAttached', ((params: unknown) => {
      const id = objectOf(params).frameId;
      if (typeof id === 'string') this.attached(id);
    }) as never);
    session.on('Page.frameDetached', ((params: unknown) => {
      const id = objectOf(params).frameId;
      if (typeof id === 'string') this.detached(id);
    }) as never);
    await session.send('Page.enable');
    try {
      this.#seed(objectOf(await session.send('Page.getFrameTree')).frameTree);
    } catch {
      this.lose();
    }
  }

  #navigated(params: unknown): void {
    const frame = objectOf(objectOf(params).frame);
    if (typeof frame.id !== 'string' || typeof frame.url !== 'string') {
      this.lose();
      return;
    }
    const fragment = typeof frame.urlFragment === 'string' ? frame.urlFragment : '';
    this.commit(frame.id, frame.url + fragment, typeof frame.parentId !== 'string');
  }

  #seed(tree: unknown): void {
    const node = objectOf(tree);
    const frame = objectOf(node.frame);
    if (typeof frame.id !== 'string' || typeof frame.url !== 'string') {
      this.lose();
      return;
    }
    const fragment = typeof frame.urlFragment === 'string' ? frame.urlFragment : '';
    this.commit(frame.id, frame.url + fragment, typeof frame.parentId !== 'string');
    if (Array.isArray(node.childFrames)) for (const child of node.childFrames) this.#seed(child);
  }
}

const MAX_ORIGIN_CHARS = 300;
const MAX_FRAMES = 256;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isOrigin = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= MAX_ORIGIN_CHARS;
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);

/**
 * The daemon's belief in a worker's {@link NavigationEvidence}: ONLY its exact shape, every count a safe whole number,
 * every origin short, every list bounded, no member the type does not name. `undefined` is "the browser did not say" —
 * and a guard that reads it refuses (fail closed).
 */
export function parseNavigationEvidence(raw: unknown): NavigationEvidence | undefined {
  const value = objectOf(raw);
  if (!hasOnly(value, ['seq', 'origins', 'overflow', 'frames', 'taintSeq', 'watchedSince', 'totals'])) return undefined;
  const { seq, origins, overflow, frames, taintSeq, watchedSince } = value;
  const totals = parseTotals(value.totals);
  if (totals === undefined) return undefined;
  if (!isCount(seq) || !isCount(watchedSince) || !isCount(taintSeq) || taintSeq > seq) return undefined;
  if (typeof overflow !== 'boolean') return undefined;
  if (!Array.isArray(origins) || origins.length > MAX_COMMITTED_ORIGINS) return undefined;
  if (!Array.isArray(frames) || frames.length > MAX_FRAMES || !frames.every(isOrigin)) return undefined;
  const parsed: CommittedOrigin[] = [];
  const seen = new Set<string>();
  for (const entry of origins) {
    const each = objectOf(entry);
    if (!hasOnly(each, ['origin', 'firstAt', 'lastSeq'])) return undefined;
    if (!isOrigin(each.origin) || !isCount(each.firstAt) || !isCount(each.lastSeq) || each.lastSeq > seq)
      return undefined;
    if (seen.has(each.origin)) return undefined;
    seen.add(each.origin);
    parsed.push({ origin: each.origin, firstAt: each.firstAt, lastSeq: each.lastSeq });
  }
  return { seq, origins: parsed, overflow, frames: [...(frames as string[])], taintSeq, watchedSince, totals };
}

/** The worker's {@link NavigationTotals}: only the exact shape, every count a safe whole number, the list bounded. */
function parseTotals(raw: unknown): NavigationTotals | undefined {
  const value = objectOf(raw);
  if (!hasOnly(value, ['links', 'lost']) || !isCount(value.lost)) return undefined;
  if (value.links === null || typeof value.links !== 'object' || Array.isArray(value.links)) return undefined;
  const entries = Object.entries(value.links as Record<string, unknown>);
  if (entries.length > MAX_COMMITTED_ORIGINS + 1) return undefined;
  const links: Record<string, number> = {};
  for (const [origin, count] of entries) {
    if (!isOrigin(origin) || !isCount(count)) return undefined;
    links[origin] = count;
  }
  return { links, lost: value.lost };
}
