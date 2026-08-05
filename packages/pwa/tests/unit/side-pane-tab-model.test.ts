import { beforeEach, describe, expect, it } from 'bun:test';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  activateSidePaneTab,
  type BrowserDestination,
  deactivateSidePane,
  forgetDaemonSidePaneTabs,
  getSidePaneInstanceBody,
  getSidePaneTabDefinition,
  getSidePaneTabDefinitions,
  getSidePaneTabRegistryVersion,
  getSidePaneTabsVersion,
  openSidePaneBrowserTab,
  openSidePaneFileTab,
  openSidePaneTab,
  openSidePaneTerminalTab,
  parseSidePaneInstanceTabId,
  readSidePaneTabInstance,
  readSidePaneTabsState,
  registerSidePaneInstanceBody,
  registerSidePaneTab,
  removeSidePaneTab,
  resetSidePaneTabRegistry,
  resetSidePaneTabsStates,
  resolveSidePaneTab,
  SIDE_PANE_BUILT_IN_TABS,
  setSidePaneInstanceLabel,
  sidePaneInstanceTabId,
  sortSidePaneTabs,
  subscribeSidePaneInstanceClose,
  subscribeSidePaneTabRegistry,
  subscribeSidePaneTabsState,
  writeSidePaneTabsState,
} from '../../src/shell/side-pane-tab-model.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a-token' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b-token' });

const scopeA = daemonSessionScope(daemonA, 'session-1');
const scopeB = daemonSessionScope(daemonB, 'session-1');

const destination = (href: string, hostname: string): BrowserDestination => ({
  href,
  hostname,
  scope: 'cross-origin',
});

beforeEach(() => {
  resetSidePaneTabRegistry();
  resetSidePaneTabsStates();
});

describe('instance identity', () => {
  it('round-trips an instance id through its kind and key', () => {
    const id = sidePaneInstanceTabId('file', 'src/api.ts');

    expect(id).toBe('file:src/api.ts');
    expect(parseSidePaneInstanceTabId(id)).toEqual({ kind: 'file', key: 'src/api.ts' });
  });

  it('keeps a key that itself contains colons intact', () => {
    expect(parseSidePaneInstanceTabId('browser:https://x.test:8080/a')).toEqual({
      kind: 'browser',
      key: 'https://x.test:8080/a',
    });
  });

  it('does not mistake a singleton id containing a colon for an instance', () => {
    expect(parseSidePaneInstanceTabId('tasks')).toBeNull();
    expect(parseSidePaneInstanceTabId('skills:groups')).toBeNull();
    expect(parseSidePaneInstanceTabId('file:')).toBeNull();
  });
});

describe('the default strip', () => {
  it('starts every fresh strip on the human-chosen defaults, in strip order', () => {
    expect(readSidePaneTabsState(scopeA).open).toEqual(['tasks', 'skills', 'lineage', 'mcp', 'analytics']);
    expect(readSidePaneTabsState(scopeA).active).toBeNull();
    expect(readSidePaneTabsState(scopeA).instances).toEqual({});
  });

  it('returns one stable snapshot object for untouched strips', () => {
    expect(readSidePaneTabsState(scopeA)).toBe(readSidePaneTabsState(scopeB));
  });

  it('keeps browser, files and terminals out of the default strip', () => {
    const defaults = new Set(readSidePaneTabsState(scopeA).open);

    for (const id of ['browser', 'files', 'terminals']) expect(defaults.has(id)).toBe(false);
  });
});

