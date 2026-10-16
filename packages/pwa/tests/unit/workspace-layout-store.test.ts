import { describe, expect, it } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionKey } from '../../src/lib/daemon-scope.ts';
import {
  defaultWorkspaceLayout,
  openWorkspaceTab,
  serializeWorkspaceLayout,
  toggleWorkspacePane,
  workspaceTab,
} from '../../src/lib/workspace-layout.ts';
import {
  browserWorkspaceStorage,
  WORKSPACE_LAYOUT_STORE_KEY,
  WORKSPACE_LAYOUT_STORE_LIMIT,
  WorkspaceLayoutStore,
  type WorkspaceStorage,
} from '../../src/lib/workspace-layout-store.ts';
import {
  clampWorkspaceRailWidth,
  DEFAULT_WORKSPACE_RAILS,
  parseWorkspaceRailPreferences,
  WORKSPACE_RAIL_BOUNDS,
  WORKSPACE_RAILS_KEY,
  WorkspaceRailPreferenceStore,
} from '../../src/lib/workspace-rail-preferences.ts';

class MemoryStorage implements WorkspaceStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

const denied: WorkspaceStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

const scope = (daemon: string, sessionId: string) => ({ daemonId: daemon as DaemonId, sessionId });
const a1 = scope('daemon-a', 's1');
const b1 = scope('daemon-b', 's1');
const dev = workspaceTab('terminal', 'dev');

describe('WorkspaceLayoutStore', () => {
  it('serves the default layout and an identity-stable snapshot', () => {
    const store = new WorkspaceLayoutStore(new MemoryStorage());
    const first = store.snapshot(a1);
    expect(first).toEqual(defaultWorkspaceLayout());
    expect(store.snapshot(a1)).toBe(first);
  });

  it('persists an update per (daemon, session) and restores it in a new store', () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceLayoutStore(storage);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    const next = store.update(a1, layout => openWorkspaceTab(layout, dev));
    expect(notified).toBe(1);
    expect(store.snapshot(a1)).toBe(next);
    // Same session id, other daemon: untouched.
    expect(store.snapshot(b1)).toEqual(defaultWorkspaceLayout());
    const restored = new WorkspaceLayoutStore(storage);
    expect(restored.snapshot(a1)).toEqual(next);
    expect(restored.snapshot(b1)).toEqual(defaultWorkspaceLayout());
    unsubscribe();
    store.update(a1, toggleWorkspacePane);
    expect(notified).toBe(1);
  });

  it('writes nothing for an unchanged layout', () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceLayoutStore(storage);
    const current = store.snapshot(a1);
    expect(store.update(a1, layout => layout)).toBe(current);
    expect(storage.writes).toBe(0);
  });

  it('keeps only the most recent sessions', () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceLayoutStore(storage);
    for (let index = 0; index <= WORKSPACE_LAYOUT_STORE_LIMIT; index += 1) {
      store.update(scope('d', `s${index}`), toggleWorkspacePane);
    }
    const payload = JSON.parse(storage.getItem(WORKSPACE_LAYOUT_STORE_KEY) as string);
    expect(payload.entries).toHaveLength(WORKSPACE_LAYOUT_STORE_LIMIT);
    expect(payload.entries[0].key).toBe(daemonSessionKey(scope('d', 's1')));
  });

  it('forgets one daemon and leaves the others', () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceLayoutStore(storage);
    store.update(a1, toggleWorkspacePane);
    store.update(b1, toggleWorkspacePane);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.forgetDaemon('daemon-a' as DaemonId);
    expect(notified).toBe(1);
    expect(store.snapshot(a1)).toEqual(defaultWorkspaceLayout());
    expect(new WorkspaceLayoutStore(storage).snapshot(b1).root.type).toBe('split');
    store.forgetDaemon('daemon-z' as DaemonId);
    expect(notified).toBe(1);
  });

  it('tolerates garbage payloads, garbage entries and garbage keys', () => {
    const cases = [
      'not json',
      '[]',
      'null',
      JSON.stringify({ v: 2, entries: [] }),
      JSON.stringify({ v: 1, entries: 'x' }),
    ];
    for (const raw of cases) {
      const storage = new MemoryStorage();
      storage.values.set(WORKSPACE_LAYOUT_STORE_KEY, raw);
      expect(new WorkspaceLayoutStore(storage).snapshot(a1)).toEqual(defaultWorkspaceLayout());
    }
    const storage = new MemoryStorage();
    const layout = openWorkspaceTab(defaultWorkspaceLayout(), dev);
    storage.values.set(
      WORKSPACE_LAYOUT_STORE_KEY,
      JSON.stringify({
        v: 1,
        entries: [
          null,
          { key: 5 },
          { key: 'not json', layout: 1 },
          { key: '{"a":1}', layout: 1 },
          { key: daemonSessionKey(a1), layout: JSON.parse(serializeWorkspaceLayout(layout)) },
        ],
      }),
    );
    const store = new WorkspaceLayoutStore(storage);
    expect(store.snapshot(a1)).toEqual(layout);
    store.forgetDaemon('daemon-a' as DaemonId);
    const left = JSON.parse(storage.getItem(WORKSPACE_LAYOUT_STORE_KEY) as string).entries;
    expect(left.map((entry: { key: string }) => entry.key)).toEqual(['not json', '{"a":1}']);
  });

  it('keeps working when storage is denied or absent', () => {
    const store = new WorkspaceLayoutStore(denied);
    const next = store.update(a1, toggleWorkspacePane);
    expect(store.snapshot(a1)).toBe(next);
    const none = new WorkspaceLayoutStore(undefined);
    expect(none.update(a1, toggleWorkspacePane).root.type).toBe('split');
  });

  it('finds the page storage and survives a throwing accessor', () => {
    const global = globalThis as { localStorage?: unknown };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
      expect(browserWorkspaceStorage()).toBe(global.localStorage as WorkspaceStorage);
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: 1 } });
      expect(browserWorkspaceStorage()).toBeUndefined();
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
      expect(browserWorkspaceStorage()).toBeUndefined();
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('denied');
        },
      });
      expect(browserWorkspaceStorage()).toBeUndefined();
      expect(new WorkspaceLayoutStore().snapshot(a1)).toEqual(defaultWorkspaceLayout());
      expect(new WorkspaceRailPreferenceStore().snapshot()).toEqual(DEFAULT_WORKSPACE_RAILS);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete global.localStorage;
    }
  });
});

