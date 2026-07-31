/**
 * SOLE OWNER of the `fy-controls-v1` browser-storage key.
 *
 * Carved out of kteam `ui/src/lib/store.tsx:80-233,785-805`, where the persisted
 * UI controls lived inside the fleet store. They have no transport, no socket
 * and no timers, so they belong in their own module: the fleet store can then be
 * ported without carrying browser persistence along with it.
 *
 * Kept from kteam, deliberately:
 *   - FIELD-BY-FIELD tolerant parsing. A hand-edited or older payload degrades
 *     to the default for that field alone; one bad field must never discard the
 *     reader's other controls.
 *   - `density` and `dashboardView` absent means `null`, not a written default,
 *     so the first-load pointer policy stays free to choose compact on a phone
 *     and full on a desktop.
 *   - `chatWidth` absent means `'full'`, which IS the behaviour that predates the
 *     field — which is why adding it needed no version bump.
 *   - An empty `projectScope` is NO scope, not a folder named nothing.
 *   - A patch that changes nothing writes nothing and notifies nobody.
 *
 * WHAT CHANGED — survey row #48. kteam wrote all nine controls into one
 * un-namespaced device record, including `projectScope`, which holds a
 * DAEMON-DERIVED filesystem path (a normalised project path, or a raw cwd for a
 * fallback group). Two paired daemons have disjoint path sets, so a scope
 * persisted against daemon A silently filters daemon B's fleet to nothing on the
 * next reload. The split here is by field LIFETIME rather than daemon-keying all
 * nine: the eight device preferences are properties of the reader's screen and
 * are right to share, while `projectScope` is stored, read and cleared per
 * `DaemonId` and has no daemon-free lookup. `query` stays device-global on
 * purpose — it is a transient search term, not daemon identity.
 *
 * Remembered scopes are bounded so an unpaired daemon cannot accumulate forever.
 * Recency is a stored counter rather than a wall clock, so eviction order is
 * reproducible without injecting a clock; it advances when a daemon's scope
 * CHANGES, and re-selecting the identical scope is a no-op by design.
 *
 * There is deliberately no migration from kteam's key: no Ferretry bundle ever
 * wrote it, and a payload without `v: 1` is a clean reset — which is exactly
 * what a kteam-shaped flat blob is, so its top-level `projectScope` can never
 * leak in un-namespaced.
 *
 * The ephemeral Settings-sheet state that sat beside these controls in kteam
 * (`settingsOpen`, `settingsTarget`) is NOT here and must never be persisted:
 * opening Settings is current navigation, not a preference.
 */

import type { InteractionMode } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';

/** The sole browser-storage key for persisted UI controls. */
export const CONTROLS_KEY = 'fy-controls-v1';
export const CONTROLS_VERSION = 1;
/** Remembered per-daemon scopes. Far above the daemons one reader pairs. */
export const MAX_DAEMON_SCOPES = 20;
/** Retained on a quota-denied rewrite, before giving up entirely. */
export const RETRY_DAEMON_SCOPES = 5;

export type ModeFilter = 'all' | InteractionMode;
export type DashboardView = 'cards' | 'table';
export type Density = 'full' | 'compact' | 'minimal';
/** The persisted form of the shell's conversation-width choice. */
export type ChatWidthPreference = 'full' | 'balanced' | 'readable';

/**
 * Controls that belong to the reader's device and are shared by every paired
 * daemon. Switching daemon must not change any of them.
 */
export interface DeviceControls {
  /** Instant client-side filter over the session list. */
  readonly query: string;
  readonly mode: ModeFilter;
  /** Remote-control sessions only — a real filter, not a search term. */
  readonly rcOnly: boolean;
  readonly includeFinished: boolean;
  /** null = follow the viewport (cards when narrow). */
  readonly dashboardView: DashboardView | null;
  /** null = use the first-load device default without persisting it. */
  readonly density: Density | null;
  /** Chat pane horizontal measure; inert on a phone, which is already narrower. */
  readonly chatWidth: ChatWidthPreference;
  readonly sidebarCollapsed: boolean;
}

/** What a screen renders: device preferences plus THIS daemon's project scope. */
export interface UiControls extends DeviceControls {
  /**
   * The focused project group KEY for one daemon — a normalised project path, or
   * a raw cwd for a fallback group, never a display name. null = whole fleet.
   */
  readonly projectScope: string | null;
}