// Handover #35: "Pins and Attention do not belong in this bento/side-pane
// model." They are not registered, not default-open, and not reachable by
// asking for them — #63 owns pins, #17 owns Attention.
describe('pins and attention are not side-pane tabs', () => {
  it('registers neither id', () => {
    expect(getSidePaneTabDefinition('pins')).toBeUndefined();
    expect(getSidePaneTabDefinition('attention')).toBeUndefined();
  });

  it('keeps both out of the default strip', () => {
    const defaults = new Set(readSidePaneTabsState(scopeA).open);

    for (const id of ['pins', 'attention']) expect(defaults.has(id)).toBe(false);
  });

  it('refuses to open either one rather than parking a tab that resolves to nothing', () => {
    const before = getSidePaneTabsVersion();

    openSidePaneTab(scopeA, 'pins');
    openSidePaneTab(scopeA, 'attention');

    const state = readSidePaneTabsState(scopeA);
    expect(state.open).not.toContain('pins');
    expect(state.open).not.toContain('attention');
    expect(state.active).toBeNull();
    expect(getSidePaneTabsVersion()).toBe(before);
  });

  it('refuses any unregistered id, not just the two that left', () => {
    openSidePaneTab(scopeA, 'ghost');

    expect(readSidePaneTabsState(scopeA).open).not.toContain('ghost');
    expect(readSidePaneTabsState(scopeA).active).toBeNull();
  });

  it('still opens an instance tab that is already live, which is not registered either', () => {
    const id = openSidePaneFileTab(scopeA, 'src/api.ts');
    activateSidePaneTab(scopeA, 'tasks');

    openSidePaneTab(scopeA, id);

    expect(readSidePaneTabsState(scopeA).active).toBe(id);
  });

  it('lets a caller register a pins tab of its own — the model bans neither name', () => {
    const unregister = registerSidePaneTab({
      id: 'pins',
      label: 'Pins',
      shortLabel: 'Pins',
      closeLabel: 'Close pins',
      icon: 'tasks',
      order: 10,
    });

    openSidePaneTab(scopeA, 'pins');
    expect(readSidePaneTabsState(scopeA).active).toBe('pins');

    unregister();
  });
});

describe('registry', () => {
  it('exposes the built-ins by id and in strip order', () => {
    expect(getSidePaneTabDefinition('lineage')?.shortLabel).toBe('Lineage');
    expect(getSidePaneTabDefinition('nope')).toBeUndefined();
    expect(getSidePaneTabDefinitions().map(def => def.id)).toEqual([
      'tasks',
      'skills',
      'lineage',
      'mcp',
      'analytics',
      'browser',
      'files',
      'terminals',
    ]);
  });

  it('breaks an order tie by label so the strip never reshuffles at random', () => {
    registerSidePaneTab({
      id: 'zeta',
      label: 'Zeta',
      shortLabel: 'Z',
      closeLabel: 'Close Zeta',
      icon: 'tasks',
      order: 5,
    });
    registerSidePaneTab({
      id: 'alpha',
      label: 'Alpha',
      shortLabel: 'A',
      closeLabel: 'Close Alpha',
      icon: 'tasks',
      order: 5,
    });

    expect(
      getSidePaneTabDefinitions()
        .slice(0, 2)
        .map(def => def.id),
    ).toEqual(['alpha', 'zeta']);
  });

  it('notifies subscribers on registration and stops after unsubscribe', () => {
    let notifications = 0;
    const before = getSidePaneTabRegistryVersion();
    const unsubscribe = subscribeSidePaneTabRegistry(() => {
      notifications += 1;
    });

    const unregister = registerSidePaneTab({
      id: 'search',
      label: 'Search',
      shortLabel: 'Find',
      closeLabel: 'Close search',
      icon: 'files',
      order: 15,
    });
    expect(notifications).toBe(1);
    expect(getSidePaneTabRegistryVersion()).toBeGreaterThan(before);

    unregister();
    expect(notifications).toBe(2);
    expect(getSidePaneTabDefinition('search')).toBeUndefined();

    unsubscribe();
    registerSidePaneTab({ id: 'x', label: 'X', shortLabel: 'X', closeLabel: 'Close X', icon: 'tasks', order: 1 });
    expect(notifications).toBe(2);
  });

  it('lets the last registration win and refuses a stale unregister', () => {
    const first = {
      id: 'dupe',
      label: 'First',
      shortLabel: 'A',
      closeLabel: 'Close',
      icon: 'tasks',
      order: 1,
    } as const;
    const unregisterFirst = registerSidePaneTab(first);
    registerSidePaneTab({ id: 'dupe', label: 'Second', shortLabel: 'B', closeLabel: 'Close', icon: 'tasks', order: 1 });

    unregisterFirst();

    expect(getSidePaneTabDefinition('dupe')?.label).toBe('Second');
  });

  it('opens a newly registered default tab for strips that have not been touched', () => {
    registerSidePaneTab({
      id: 'notes',
      label: 'Notes',
      shortLabel: 'Notes',
      closeLabel: 'Close notes',
      icon: 'files',
      order: 5,
      defaultOpen: true,
    });

    expect(readSidePaneTabsState(scopeA).open[0]).toBe('notes');
  });

  it('resets back to exactly the built-ins', () => {
    registerSidePaneTab({ id: 'temp', label: 'Temp', shortLabel: 'T', closeLabel: 'Close', icon: 'tasks', order: 1 });
    resetSidePaneTabRegistry();

    expect(getSidePaneTabDefinitions()).toHaveLength(SIDE_PANE_BUILT_IN_TABS.length);
    expect(getSidePaneTabDefinition('temp')).toBeUndefined();
  });
});

