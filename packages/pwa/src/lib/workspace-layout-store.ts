/**
 * SOLE OWNER of the `fy-workspace-layout-v1` browser-storage key.
 *
 * The session workspace's panes, tabs and divider sizes are remembered PER
 * AGENT: reopening a session brings back the terminals, pages and files it had
 * open, where they were. Session ids are only unique within the daemon that
 * minted them, so every entry is keyed through `daemonSessionKey` — two daemons
 * handing out the same session id never share a layout.
 *
 * The contract mirrors `side-pane-preferences.ts`: an explicit payload
 * version, a defensive parse (the layout's own parse is in
 * `workspace-layout.ts`), storage denial treated as an ordinary browser
 * condition, and identity-stable snapshots shaped for `useSyncExternalStore`.
 *
 * The payload is bounded: only the most recently written
 * `WORKSPACE_LAYOUT_STORE_LIMIT` sessions are kept, oldest dropped first.
 */

import type { DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import { defaultWorkspaceLayout, parseWorkspaceLayout, type WorkspaceLayout } from './workspace-layout.ts';

export const WORKSPACE_LAYOUT_STORE_KEY = 'fy-workspace-layout-v1';
export const WORKSPACE_LAYOUT_STORE_VERSION = 1;
export const WORKSPACE_LAYOUT_STORE_LIMIT = 100;

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The page's localStorage, or undefined when the browser refuses it. */
export const browserWorkspaceStorage = (): WorkspaceStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: WorkspaceStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

interface StoredEntry {
  readonly key: string;
  readonly layout: unknown;
}

const parseEntries = (raw: string | null): readonly StoredEntry[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const fields = parsed as Record<string, unknown>;
    if (fields.v !== WORKSPACE_LAYOUT_STORE_VERSION || !Array.isArray(fields.entries)) return [];
    return fields.entries.filter(
      (entry): entry is StoredEntry =>
        typeof entry === 'object' && entry !== null && typeof (entry as { key?: unknown }).key === 'string',
    );
  } catch {
    return [];
  }
};

const scopeDaemon = (key: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Per-(daemon, session) workspace layouts. `snapshot(scope)` is identity-stable
 * until that scope's layout changes, so `useSyncExternalStore` re-renders only
 * the workspace that moved.
 */
export class WorkspaceLayoutStore {
  readonly #storage: WorkspaceStorage | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #layouts = new Map<string, WorkspaceLayout>();
  #entries: StoredEntry[] | null = null;

  constructor(storage: WorkspaceStorage | undefined = browserWorkspaceStorage()) {
    this.#storage = storage;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot(scope: DaemonSessionScope): WorkspaceLayout {
    const key = daemonSessionKey(scope);
    const cached = this.#layouts.get(key);
    if (cached) return cached;
    const stored = this.#load().find(entry => entry.key === key);
    const layout = stored ? parseWorkspaceLayout(stored.layout) : defaultWorkspaceLayout();
    this.#layouts.set(key, layout);
    return layout;
  }

  /** Applies a pure layout operation; an unchanged result writes nothing. */
  update(scope: DaemonSessionScope, operation: (layout: WorkspaceLayout) => WorkspaceLayout): WorkspaceLayout {
    const current = this.snapshot(scope);
    const next = operation(current);
    if (next === current) return current;
    const key = daemonSessionKey(scope);
    this.#layouts.set(key, next);
    const kept = this.#load().filter(entry => entry.key !== key);
    this.#entries = [...kept, { key, layout: next }].slice(-WORKSPACE_LAYOUT_STORE_LIMIT);
    this.#save();
    this.#emit();
    return next;
  }

  /** Drops every remembered layout of one daemon (unpair, credential reset). */
  forgetDaemon(daemonId: DaemonId): void {
    for (const key of [...this.#layouts.keys()]) {
      if (scopeDaemon(key) === daemonId) this.#layouts.delete(key);
    }
    const entries = this.#load();
    const kept = entries.filter(entry => scopeDaemon(entry.key) !== daemonId);
    if (kept.length === entries.length) return;
    this.#entries = kept;
    this.#save();
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  #load(): StoredEntry[] {
    if (this.#entries) return this.#entries;
    let raw: string | null = null;
    try {
      raw = this.#storage?.getItem(WORKSPACE_LAYOUT_STORE_KEY) ?? null;
    } catch {
      raw = null;
    }
    this.#entries = [...parseEntries(raw)];
    return this.#entries;
  }

  /** A refused write never blocks the layout; it simply is not remembered. */
  #save(): void {
    try {
      this.#storage?.setItem(
        WORKSPACE_LAYOUT_STORE_KEY,
        JSON.stringify({ v: WORKSPACE_LAYOUT_STORE_VERSION, entries: this.#entries }),
      );
    } catch {
      // Storage full or denied: the in-memory layout still applies.
    }
  }
}