export const DEFAULT_DEVICE_CONTROLS: DeviceControls = Object.freeze({
  query: '',
  mode: 'all',
  rcOnly: false,
  includeFinished: false,
  dashboardView: null,
  density: null,
  chatWidth: 'full',
  sidebarCollapsed: false,
});

const DEVICE_KEYS = [
  'query',
  'mode',
  'rcOnly',
  'includeFinished',
  'dashboardView',
  'density',
  'chatWidth',
  'sidebarCollapsed',
] as const satisfies readonly (keyof DeviceControls)[];

/** One daemon's remembered scope. `seq` is its recency for LRU eviction. */
export interface DaemonScopeEntry {
  readonly projectScope: string;
  readonly seq: number;
}

export interface ControlsRecord {
  readonly v: typeof CONTROLS_VERSION;
  readonly device: DeviceControls;
  /** Keyed by `DaemonId`; a daemon with no scope simply has no entry. */
  readonly scopes: Readonly<Record<string, DaemonScopeEntry>>;
}

/**
 * Scope maps have a NULL PROTOTYPE, and membership is always an own-key test.
 * A `DaemonId` is any non-blank string, so it can be `__proto__`, `toString` or
 * `constructor`: on an ordinary object `scopes.__proto__ = entry` would hit the
 * prototype setter instead of storing anything, and `'toString' in scopes` would
 * be true for a daemon that has no scope — breaking persistence and the no-op
 * identity contract. A null-prototype map has no inherited keys to collide with.
 */
const emptyScopes = (): Record<string, DaemonScopeEntry> => Object.create(null) as Record<string, DaemonScopeEntry>;

const cloneScopes = (scopes: Readonly<Record<string, DaemonScopeEntry>>): Record<string, DaemonScopeEntry> => {
  const next = emptyScopes();
  for (const [key, entry] of Object.entries(scopes)) next[key] = entry;
  return next;
};

/** One daemon's own scope, never a value inherited from a prototype. */
const scopeOf = (record: ControlsRecord, daemonId: DaemonId): string | null =>
  Object.hasOwn(record.scopes, daemonId) ? (record.scopes[daemonId]?.projectScope ?? null) : null;

export const emptyControlsRecord = (): ControlsRecord => ({
  v: CONTROLS_VERSION,
  device: { ...DEFAULT_DEVICE_CONTROLS },
  scopes: emptyScopes(),
});

/**
 * An absent, blank, whitespace-only or non-string scope is no scope at all.
 * Blank-is-empty follows `daemonId` and `upsertDraft`; the surviving value is
 * stored unmodified, because a group key is compared against daemon-supplied
 * paths and must not be silently rewritten.
 */
const readProjectScope = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const readDeviceControls = (value: unknown): DeviceControls => {
  const fields = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    query: typeof fields.query === 'string' ? fields.query : DEFAULT_DEVICE_CONTROLS.query,
    mode:
      fields.mode === 'all' || fields.mode === 'auto' || fields.mode === 'interactive'
        ? fields.mode
        : DEFAULT_DEVICE_CONTROLS.mode,
    rcOnly: typeof fields.rcOnly === 'boolean' ? fields.rcOnly : DEFAULT_DEVICE_CONTROLS.rcOnly,
    includeFinished:
      typeof fields.includeFinished === 'boolean' ? fields.includeFinished : DEFAULT_DEVICE_CONTROLS.includeFinished,
    dashboardView: fields.dashboardView === 'cards' || fields.dashboardView === 'table' ? fields.dashboardView : null,
    density:
      fields.density === 'full' || fields.density === 'compact' || fields.density === 'minimal' ? fields.density : null,
    chatWidth:
      fields.chatWidth === 'full' || fields.chatWidth === 'balanced' || fields.chatWidth === 'readable'
        ? fields.chatWidth
        : DEFAULT_DEVICE_CONTROLS.chatWidth,
    sidebarCollapsed:
      typeof fields.sidebarCollapsed === 'boolean' ? fields.sidebarCollapsed : DEFAULT_DEVICE_CONTROLS.sidebarCollapsed,
  };
};

const readScopes = (value: unknown): Record<string, DaemonScopeEntry> => {
  const scopes = emptyScopes();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return scopes;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() === '' || !entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const projectScope = readProjectScope(candidate.projectScope);
    if (projectScope === null) continue;
    if (typeof candidate.seq !== 'number' || !Number.isSafeInteger(candidate.seq) || candidate.seq < 0) continue;
    scopes[key] = { projectScope, seq: candidate.seq };
  }
  return scopes;
};