describe('instance bodies', () => {
  it('registers one body per kind, replaceable, with a stale unregister that cannot tear down its replacement', () => {
    const first = () => null;
    const second = () => null;

    const unregisterFirst = registerSidePaneInstanceBody('terminal', first);
    expect(getSidePaneInstanceBody('terminal')).toBe(first);

    registerSidePaneInstanceBody('terminal', second);
    unregisterFirst();
    expect(getSidePaneInstanceBody('terminal')).toBe(second);

    registerSidePaneInstanceBody('terminal', first)();
    expect(getSidePaneInstanceBody('terminal')).toBeUndefined();
  });
});

describe('daemon isolation', () => {
  it('never lets one daemon see another daemon strip under a matching session id', () => {
    openSidePaneFileTab(scopeA, 'src/api.ts');

    expect(readSidePaneTabsState(scopeA).open).toContain('file:src/api.ts');
    expect(readSidePaneTabsState(scopeB).open).not.toContain('file:src/api.ts');
    expect(readSidePaneTabInstance(scopeB, 'file:src/api.ts')).toBeUndefined();
  });

  it('resolves an instance id only within the daemon that opened it', () => {
    openSidePaneFileTab(scopeA, 'src/api.ts');

    expect(resolveSidePaneTab(scopeA, 'file:src/api.ts')?.shortLabel).toBe('api.ts');
    expect(resolveSidePaneTab(scopeB, 'file:src/api.ts')).toBeUndefined();
  });

  it('forgets every strip belonging to one daemon and leaves the others alone', () => {
    openSidePaneFileTab(scopeA, 'src/api.ts');
    openSidePaneFileTab(scopeB, 'README.md');

    forgetDaemonSidePaneTabs('daemon-a');

    expect(readSidePaneTabsState(scopeA).open).not.toContain('file:src/api.ts');
    expect(readSidePaneTabsState(scopeB).open).toContain('file:README.md');
  });
});

describe('opening singleton tabs', () => {
  it('adds a tab in strip order and makes it active', () => {
    openSidePaneTab(scopeA, 'files');
    const state = readSidePaneTabsState(scopeA);

    expect(state.active).toBe('files');
    expect(state.open.at(-1)).toBe('files');
  });

  it('is a no-op when the tab is already open and already active', () => {
    openSidePaneTab(scopeA, 'files');
    const before = getSidePaneTabsVersion();

    openSidePaneTab(scopeA, 'files');

    expect(getSidePaneTabsVersion()).toBe(before);
  });

  it('re-activates an already open tab without duplicating it', () => {
    openSidePaneTab(scopeA, 'files');
    openSidePaneTab(scopeA, 'tasks');
    openSidePaneTab(scopeA, 'files');

    const state = readSidePaneTabsState(scopeA);
    expect(state.active).toBe('files');
    expect(state.open.filter(id => id === 'files')).toHaveLength(1);
  });

  it('redirects the browser catalogue entry to a page instance, never the singleton id', () => {
    openSidePaneTab(scopeA, 'browser');
    const state = readSidePaneTabsState(scopeA);

    expect(state.open).not.toContain('browser');
    expect(state.active).toMatch(/^browser:page-/u);
  });
});

