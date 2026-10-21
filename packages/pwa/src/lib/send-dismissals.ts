/**
 * SOLE OWNER of the `fy-dismissed-sends-v1` browser-storage key: which of the reader's undelivered
 * messages THIS DEVICE has chosen to stop looking at, and which settled notes the reader opened.
 *
 * A cancelled or given-up message is not news the reader owes anything to, yet it used to sit under the
 * conversation until a day had passed. Dismissing one removes it from view — only from view: the
 * daemon's ledger is append-only and is never told. So the choice is the device's, keyed by SEND ID (an
 * id is unique across daemons, so it needs no scope), and remembered across reloads.
 *
 * Two kinds of state, with different lifetimes:
 *   * DISMISSED — persisted. Entries age out after {@link DISMISSED_SEND_LIFETIME_MS} (the ledger stops
 *     showing a settled send long before that) and the newest {@link MAX_DISMISSED_SENDS} are kept.
 *   * EXPANDED — this tab only. A note the reader opened stays on screen past its auto-hide for as long
 *     as the page lives; nothing is written.
 *
 * Shape follows `table-view-preference.ts`: an injected storage, a defensive parse, a denied storage
 * treated as an ordinary browser condition, one identity-stable snapshot for `useSyncExternalStore`.
 */

/** The sole browser-storage key for dismissed sends. */
export const SEND_DISMISSALS_KEY = 'fy-dismissed-sends-v1';
export const SEND_DISMISSALS_VERSION = 1;
export const MAX_DISMISSED_SENDS = 500;
export const DISMISSED_SEND_LIFETIME_MS = 30 * 24 * 60 * 60_000;

export interface SendDismissalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What the transcript consults when it places the ledger's rows. */
export interface SendViewState {
  readonly dismissed: ReadonlySet<string>;
  readonly expanded: ReadonlySet<string>;
}

export const EMPTY_SEND_VIEW: SendViewState = { dismissed: new Set(), expanded: new Set() };

/** Send id → the instant it was dismissed. */
type DismissedAt = Readonly<Record<string, number>>;

/** Anything unreadable — a stale version, hand-edited JSON, a non-instant value — resets to nothing dismissed. */
export const parseDismissed = (raw: string | null | undefined, nowMs: number): DismissedAt => {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const value = parsed as { v?: unknown; dismissed?: unknown };
  if (value.v !== SEND_DISMISSALS_VERSION || value.dismissed === null || typeof value.dismissed !== 'object') return {};
  const kept: Record<string, number> = {};
  for (const [id, at] of Object.entries(value.dismissed as Record<string, unknown>)) {
    if (id === '' || typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (nowMs - at >= DISMISSED_SEND_LIFETIME_MS) continue;
    kept[id] = at;
  }
  return kept;
};

/** The newest `max` dismissals; the oldest fall away first. */
export const newestDismissed = (dismissed: DismissedAt, max: number = MAX_DISMISSED_SENDS): DismissedAt => {
  const ids = Object.keys(dismissed);
  if (ids.length <= max) return dismissed;
  const kept: Record<string, number> = {};
  for (const id of ids.sort((a, b) => (dismissed[b] ?? 0) - (dismissed[a] ?? 0)).slice(0, max)) {
    kept[id] = dismissed[id] as number;
  }
  return kept;
};

const browserStorage = (): SendDismissalStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: SendDismissalStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** This device's dismissed sends and opened notes, shaped for `useSyncExternalStore`. */
export class SendDismissalStore {
  readonly #storage: SendDismissalStorage | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #dismissed: DismissedAt | null = null;
  #expanded: ReadonlySet<string> = new Set();
  #view: SendViewState | null = null;

  constructor(storage: SendDismissalStorage | undefined = browserStorage(), now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  /** The view in force; the first read hydrates from storage. The object only changes when something did. */
  snapshot = (): SendViewState => {
    this.#view ??= this.#build();
    return this.#view;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Stops showing these sends. A failed write still hides them for the rest of the tab. */
  dismiss(sendIds: readonly string[]): void {
    const current = this.#hydrated();
    const fresh = sendIds.filter(id => id !== '' && current[id] === undefined);
    if (fresh.length === 0) return;
    const at = this.#now();
    const next: Record<string, number> = { ...current };
    for (const id of fresh) next[id] = at;
    this.#dismissed = newestDismissed(next);
    // Opening a note and then dismissing it leaves nothing to keep open.
    this.#expanded = new Set([...this.#expanded].filter(id => !fresh.includes(id)));
    this.#persist();
    this.#changed();
  }

  /** Opens (`true`) or closes (`false`) one settled note. Remembered for this tab only. */
  setExpanded(sendId: string, open: boolean): void {
    if (this.#expanded.has(sendId) === open) return;
    const next = new Set(this.#expanded);
    if (open) next.add(sendId);
    else next.delete(sendId);
    this.#expanded = next;
    this.#changed();
  }

  #hydrated(): DismissedAt {
    if (this.#dismissed !== null) return this.#dismissed;
    try {
      this.#dismissed = parseDismissed(this.#storage?.getItem(SEND_DISMISSALS_KEY), this.#now());
    } catch {
      this.#dismissed = {};
    }
    return this.#dismissed;
  }

  #build(): SendViewState {
    return { dismissed: new Set(Object.keys(this.#hydrated())), expanded: this.#expanded };
  }

  #persist(): void {
    try {
      this.#storage?.setItem(
        SEND_DISMISSALS_KEY,
        JSON.stringify({ v: SEND_DISMISSALS_VERSION, dismissed: this.#dismissed }),
      );
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
  }

  #changed(): void {
    this.#view = this.#build();
    for (const listener of this.#listeners) listener();
  }
}
