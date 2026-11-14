/**
 * WHICH PAGE A FERRET'S VIEWER MAY SEE, as a permission that can be checked SYNCHRONOUSLY where a frame leaves.
 *
 * The rule itself is asked once, asynchronously, through the one function every agent path to a page uses
 * (`BrowserTools.assertAgentMay`, behind `FerretBrowserGuard.check`). What this adds is the stamp: a page's permission is a
 * generation. A frame is stamped with the generation when it ARRIVES; the answer to the rule is recorded for the generation
 * it was asked under; and the permission is valid only while the page's generation has not moved since — so a takeover, or a
 * page closing, that lands while the rule is being asked, while `kernel.act` is pending, or while a frame waits in a
 * congested socket's buffer, makes the frame invalid with no new frame needed. A revocation also ends every stream of that
 * page at once. It is checked again on a timer for what has no event (the owner's "What agents may control" switch).
 */

/** The sentence a ferret's viewer ends with when the page is no longer one it may watch. */
export const VIEWER_SCOPE_REFUSAL =
  'This page is no longer yours to watch: a person has taken it over, or it is not yours.';

export interface ViewerScopePorts {
  /** THE rule: whether this ferret may use this page of its own browser now. Never throws; a refusal is `false`. */
  readonly may: (ferret: string, page: string) => Promise<boolean>;
  /** Runs `action` once after `milliseconds`; returns what cancels it. */
  readonly after: (milliseconds: number, action: () => void) => () => void;
}

/** What a frame is stamped with when it arrives. */
export interface ViewerScopeStamp {
  readonly key: string;
  readonly generation: number;
}

/** How often a watched page's permission is asked again, for what raises no event. */
export const VIEWER_RECHECK_MS = 1_000;

export class ViewerScope {
  private readonly generations = new Map<string, number>();
  /** The generation a page's permission was last PROVED under; absent when it has not been, or was withdrawn. */
  private readonly proved = new Map<string, number>();
  private readonly asking = new Map<string, Promise<boolean>>();
  private readonly listeners = new Set<(ferret: string, page: string) => void>();

  constructor(private readonly ports: ViewerScopePorts) {}

  private static keyOf = (ferret: string, page: string): string => `${ferret}\u0000${page}`;
  private generation = (key: string): number => this.generations.get(key) ?? 0;

  /** Taken where a frame ARRIVES, before anything is awaited. */
  stamp(ferret: string, page: string): ViewerScopeStamp {
    const key = ViewerScope.keyOf(ferret, page);
    return { key, generation: this.generation(key) };
  }

  /** Synchronous, and the only thing asked where bytes leave: proved, and nothing has withdrawn it since the stamp. */
  valid(stamp: ViewerScopeStamp): boolean {
    return stamp.generation === this.generation(stamp.key) && this.proved.get(stamp.key) === stamp.generation;
  }

  /**
   * Proves the permission for the page under its current generation (asking the rule when it is not already proved),
   * or withdraws it when the rule refuses. Frames that arrive while it is being asked share the one question.
   */
  async admit(ferret: string, page: string, fresh = false): Promise<boolean> {
    const key = ViewerScope.keyOf(ferret, page);
    const generation = this.generation(key);
    if (!fresh && this.proved.get(key) === generation) return true;
    const pending = this.asking.get(key) ?? this.ports.may(ferret, page).catch(() => false);
    this.asking.set(key, pending);
    let allowed: boolean;
    try {
      allowed = await pending;
    } finally {
      if (this.asking.get(key) === pending) this.asking.delete(key);
    }
    if (!allowed) {
      this.revoke(ferret, page);
      return false;
    }
    // Withdrawn while the rule was being asked: the answer is for a state that is gone.
    if (this.generation(key) !== generation) return false;
    this.proved.set(key, generation);
    return true;
  }

  /** The permission to see this page is withdrawn, now: every viewer of it ends before another byte. */
  revoke(ferret: string, page: string): void {
    const key = ViewerScope.keyOf(ferret, page);
    this.generations.set(key, this.generation(key) + 1);
    this.proved.delete(key);
    for (const listener of [...this.listeners]) listener(ferret, page);
  }

  /** Told, synchronously, whenever a permission is withdrawn. Returns what stops listening. */
  onRevoked(listener: (ferret: string, page: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks the rule again every {@link VIEWER_RECHECK_MS} for as long as the viewer lives, for the page it last watched. */
  recheck(ferret: string, page: () => string | undefined): () => void {
    let cancel: (() => void) | undefined;
    let stopped = false;
    const tick = (): void => {
      cancel = this.ports.after(VIEWER_RECHECK_MS, () => {
        const watched = page();
        const again = (): void => {
          if (!stopped) tick();
        };
        if (watched === undefined) return again();
        void this.admit(ferret, watched, true).finally(again);
      });
    };
    tick();
    return () => {
      stopped = true;
      cancel?.();
    };
  }
}