describe('one tab per file', () => {
  it('labels the strip with the basename and the accessible name with the full path', () => {
    const id = openSidePaneFileTab(scopeA, 'packages/pwa/src/api.ts');
    const definition = resolveSidePaneTab(scopeA, id);

    expect(definition?.shortLabel).toBe('api.ts');
    expect(definition?.label).toBe('packages/pwa/src/api.ts');
    expect(definition?.closeLabel).toBe('Close api.ts');
    expect(definition?.icon).toBe('file');
    expect(definition?.retain).toBe(false);
  });

  it('falls back to the whole path when it has no basename', () => {
    const id = openSidePaneFileTab(scopeA, '/');

    expect(resolveSidePaneTab(scopeA, id)?.shortLabel).toBe('/');
  });

  it('focuses the existing tab and bumps its revision instead of duplicating', () => {
    const id = openSidePaneFileTab(scopeA, 'src/api.ts');
    openSidePaneFileTab(scopeA, 'README.md');
    const again = openSidePaneFileTab(scopeA, 'src/api.ts', { line: 42 });

    const state = readSidePaneTabsState(scopeA);
    expect(again).toBe(id);
    expect(state.open.filter(tab => tab === id)).toHaveLength(1);
    expect(state.active).toBe(id);
    expect(state.instances[id]?.revision).toBe(2);
    expect(state.instances[id]?.selection).toEqual({ line: 42 });
  });

  it('keeps two open files as two independent tabs, in opening order', () => {
    openSidePaneFileTab(scopeA, 'src/api.ts');
    openSidePaneFileTab(scopeA, 'README.md');

    const instances = readSidePaneTabsState(scopeA).open.filter(id => id.startsWith('file:'));
    expect(instances).toEqual(['file:src/api.ts', 'file:README.md']);
  });
});

describe('one tab per browser page', () => {
  it('names a page by host and keeps the full URL as the accessible name', () => {
    const id = openSidePaneBrowserTab(scopeA, destination('https://github.test/a/b', 'github.test'));
    const definition = resolveSidePaneTab(scopeA, id);

    expect(definition?.shortLabel).toBe('github.test');
    expect(definition?.label).toBe('https://github.test/a/b');
    expect(definition?.retain).toBe(true);
  });

  it('names an empty page honestly', () => {
    const id = openSidePaneBrowserTab(scopeA);

    expect(resolveSidePaneTab(scopeA, id)?.shortLabel).toBe('New page');
    expect(resolveSidePaneTab(scopeA, id)?.label).toBe('New browser page');
  });

  it('falls back to the raw href for a URL it cannot parse or that has no host', () => {
    const unparseable = openSidePaneBrowserTab(scopeA, destination('not a url', 'nowhere'));
    const hostless = openSidePaneBrowserTab(scopeA, destination('about:blank', 'blank'));

    expect(resolveSidePaneTab(scopeA, unparseable)?.shortLabel).toBe('not a url');
    expect(resolveSidePaneTab(scopeA, hostless)?.shortLabel).toBe('about:blank');
  });

  it('focuses the page already showing a destination instead of opening a second one', () => {
    const first = openSidePaneBrowserTab(scopeA, destination('https://x.test/', 'x.test'));
    openSidePaneBrowserTab(scopeA, destination('https://y.test/', 'y.test'));

    const again = openSidePaneBrowserTab(scopeA, destination('https://x.test/', 'x.test'));

    expect(again).toBe(first);
    expect(readSidePaneTabsState(scopeA).instances[first]?.revision).toBe(2);
    expect(readSidePaneTabsState(scopeA).open.filter(id => id.startsWith('browser:'))).toHaveLength(2);
  });

  it('focuses the most recent page when asked for "the browser" with no destination', () => {
    openSidePaneBrowserTab(scopeA, destination('https://x.test/', 'x.test'));
    const second = openSidePaneBrowserTab(scopeA, destination('https://y.test/', 'y.test'));

    expect(openSidePaneBrowserTab(scopeA)).toBe(second);
  });

  it('always creates a fresh page for the + picker', () => {
    const first = openSidePaneBrowserTab(scopeA, destination('https://x.test/', 'x.test'));
    const forced = openSidePaneBrowserTab(scopeA, destination('https://x.test/', 'x.test'), { forceNew: true });

    expect(forced).not.toBe(first);
    expect(readSidePaneTabsState(scopeA).open.filter(id => id.startsWith('browser:'))).toHaveLength(2);
  });
});