describe('workspace rail preferences', () => {
  it('clamps widths per side', () => {
    expect(clampWorkspaceRailWidth('left', 10)).toBe(WORKSPACE_RAIL_BOUNDS.left.min);
    expect(clampWorkspaceRailWidth('right', 9999)).toBe(WORKSPACE_RAIL_BOUNDS.right.max);
    expect(clampWorkspaceRailWidth('left', 300.4)).toBe(300);
    expect(clampWorkspaceRailWidth('right', Number.NaN)).toBe(WORKSPACE_RAIL_BOUNDS.right.initial);
  });

  it('parses defensively, field by field', () => {
    expect(parseWorkspaceRailPreferences(null)).toEqual(DEFAULT_WORKSPACE_RAILS);
    expect(parseWorkspaceRailPreferences('{bad')).toEqual(DEFAULT_WORKSPACE_RAILS);
    expect(parseWorkspaceRailPreferences('[]')).toEqual(DEFAULT_WORKSPACE_RAILS);
    expect(parseWorkspaceRailPreferences('7')).toEqual(DEFAULT_WORKSPACE_RAILS);
    expect(parseWorkspaceRailPreferences(JSON.stringify({ v: 9, left: 300 }))).toEqual(DEFAULT_WORKSPACE_RAILS);
    expect(parseWorkspaceRailPreferences(JSON.stringify({ v: 1, left: 300, right: 'wide' }))).toEqual({
      v: 1,
      left: 300,
      right: DEFAULT_WORKSPACE_RAILS.right,
    });
  });

  it('commits, notifies, persists and restores', () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceRailPreferenceStore(storage);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    const first = store.snapshot();
    expect(store.snapshot()).toBe(first);
    const next = store.setWidth('left', 333);
    expect(next.left).toBe(333);
    expect(notified).toBe(1);
    expect(store.setWidth('left', 333)).toBe(next);
    expect(notified).toBe(1);
    expect(JSON.parse(storage.getItem(WORKSPACE_RAILS_KEY) as string)).toEqual(next);
    expect(new WorkspaceRailPreferenceStore(storage).snapshot()).toEqual(next);
    unsubscribe();
  });

  it('survives denied storage', () => {
    const store = new WorkspaceRailPreferenceStore(denied);
    expect(store.snapshot()).toEqual(DEFAULT_WORKSPACE_RAILS);
    expect(store.setWidth('right', 400).right).toBe(400);
    expect(new WorkspaceRailPreferenceStore(undefined).setWidth('right', 400).right).toBe(400);
  });
});
