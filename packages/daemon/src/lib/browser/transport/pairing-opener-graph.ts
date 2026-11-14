/**
 * WHO OPENED WHOM in one browser context, remembered after the window that did is gone (docs/pairing.md, "Never show it to
 * an agent").
 *
 * A script on a page reaches the documents of its opener and popups, and through a window it holds the whole browsing-context
 * group. Closing a window revokes none of that for the windows that survive it: `a` opens `b`, `b` opens `c`, `b` closes, and
 * `c` still reaches `a` (a handle passed before `b` went, a named-window lookup). So the graph keeps every edge it has seen
 * until EVERY page of the component it belongs to is gone, not only the edges of the pages that are open now.
 *
 * It also keeps what it could not find out. A page whose opener lookup failed (rejected, timed out) is of UNKNOWN
 * parentage, and an unknown relationship is never read as "opened by nobody": while one is open, every page of the context
 * counts as reachable from it, because a miss would hand an agent a credential where an extra page only refuses one read.
 */
export interface PairingGroup {
  /** The other OPEN pages of the group, in the order `live` gave them. */
  readonly live: readonly string[];
  /** Every page of the group, the asked page, the ones that closed and the open ones: what the ledger is asked about. */
  readonly keys: readonly string[];
}

export class PairingOpenerGraph {
  /** Page → the page that opened it, kept after either has closed. */
  private readonly edges = new Map<string, string>();
  /** Pages whose opener could not be found out, and have not been since. */
  private readonly unknown = new Set<string>();

  /** A page's opener was found out: the page it was opened by, or none for a page nobody opened. */
  record(page: string, opener: string | undefined): void {
    if (opener === undefined) return;
    this.edges.set(page, opener);
    this.unknown.delete(page);
  }

  /**
   * A page's opener could not be found out. That is never "no opener": it stays unknown until a later lookup finds the
   * page's opener, because a null answer cannot tell a page nobody opened from one whose opener has since closed.
   */
  failed(page: string): void {
    this.unknown.add(page);
  }

  /** Whether the page's opener is still unknown. */
  isUnknown(page: string): boolean {
    return this.unknown.has(page);
  }

  /**
   * The group of `page` among the pages open now (`live`, which may or may not include it): everything tied to it by an
   * opener edge, transitively both ways, through pages that have closed. A group with an unknown page in it is every page of
   * the context. Forgets the edges of every component that no longer has an open page.
   */
  group(page: string, live: readonly string[]): PairingGroup {
    const parent = new Map<string, string>();
    const root = (key: string): string => {
      let top = key;
      for (let next = parent.get(top); next !== undefined && next !== top; next = parent.get(top)) top = next;
      return top;
    };
    const add = (key: string): void => {
      if (!parent.has(key)) parent.set(key, key);
    };
    for (const key of [page, ...live]) add(key);
    for (const [child, opener] of this.edges) {
      add(child);
      add(opener);
      parent.set(root(child), root(opener));
    }
    const alive = new Set([page, ...live].map(root));
    for (const child of [...this.edges.keys()]) if (!alive.has(root(child))) this.edges.delete(child);
    for (const key of [...this.unknown]) if (!parent.has(key) || !alive.has(root(key))) this.unknown.delete(key);
    const everything = this.unknown.size > 0;
    const together = (key: string): boolean => everything || root(key) === root(page);
    return {
      live: live.filter(key => key !== page && together(key)),
      keys: [...parent.keys()].filter(together),
    };
  }
}

/** How long one opener lookup may take before it reads as failed. */
const PAIRING_OPENER_LOOKUP_MS = 5_000;

/**
 * Finds out who opened `page` and records it. Never throws: a lookup that rejects, throws or takes longer than `limitMs`
 * is recorded as FAILED (unknown parentage, see {@link PairingOpenerGraph.failed}), never as "opened by nobody".
 */
export async function lookUpOpener(
  graph: PairingOpenerGraph,
  page: string,
  find: () => Promise<string | undefined>,
  limitMs: number = PAIRING_OPENER_LOOKUP_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      find(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the opener lookup took too long')), limitMs);
      }),
    ]);
    graph.record(page, found);
  } catch {
    graph.failed(page);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