describe('one tab per terminal', () => {
  it('uses the terminal id as its own label when none is supplied', () => {
    const id = openSidePaneTerminalTab(scopeA, 't1');

    expect(resolveSidePaneTab(scopeA, id)?.shortLabel).toBe('t1');
    expect(resolveSidePaneTab(scopeA, id)?.retain).toBe(true);
  });

  it('focuses an existing terminal tab and keeps its earlier label', () => {
    const id = openSidePaneTerminalTab(scopeA, 't1', 'build');
    const again = openSidePaneTerminalTab(scopeA, 't1');

    expect(again).toBe(id);
    expect(readSidePaneTabsState(scopeA).instances[id]?.label).toBe('build');
    expect(readSidePaneTabsState(scopeA).instances[id]?.revision).toBe(2);
  });
});

describe('retitling a live instance', () => {
  it('renames without touching focus or strip membership', () => {
    const id = openSidePaneBrowserTab(scopeA, destination('https://x.test/', 'x.test'));
    openSidePaneFileTab(scopeA, 'src/api.ts');

    setSidePaneInstanceLabel(scopeA, id, {
      label: 'Example',
      title: 'https://x.test/deep',
      destination: destination('https://x.test/deep', 'x.test'),
    });

    const state = readSidePaneTabsState(scopeA);
    expect(state.active).toBe('file:src/api.ts');
    expect(state.instances[id]?.label).toBe('Example');
    expect(state.instances[id]?.destination?.href).toBe('https://x.test/deep');
  });

  it('keeps the previous title when the caller supplies only a label', () => {
    const id = openSidePaneTerminalTab(scopeA, 't1', 'build');

    setSidePaneInstanceLabel(scopeA, id, { label: 'build (2)' });

    expect(readSidePaneTabInstance(scopeA, id)?.title).toBe('build');
  });

  it('ignores a tab that is not open', () => {
    const before = getSidePaneTabsVersion();

    setSidePaneInstanceLabel(scopeA, 'file:missing.ts', { label: 'x' });

    expect(getSidePaneTabsVersion()).toBe(before);
  });
});

describe('activation', () => {
  it('switches between open tabs', () => {
    activateSidePaneTab(scopeA, 'tasks');

    expect(readSidePaneTabsState(scopeA).active).toBe('tasks');
  });

  it('refuses to activate a tab outside the strip and re-activating the current one', () => {
    activateSidePaneTab(scopeA, 'tasks');
    const before = getSidePaneTabsVersion();

    activateSidePaneTab(scopeA, 'files');
    activateSidePaneTab(scopeA, 'tasks');

    expect(getSidePaneTabsVersion()).toBe(before);
    expect(readSidePaneTabsState(scopeA).active).toBe('tasks');
  });

  it('closes the pane but keeps the strip the reader chose', () => {
    activateSidePaneTab(scopeA, 'tasks');
    deactivateSidePane(scopeA);

    const state = readSidePaneTabsState(scopeA);
    expect(state.active).toBeNull();
    expect(state.open).toContain('tasks');

    const before = getSidePaneTabsVersion();
    deactivateSidePane(scopeA);
    expect(getSidePaneTabsVersion()).toBe(before);
  });
});