/** Drops the least recently changed scopes; returns the input when within bound. */
export const evictDaemonScopes = (record: ControlsRecord, max = MAX_DAEMON_SCOPES): ControlsRecord => {
  const keys = Object.keys(record.scopes);
  if (keys.length <= max) return record;
  const scopes = emptyScopes();
  const newest = keys
    .sort((left, right) => (record.scopes[right]?.seq ?? 0) - (record.scopes[left]?.seq ?? 0))
    .slice(0, max);
  for (const key of newest) {
    const entry = record.scopes[key];
    if (entry) scopes[key] = entry;
  }
  return { ...record, scopes };
};

/**
 * Defensive parse: an unknown version, a non-object or unreadable JSON is a
 * clean reset. Individual fields and individual daemon entries fall back on
 * their own, and a hand-edited overlong scope list is bounded on the way in.
 */
export const parseControlsRecord = (raw: string | null | undefined): ControlsRecord => {
  if (!raw) return emptyControlsRecord();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyControlsRecord();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyControlsRecord();
  const fields = parsed as Record<string, unknown>;
  if (fields.v !== CONTROLS_VERSION) return emptyControlsRecord();
  return evictDaemonScopes({
    v: CONTROLS_VERSION,
    device: readDeviceControls(fields.device),
    scopes: readScopes(fields.scopes),
  });
};

/** The merged view for one daemon. There is no daemon-free overload. */
export const controlsFor = (record: ControlsRecord, daemonId: DaemonId): UiControls => ({
  ...record.device,
  projectScope: scopeOf(record, daemonId),
});

/** Field-wise equality, used to reuse a merged object that did not change. */
export const sameControls = (left: UiControls, right: UiControls): boolean =>
  left.projectScope === right.projectScope && DEVICE_KEYS.every(key => left[key] === right[key]);

const scopesForNextSeq = (
  record: ControlsRecord,
): { readonly scopes: Record<string, DaemonScopeEntry>; readonly seq: number } => {
  const scopes = cloneScopes(record.scopes);
  let highest = -1;
  for (const entry of Object.values(record.scopes)) highest = Math.max(highest, entry.seq);
  if (highest < Number.MAX_SAFE_INTEGER) return { scopes, seq: highest + 1 };

  // A valid but exhausted persisted counter must not make the new entry tie
  // with its predecessor. Rebase the bounded map while preserving its order.
  const oldestToNewest = Object.keys(scopes).sort(
    (left, right) => (scopes[left]?.seq ?? 0) - (scopes[right]?.seq ?? 0),
  );
  for (const [seq, key] of oldestToNewest.entries()) scopes[key] = { ...scopes[key]!, seq };
  return { scopes, seq: oldestToNewest.length };
};

/**
 * Applies device fields only. An explicitly `undefined` value leaves that field
 * alone, and unknown keys are ignored; an unchanged patch returns the SAME
 * record so a caller can detect a no-op by identity.
 */
export const withDeviceControls = (record: ControlsRecord, patch: Partial<DeviceControls>): ControlsRecord => {
  const device = { ...record.device } as Record<string, unknown>;
  for (const key of DEVICE_KEYS) {
    const value = patch[key];
    if (value !== undefined) device[key] = value;
  }
  const next = device as unknown as DeviceControls;
  if (DEVICE_KEYS.every(key => next[key] === record.device[key])) return record;
  return { ...record, device: next };
};

/** Forgets one daemon's scope; returns the SAME record when it had none. */
export const withoutDaemonScope = (record: ControlsRecord, daemonId: DaemonId): ControlsRecord => {
  if (!Object.hasOwn(record.scopes, daemonId)) return record;
  const scopes = cloneScopes(record.scopes);
  delete scopes[daemonId];
  return { ...record, scopes };
};

/**
 * Records one daemon's scope, normalising blank to none. Returns the SAME record
 * when the scope is already what was asked for.
 */
export const withDaemonScope = (
  record: ControlsRecord,
  daemonId: DaemonId,
  projectScope: string | null,
): ControlsRecord => {
  const normalized = readProjectScope(projectScope);
  if (normalized === scopeOf(record, daemonId)) return record;
  if (normalized === null) return withoutDaemonScope(record, daemonId);
  const { scopes, seq } = scopesForNextSeq(record);
  scopes[daemonId] = { projectScope: normalized, seq };
  return evictDaemonScopes({ ...record, scopes });
};

