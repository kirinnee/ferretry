/**
 * SOLE OWNER of the `fy-workspace-rails-v1` browser-storage key.
 *
 * The left (agents) and right (context) rail widths of the session page. Like
 * the side-pane width, a rail width is a property of the reader's screen, not
 * of a daemon or an agent, so it is deliberately NOT daemon-scoped: switching
 * agents must not resize the rails.
 */

import { browserWorkspaceStorage, type WorkspaceStorage } from './workspace-layout-store.ts';

export const WORKSPACE_RAILS_KEY = 'fy-workspace-rails-v1';
export const WORKSPACE_RAILS_VERSION = 1;

export type WorkspaceRailSide = 'left' | 'right';

export interface WorkspaceRailBounds {
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

export const WORKSPACE_RAIL_BOUNDS: Readonly<Record<WorkspaceRailSide, WorkspaceRailBounds>> = {
  left: { min: 200, max: 420, initial: 264 },
  right: { min: 260, max: 560, initial: 320 },
};

export interface WorkspaceRailPreferences {
  readonly v: typeof WORKSPACE_RAILS_VERSION;
  readonly left: number;
  readonly right: number;
}

export const DEFAULT_WORKSPACE_RAILS: WorkspaceRailPreferences = Object.freeze({
  v: WORKSPACE_RAILS_VERSION,
  left: WORKSPACE_RAIL_BOUNDS.left.initial,
  right: WORKSPACE_RAIL_BOUNDS.right.initial,
});

export const clampWorkspaceRailWidth = (side: WorkspaceRailSide, width: number): number => {
  const bounds = WORKSPACE_RAIL_BOUNDS[side];
  if (!Number.isFinite(width)) return bounds.initial;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
};

/** Defensive parse: a bad payload resets, a bad field falls back on its own. */
export const parseWorkspaceRailPreferences = (raw: string | null): WorkspaceRailPreferences => {
  if (!raw) return { ...DEFAULT_WORKSPACE_RAILS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_WORKSPACE_RAILS };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_WORKSPACE_RAILS };
  const fields = parsed as Record<string, unknown>;
  if (fields.v !== WORKSPACE_RAILS_VERSION) return { ...DEFAULT_WORKSPACE_RAILS };
  const width = (side: WorkspaceRailSide) => {
    const value = fields[side];
    return typeof value === 'number' ? clampWorkspaceRailWidth(side, value) : DEFAULT_WORKSPACE_RAILS[side];
  };
  return { v: WORKSPACE_RAILS_VERSION, left: width('left'), right: width('right') };
};

/** Shared rail widths, identity-stable for `useSyncExternalStore`. */
export class WorkspaceRailPreferenceStore {
  readonly #storage: WorkspaceStorage | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: WorkspaceRailPreferences | null = null;

  constructor(storage: WorkspaceStorage | undefined = browserWorkspaceStorage()) {
    this.#storage = storage;
  }

  snapshot = (): WorkspaceRailPreferences => {
    this.#snapshot ??= this.#load();
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Commit once at the end of a drag (or once per keyboard step). */
  setWidth(side: WorkspaceRailSide, width: number): WorkspaceRailPreferences {
    const current = this.snapshot();
    const clamped = clampWorkspaceRailWidth(side, width);
    if (current[side] === clamped) return current;
    const next: WorkspaceRailPreferences = { ...current, [side]: clamped };
    this.#snapshot = next;
    try {
      this.#storage?.setItem(WORKSPACE_RAILS_KEY, JSON.stringify(next));
    } catch {
      // Denied or full: the width still applies for this page.
    }
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): WorkspaceRailPreferences {
    try {
      return parseWorkspaceRailPreferences(this.#storage?.getItem(WORKSPACE_RAILS_KEY) ?? null);
    } catch {
      return { ...DEFAULT_WORKSPACE_RAILS };
    }
  }
}

/**
 * THE PAGE'S ONE STORE. The sessions bar writes `left` and the session page's context rail writes
 * `right`, and each write stores both — so two instances would each put back the other's stale width.
 * Everything that resizes a rail shares this one.
 */
export const workspaceRailPreferences = new WorkspaceRailPreferenceStore();
