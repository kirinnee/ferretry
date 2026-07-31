/**
 * SOLE OWNER of the `fy-side-pane-v1` browser-storage key.
 *
 * Ported from kteam `ui/src/lib/side-pane-preferences.ts`. Pane width is a
 * reader/layout preference, not session content: every session opens at the
 * same comfortable width, while the active surface stays session-scoped in the
 * pane itself. The contract kteam settled on is kept intact —
 *   - an explicit payload version,
 *   - defensive field-by-field parsing,
 *   - storage denial treated as an ordinary browser condition,
 *   - one in-memory snapshot shared by every retained session workspace.
 *
 * Deliberately NOT daemon-scoped. Width is a property of the reader's screen,
 * not of a daemon, so `(daemonId, …)` keying would be wrong here: switching
 * daemons must not resize the pane. Everything that carries daemon *data*
 * (the pane's active surface, its contents) is keyed in `daemon-scope.ts`.
 *
 * kteam kept the snapshot and the listener set in module globals with a
 * `resetSidePanePreferences()` test seam. This port makes them instance state
 * on `SidePanePreferenceStore` with the storage injected, matching
 * `DaemonDraftStore`: a fresh store per test needs no reset hook.
 */

/** The sole browser-storage key for side-pane layout preferences. */
export const SIDE_PANE_PREFERENCES_KEY = 'fy-side-pane-v1';
export const SIDE_PANE_PREFERENCES_VERSION = 1;

/**
 * Absolute desktop bounds. The effective maximum is lower when necessary to
 * preserve `SIDE_PANE_MIN_CHAT_WIDTH` beside the pane.
 */
export const SIDE_PANE_MIN_WIDTH = 320;
export const SIDE_PANE_MAX_WIDTH = 1024;
export const SIDE_PANE_DEFAULT_WIDTH = 520;
/**
 * The pane is the reader's active surface while open. Keep enough chat visible
 * for context and controls, but let a tablet/landscape reader pull the divider
 * materially farther left. Portrait phones use the full-width sheet instead.
 */
export const SIDE_PANE_MIN_CHAT_WIDTH = 280;
export const SIDE_PANE_WORKSPACE_GAP = 8;

export interface SidePanePreferences {
  readonly v: typeof SIDE_PANE_PREFERENCES_VERSION;
  readonly width: number;
}

export const DEFAULT_SIDE_PANE_PREFERENCES: SidePanePreferences = Object.freeze({
  v: SIDE_PANE_PREFERENCES_VERSION,
  width: SIDE_PANE_DEFAULT_WIDTH,
});

export const clampSidePaneWidth = (width: number): number => {
  if (!Number.isFinite(width)) return SIDE_PANE_DEFAULT_WIDTH;
  return Math.min(SIDE_PANE_MAX_WIDTH, Math.max(SIDE_PANE_MIN_WIDTH, Math.round(width)));
};

/**
 * Defensive parse: an unknown version or a non-object is a clean reset; a bad
 * field falls back independently and unknown fields are ignored.
 */
export const parseSidePanePreferences = (raw: string | null | undefined): SidePanePreferences => {
  if (!raw) return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  }
  const fields = parsed as Record<string, unknown>;
  if (fields.v !== SIDE_PANE_PREFERENCES_VERSION) return { ...DEFAULT_SIDE_PANE_PREFERENCES };
  return {
    v: SIDE_PANE_PREFERENCES_VERSION,
    width: typeof fields.width === 'number' ? clampSidePaneWidth(fields.width) : DEFAULT_SIDE_PANE_PREFERENCES.width,
  };
};

export interface SidePanePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): SidePanePreferenceStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: SidePanePreferenceStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The shared side-pane preference snapshot, shaped for `useSyncExternalStore`:
 * `snapshot()` is identity-stable between commits so React does not re-render
 * a workspace that did not change.
 */
export class SidePanePreferenceStore {
  readonly #storage: SidePanePreferenceStorage | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: SidePanePreferences | null = null;

  constructor(storage: SidePanePreferenceStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  /** Identity-stable snapshot; the first read hydrates from storage. */
  snapshot(): SidePanePreferences {
    this.#snapshot ??= this.#load();
    return this.#snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Commit once at the END of a pointer drag (or once per keyboard command).
   * Preview frames deliberately stay local to the active workspace.
   */
  setWidth(width: number): SidePanePreferences {
    const next: SidePanePreferences = { v: SIDE_PANE_PREFERENCES_VERSION, width: clampSidePaneWidth(width) };
    this.#snapshot = next;
    this.#save(next);
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): SidePanePreferences {
    if (!this.#storage) return { ...DEFAULT_SIDE_PANE_PREFERENCES };
    try {
      return parseSidePanePreferences(this.#storage.getItem(SIDE_PANE_PREFERENCES_KEY));
    } catch {
      return { ...DEFAULT_SIDE_PANE_PREFERENCES };
    }
  }

  /**
   * A failed persistence write never blocks resizing; the in-memory preference
   * still applies for the rest of the tab.
   */
  #save(preferences: SidePanePreferences): boolean {
    if (!this.#storage) return false;
    try {
      this.#storage.setItem(SIDE_PANE_PREFERENCES_KEY, JSON.stringify(preferences));
      return true;
    } catch {
      return false;
    }
  }
}