export interface ControlsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where `localStorage` is looked up. Injected so a test never has to mutate a global. */
export interface ControlsStorageSource {
  readonly localStorage?: unknown;
}

/**
 * Resolves the browser store, treating denial as an ordinary condition: reading
 * `localStorage` itself throws in some privacy modes, and an object that only
 * looks like a store is not trusted.
 */
export const browserControlsStorage = (
  source: ControlsStorageSource = globalThis as ControlsStorageSource,
): ControlsStorage | undefined => {
  try {
    const candidate = source.localStorage as ControlsStorage | undefined;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The persisted UI controls, shaped for `useSyncExternalStore`: `snapshot()` and
 * `controls(daemonId)` are identity-stable across a commit that did not change
 * what they return, so a screen reading one daemon's controls does not re-render
 * because another daemon's scope changed. See `#commit` for how that holds while
 * there is only one listener set.
 */
export class DaemonControlsStore {
  readonly #storage: ControlsStorage | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #merged = new Map<string, UiControls>();
  #record: ControlsRecord | null = null;

  constructor(storage: ControlsStorage | undefined = browserControlsStorage()) {
    this.#storage = storage;
  }

  /** Identity-stable record; the first read hydrates from storage. */
  snapshot(): ControlsRecord {
    this.#record ??= this.#load();
    return this.#record;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** One daemon's merged controls. A daemon must always be named. */
  controls(daemonId: DaemonId): UiControls {
    const cached = this.#merged.get(daemonId);
    if (cached) return cached;
    const merged = controlsFor(this.snapshot(), daemonId);
    this.#merged.set(daemonId, merged);
    return merged;
  }

  /**
   * Applies device fields and this daemon's scope. Omitted or explicitly
   * `undefined` fields are unchanged; `null` or blank explicitly clears a
   * scope. A patch that changes nothing writes nothing and notifies nobody.
   */
  setControls(daemonId: DaemonId, patch: Partial<UiControls>): UiControls {
    let next = withDeviceControls(this.snapshot(), patch);
    if (patch.projectScope !== undefined) next = withDaemonScope(next, daemonId, patch.projectScope);
    this.#commit(next);
    return this.controls(daemonId);
  }

  /**
   * Applies device preferences with no daemon in context — a settings screen
   * changing text density has no daemon to name, and must not have to invent one.
   */
  setDeviceControls(patch: Partial<DeviceControls>): DeviceControls {
    this.#commit(withDeviceControls(this.snapshot(), patch));
    return this.snapshot().device;
  }

  /** Forgets one unpaired daemon's scope and leaves every other daemon's. */
  clearDaemon(daemonId: DaemonId): boolean {
    const changed = this.#commit(withoutDaemonScope(this.snapshot(), daemonId));
    this.#merged.delete(daemonId);
    return changed;
  }

  /**
   * Every subscriber is notified, because one listener set is simpler than
   * per-daemon channels and `useSyncExternalStore` already bails out on an
   * unchanged snapshot. What makes that bail-out possible is identity: a merged
   * view whose fields did not change is REUSED, so a scope change on one daemon
   * cannot re-render a screen reading another. A device change legitimately
   * changes every daemon's view, and every reader does re-render.
   */
  #commit(next: ControlsRecord): boolean {
    if (next === this.snapshot()) return false;
    this.#record = next;
    for (const [id, previous] of this.#merged) {
      const merged = controlsFor(next, id as DaemonId);
      this.#merged.set(id, sameControls(previous, merged) ? previous : merged);
    }
    this.#save(next);
    for (const listener of this.#listeners) listener();
    return true;
  }

  #load(): ControlsRecord {
    if (!this.#storage) return emptyControlsRecord();
    try {
      return parseControlsRecord(this.#storage.getItem(CONTROLS_KEY));
    } catch {
      return emptyControlsRecord();
    }
  }

  /**
   * Persistence is best effort: a denied write never blocks a filter from
   * applying for the rest of the tab. A quota failure retries with only the
   * most recent scopes, since those are the ones a reader will come back to.
   */
  #save(record: ControlsRecord): boolean {
    if (!this.#storage) return false;
    try {
      this.#storage.setItem(CONTROLS_KEY, JSON.stringify(record));
      return true;
    } catch {
      try {
        this.#storage.setItem(CONTROLS_KEY, JSON.stringify(evictDaemonScopes(record, RETRY_DAEMON_SCOPES)));
        return true;
      } catch {
        return false;
      }
    }
  }
}