describe('removal', () => {
  it('ignores an id that is not in the strip', () => {
    const before = getSidePaneTabsVersion();

    removeSidePaneTab(scopeA, 'files');

    expect(getSidePaneTabsVersion()).toBe(before);
  });

  it('activates the following tab when the active one is removed', () => {
    activateSidePaneTab(scopeA, 'tasks');

    removeSidePaneTab(scopeA, 'tasks');

    expect(readSidePaneTabsState(scopeA).active).toBe('skills');
  });

  it('falls back to the preceding tab when the removed one was last', () => {
    activateSidePaneTab(scopeA, 'analytics');

    removeSidePaneTab(scopeA, 'analytics');

    expect(readSidePaneTabsState(scopeA).active).toBe('mcp');
  });

  it('closes the pane when the last tab goes', () => {
    writeSidePaneTabsState(scopeA, { open: ['tasks'], active: 'tasks', instances: {} });

    removeSidePaneTab(scopeA, 'tasks');

    const state = readSidePaneTabsState(scopeA);
    expect(state.open).toEqual([]);
    expect(state.active).toBeNull();
  });

  it('leaves the other tabs alone when an inactive tab is removed', () => {
    activateSidePaneTab(scopeA, 'skills');

    removeSidePaneTab(scopeA, 'tasks');

    expect(readSidePaneTabsState(scopeA).active).toBe('skills');
  });

  it('disposes an instance and tells its owner, leaving no phantom tab behind', () => {
    const closed: string[] = [];
    const unsubscribe = subscribeSidePaneInstanceClose((scope, instance) => {
      closed.push(`${scope.daemonId}:${instance.id}`);
    });
    const id = openSidePaneFileTab(scopeA, 'src/api.ts');

    removeSidePaneTab(scopeA, id);

    const state = readSidePaneTabsState(scopeA);
    expect(state.open).not.toContain(id);
    expect(state.instances[id]).toBeUndefined();
    expect(closed).toEqual(['daemon-a:file:src/api.ts']);
    expect(state.open).not.toContain('files');

    unsubscribe();
    removeSidePaneTab(scopeA, openSidePaneFileTab(scopeA, 'README.md'));
    expect(closed).toHaveLength(1);
  });

  it('keeps a retained singleton in the registry when it leaves the strip', () => {
    openSidePaneTab(scopeA, 'terminals');

    removeSidePaneTab(scopeA, 'terminals');

    expect(readSidePaneTabsState(scopeA).open).not.toContain('terminals');
    expect(getSidePaneTabDefinition('terminals')?.retain).toBe(true);
  });
});

describe('strip order', () => {
  it('sorts utility tabs by registry order and instances after them, grouped by kind', () => {
    openSidePaneTerminalTab(scopeA, 't1');
    openSidePaneBrowserTab(scopeA, destination('https://x.test/', 'x.test'));
    openSidePaneFileTab(scopeA, 'src/api.ts');

    const open = readSidePaneTabsState(scopeA).open;
    const kinds = open.map(id => parseSidePaneInstanceTabId(id)?.kind ?? 'utility');

    expect(kinds).toEqual(
      [...kinds].sort((a, b) => {
        const rank = { utility: 0, file: 1, browser: 2, terminal: 3 } as const;
        return rank[a] - rank[b];
      }),
    );
  });

  it('sorts an unknown tab last without inventing a position for it', () => {
    expect(sortSidePaneTabs(['ghost', 'analytics', 'tasks'])).toEqual(['tasks', 'analytics', 'ghost']);
    expect(sortSidePaneTabs(['ghost-b', 'ghost-a'])).toEqual(['ghost-a', 'ghost-b']);
  });

  it('breaks an instance tie by label, then by id', () => {
    const instances = {
      'file:a': { id: 'file:a', kind: 'file', key: 'a', label: 'same', title: 'a', order: 1, revision: 1 },
      'file:b': { id: 'file:b', kind: 'file', key: 'b', label: 'same', title: 'b', order: 1, revision: 1 },
    } as const;

    expect(sortSidePaneTabs(['file:b', 'file:a'], instances)).toEqual(['file:a', 'file:b']);
  });

  it('resolves nothing for an id that is neither registered nor a live instance', () => {
    expect(resolveSidePaneTab(scopeA, 'ghost')).toBeUndefined();
  });
});

describe('whole-state writes', () => {
  it('sorts the strip it is handed and notifies subscribers', () => {
    let notifications = 0;
    const unsubscribe = subscribeSidePaneTabsState(() => {
      notifications += 1;
    });

    writeSidePaneTabsState(scopeA, { open: ['analytics', 'tasks'], active: 'tasks', instances: {} });

    expect(readSidePaneTabsState(scopeA).open).toEqual(['tasks', 'analytics']);
    expect(notifications).toBe(1);

    unsubscribe();
    writeSidePaneTabsState(scopeA, { open: ['tasks'], active: 'tasks', instances: {} });
    expect(notifications).toBe(1);
  });

  it('treats a missing instances map as no instances', () => {
    writeSidePaneTabsState(scopeA, { open: ['tasks'], active: null } as never);

    expect(readSidePaneTabsState(scopeA).instances).toEqual({});
  });
});
