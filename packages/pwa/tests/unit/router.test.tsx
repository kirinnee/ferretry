import { afterEach, describe, expect, it } from 'bun:test';

import {
  browserTrailStorage,
  destinationPath,
  ROUTER_TRAIL_KEY,
  RouterProvider,
  type RouterTrailStorage,
  readTrail,
  useOptionalRouter,
  useRouter,
} from '../../src/lib/router.tsx';
import { interact, type Mounted, mount } from '../support/dom.ts';

function RouterProbe() {
  const { route, navigate } = useRouter();
  const daemonId =
    route.kind === 'connection-picker' || route.kind === 'setup'
      ? 'none'
      : route.kind === 'legacy-tasks-redirect' || route.kind === 'legacy-attention-redirect'
        ? route.to.daemonId
        : route.daemonId;
  return (
    <div>
      <output data-kind={route.kind} data-daemon={daemonId}>
        {route.kind === 'session' ? route.sessionId : route.kind}
      </output>
      <button type="button" onClick={() => navigate('/d/daemon-b/session/shared')}>
        Open shared
      </button>
    </div>
  );
}

const setPath = (path: string): void => window.history.replaceState({}, '', path);

afterEach(() => setPath('/'));

describe('RouterProvider', () => {
  it('reads the daemon-qualified route from the current browser location', async () => {
    setPath('/d/daemon-a/session/one');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    const output = view.container.querySelector('output');
    expect(output?.dataset.kind).toBe('session');
    expect(output?.dataset.daemon).toBe('daemon-a');
    expect(output?.textContent).toBe('one');
    await view.unmount();
  });

  it('pushes an in-app path and updates the rendered route in the same turn', async () => {
    setPath('/d/daemon-a');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    await interact(() => view.container.querySelector('button')?.click());

    const output = view.container.querySelector('output');
    expect(window.location.pathname).toBe('/d/daemon-b/session/shared');
    expect(output?.dataset.kind).toBe('session');
    expect(output?.dataset.daemon).toBe('daemon-b');
    expect(output?.textContent).toBe('shared');
    await view.unmount();
  });

  it('tracks browser back, forward, and other popstate navigation', async () => {
    setPath('/d/daemon-a');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    window.history.pushState({}, '', '/d/daemon-b/settings');
    await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));

    const output = view.container.querySelector('output');
    expect(output?.dataset.kind).toBe('settings');
    expect(output?.dataset.daemon).toBe('daemon-b');
    await view.unmount();
  });

  it('replaces the legacy tasks bookmark with the canonical board path', async () => {
    setPath('/d/daemon-a/tasks');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    const output = view.container.querySelector('output');
    expect(window.location.pathname).toBe('/d/daemon-a/board');
    expect(output?.dataset.kind).toBe('board');
    expect(output?.dataset.daemon).toBe('daemon-a');
    await view.unmount();
  });

  it('redirects the old /attention address to /inbox, keeping the query', async () => {
    setPath('/d/daemon-a/attention?from=warden');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    const output = view.container.querySelector('output');
    expect(window.location.pathname).toBe('/d/daemon-a/inbox');
    expect(window.location.search).toBe('?from=warden');
    expect(output?.dataset.kind).toBe('attention');
    await view.unmount();
  });

  it('unsubscribes from browser history when the root unmounts', async () => {
    setPath('/d/daemon-a');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );
    const rendered = view.container.textContent;

    await view.unmount();
    window.history.pushState({}, '', '/d/daemon-b');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(view.container.textContent).toBe('');
    expect(rendered).toContain('home');
  });

  it('fails closed when a consumer is mounted without the app-root provider', async () => {
    await expect(mount(<RouterProbe />)).rejects.toThrow('useRouter must be rendered inside RouterProvider');
  });
});

/* ---------- history entry identity, the trail, and an in-app Back ---------- */

/** One entry of {@link FakeBrowser}'s history: what `history.state` holds there and the URL it shows. */
interface FakeEntry {
  state: unknown;
  url: URL;
}

/**
 * A browser whose history is a plain list a test can read and step through.
 *
 * happy-dom's own `history.back()` neither moves synchronously nor dispatches `popstate` the way a
 * browser does, so Back and Forward are driven here: `back`/`forward` move the cursor and fire
 * `popstate` exactly as a browser's own buttons do, with no clock involved.
 */
class FakeBrowser extends EventTarget {
  readonly entries: FakeEntry[];
  index = 0;
  backCalls = 0;
  readonly history = {
    back: (): void => {
      this.backCalls += 1;
      this.go(-1);
    },
    pushState: (state: unknown, _title: string, url?: string | URL | null): void => {
      this.entries.splice(this.index + 1, this.entries.length, { state, url: this.resolve(url) });
      this.index += 1;
    },
    replaceState: (state: unknown, _title: string, url?: string | URL | null): void => {
      this.entries[this.index] = { state, url: this.resolve(url) };
    },
  } as unknown as History;
  readonly location: Pick<Location, 'pathname' | 'search'>;

  constructor(path: string, state: unknown = null) {
    super();
    this.entries = [{ state, url: new URL(path, 'https://pwa.example.test') }];
    this.location = Object.defineProperties(
      {},
      {
        pathname: { get: () => this.current.url.pathname },
        search: { get: () => this.current.url.search },
      },
    ) as Pick<Location, 'pathname' | 'search'>;
    Object.defineProperty(this.history, 'state', { get: () => this.current.state });
  }

  get current(): FakeEntry {
    return this.entries[this.index] as FakeEntry;
  }

  /** The browser's own Back (`-1`) or Forward (`+1`) button. */
  go(delta: number): void {
    this.index += delta;
    this.dispatchEvent(new Event('popstate'));
  }

  /** A page writing its own entry, the way a `location.hash` assignment or a third-party pushState does. */
  foreignPush(state: unknown, path: string): void {
    this.history.pushState(state, '', path);
    this.dispatchEvent(new Event('popstate'));
  }

  private resolve(url: string | URL | null | undefined): URL {
    return url === undefined || url === null ? this.current.url : new URL(url, this.current.url);
  }
}

/** A `sessionStorage` stand-in that keeps what it is given, readable by the test. */
class MemoryTrailStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/** Mints `entry-1`, `entry-2`, … so every identity in an assertion is a literal. */
const countingKeys = (): (() => string) => {
  let next = 0;
  return () => {
    next += 1;
    return `entry-${next}`;
  };
};

/** Shows the route, the entry identity, and offers navigate/replace/back to whatever `to` names. */
function EntryProbe() {
  const router = useRouter();
  return (
    <div>
      <output data-entry={router.entryKey} data-kind={router.route.kind}>
        {router.route.kind}
      </output>
      <button type="button" data-act="push" onClick={() => router.navigate('/d/daemon-a/settings')}>
        push
      </button>
      <button
        type="button"
        data-act="replace"
        onClick={() => router.navigate('/d/daemon-a/projects', { replace: true })}
      >
        replace
      </button>
      <button type="button" data-act="back" onClick={() => router.back('/d/daemon-a?from=chat#top')}>
        back
      </button>
      <button type="button" data-act="back-elsewhere" onClick={() => router.back('/d/daemon-b')}>
        back elsewhere
      </button>
    </div>
  );
}

const mountEntries = async (
  browser: FakeBrowser,
  trailStorage: RouterTrailStorage | null = new MemoryTrailStorage(),
  newEntryKey = countingKeys(),
) =>
  await mount(
    <RouterProvider browser={browser as unknown as Window} newEntryKey={newEntryKey} trailStorage={trailStorage}>
      <EntryProbe />
    </RouterProvider>,
  );

const entryOf = (view: Mounted): string | undefined => view.container.querySelector('output')?.dataset.entry;
const kindOf = (view: Mounted): string | undefined => view.container.querySelector('output')?.dataset.kind;
const press = async (view: Mounted, act: string): Promise<void> =>
  await interact(() => view.container.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)?.click());
const trailOf = (storage: MemoryTrailStorage): unknown => JSON.parse(storage.getItem(ROUTER_TRAIL_KEY) ?? 'null');

describe('RouterProvider history entries', () => {
  it('adopts the first entry, mints a new identity on push, and keeps each one across Back and Forward', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a');
    const view = await mountEntries(browser);
    try {
      const first = entryOf(view);

      // Act
      await press(view, 'push');
      const pushed = entryOf(view);
      await interact(() => browser.go(-1));
      const afterBack = entryOf(view);
      await interact(() => browser.go(1));
      const afterForward = entryOf(view);

      // Assert
      expect(first).toBe('entry-1');
      expect(browser.entries[0]?.state).toEqual({ fyEntry: 'entry-1', fyIndex: 0 });
      expect(pushed).toBe('entry-2');
      expect(browser.entries[1]?.state).toEqual({ fyEntry: 'entry-2', fyIndex: 1 });
      expect(afterBack).toBe('entry-1');
      expect(afterForward).toBe('entry-2');
      expect(kindOf(view)).toBe('settings');
    } finally {
      await view.unmount();
    }
  });

  it('keeps the identity, and the page’s own history fields, when an entry is replaced', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a', { pageOwned: 'kept', fyEntry: 'entry-9', fyIndex: 0 });
    const storage = new MemoryTrailStorage();
    const view = await mountEntries(browser, storage);
    try {
      // Act
      await press(view, 'replace');

      // Assert
      expect(entryOf(view)).toBe('entry-9');
      expect(browser.entries).toHaveLength(1);
      expect(browser.current.state).toEqual({ pageOwned: 'kept', fyEntry: 'entry-9', fyIndex: 0 });
      expect(browser.location.pathname).toBe('/d/daemon-a/projects');
      expect(trailOf(storage)).toEqual([{ key: 'entry-9', path: '/d/daemon-a/projects' }]);
    } finally {
      await view.unmount();
    }
  });

  it('adopts an entry a page pushed itself, after the one on screen, keeping that page’s state', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a');
    const storage = new MemoryTrailStorage();
    const view = await mountEntries(browser, storage);
    try {
      // Act
      await interact(() => browser.foreignPush({ hashOwner: 'continue' }, '/d/daemon-a/new#continue'));

      // Assert
      expect(entryOf(view)).toBe('entry-2');
      expect(browser.current.state).toEqual({ hashOwner: 'continue', fyEntry: 'entry-2', fyIndex: 1 });
      expect(trailOf(storage)).toEqual([
        { key: 'entry-1', path: '/d/daemon-a' },
        { key: 'entry-2', path: '/d/daemon-a/new' },
      ]);
    } finally {
      await view.unmount();
    }
  });

  it('reads its trail back after a reload, so the restored entry keeps its identity and Back still steps', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a');
    const storage = new MemoryTrailStorage();
    const first = await mountEntries(browser, storage);
    await press(first, 'push');
    await first.unmount();
    const writesBefore = storage.getItem(ROUTER_TRAIL_KEY);

    // Act
    const reloaded = await mountEntries(browser, storage, () => 'never-minted');
    try {
      const restored = entryOf(reloaded);
      await press(reloaded, 'back');

      // Assert
      expect(restored).toBe('entry-2');
      // A restored entry the trail already records is not written again.
      expect(writesBefore).toBe(JSON.stringify(trailOf(storage)));
      expect(browser.backCalls).toBe(1);
      expect(browser.index).toBe(0);
      expect(entryOf(reloaded)).toBe('entry-1');
    } finally {
      await reloaded.unmount();
    }
  });

  it('records a reloaded entry whose recorded path no longer matches what it shows', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a/settings', { fyEntry: 'entry-5', fyIndex: 0 });
    const storage = new MemoryTrailStorage();
    storage.setItem(ROUTER_TRAIL_KEY, JSON.stringify([{ key: 'entry-5', path: '/d/daemon-a' }]));

    // Act
    const view = await mountEntries(browser, storage);
    try {
      // Assert
      expect(entryOf(view)).toBe('entry-5');
      expect(trailOf(storage)).toEqual([{ key: 'entry-5', path: '/d/daemon-a/settings' }]);
    } finally {
      await view.unmount();
    }
  });

  it.each([
    ['the previous entry is a different page', [{ key: 'entry-0', path: '/d/daemon-a/projects' }]],
    ['the previous entry is unreadable', [42]],
    ['there is no previous entry', []],
  ])('pushes the destination for an in-app Back when %s', async (_case, before) => {
    // Arrange
    const storage = new MemoryTrailStorage();
    const index = before.length;
    storage.setItem(ROUTER_TRAIL_KEY, JSON.stringify([...before, { key: 'entry-here', path: '/d/daemon-a/settings' }]));
    const browser = new FakeBrowser('/d/daemon-a/settings', { fyEntry: 'entry-here', fyIndex: index });
    const view = await mountEntries(browser, storage);
    try {
      // Act
      await press(view, 'back');

      // Assert
      expect(browser.backCalls).toBe(0);
      expect(browser.entries).toHaveLength(2);
      expect(browser.current.url.href).toBe('https://pwa.example.test/d/daemon-a?from=chat#top');
      expect(browser.current.state).toEqual({ fyEntry: 'entry-1', fyIndex: index + 1 });
      expect(kindOf(view)).toBe('home');
    } finally {
      await view.unmount();
    }
  });

  it('steps back through history for an in-app Back whose destination is the entry behind it', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a');
    const view = await mountEntries(browser);
    try {
      await press(view, 'push');

      // Act
      await press(view, 'back');

      // Assert
      expect(browser.backCalls).toBe(1);
      expect(browser.entries).toHaveLength(2);
      expect(entryOf(view)).toBe('entry-1');
      expect(kindOf(view)).toBe('home');
    } finally {
      await view.unmount();
    }
  });

  it('pushes rather than stepping back when the entry behind names another page', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a');
    const view = await mountEntries(browser);
    try {
      await press(view, 'push');

      // Act
      await press(view, 'back-elsewhere');

      // Assert
      expect(browser.backCalls).toBe(0);
      expect(browser.entries.map(entry => entry.url.pathname)).toEqual([
        '/d/daemon-a',
        '/d/daemon-a/settings',
        '/d/daemon-b',
      ]);
      expect(entryOf(view)).toBe('entry-3');
    } finally {
      await view.unmount();
    }
  });

  it('truncates the forward trail when a push follows a step back', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a');
    const storage = new MemoryTrailStorage();
    const view = await mountEntries(browser, storage);
    try {
      await press(view, 'push');
      await interact(() => browser.go(-1));

      // Act
      await press(view, 'back-elsewhere');

      // Assert
      expect(trailOf(storage)).toEqual([
        { key: 'entry-1', path: '/d/daemon-a' },
        { key: 'entry-3', path: '/d/daemon-b' },
      ]);
    } finally {
      await view.unmount();
    }
  });

  it('keeps navigating when the trail cannot be stored, and with no storage at all', async () => {
    // Arrange
    const refusing: RouterTrailStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    for (const storage of [refusing, null]) {
      const browser = new FakeBrowser('/d/daemon-a');
      const view = await mountEntries(browser, storage);
      try {
        // Act
        await press(view, 'push');

        // Assert
        expect(entryOf(view)).toBe('entry-2');
        expect(kindOf(view)).toBe('settings');
      } finally {
        await view.unmount();
      }
    }
  });

  it('replaces a legacy tasks bookmark in place, keeping the entry’s identity', async () => {
    // Arrange
    const browser = new FakeBrowser('/d/daemon-a/tasks');

    // Act
    const view = await mountEntries(browser);
    try {
      // Assert
      expect(browser.entries).toHaveLength(1);
      expect(browser.location.pathname).toBe('/d/daemon-a/board');
      expect(browser.current.state).toEqual({ fyEntry: 'entry-1', fyIndex: 0 });
      expect(entryOf(view)).toBe('entry-1');
      expect(kindOf(view)).toBe('board');
    } finally {
      await view.unmount();
    }
  });
});

describe('readTrail', () => {
  const stored = (raw: string | null): RouterTrailStorage => ({ getItem: () => raw, setItem: () => undefined });

  it.each([
    ['no storage', null, []],
    ['nothing stored', stored(null), []],
    ['junk that is not JSON', stored('{not json'), []],
    ['JSON that is not a list', stored('{"key":"a","path":"/"}'), []],
    [
      'a list with unreadable entries',
      stored(JSON.stringify([{ key: 'a', path: '/' }, null, 'b', { key: 1, path: '/' }, { key: 'c' }])),
      [{ key: 'a', path: '/' }, null, null, null, null],
    ],
    [
      'entries with extra fields',
      stored(JSON.stringify([{ key: 'a', path: '/x', extra: true }])),
      [{ key: 'a', path: '/x' }],
    ],
  ])('reads %s', (_case, storage, expected) => {
    // Act
    const actual = readTrail(storage);

    // Assert
    expect(actual).toEqual(expected);
  });

  it('reads a store whose getter throws as a fresh tab', () => {
    // Arrange
    const throwing: RouterTrailStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };

    // Act
    const actual = readTrail(throwing);

    // Assert
    expect(actual).toEqual([]);
  });
});

describe('browserTrailStorage', () => {
  it('answers the tab’s session storage', () => {
    // Arrange
    const sessionStorage = new MemoryTrailStorage() as unknown as Storage;

    // Act
    const actual = browserTrailStorage({ sessionStorage });

    // Assert
    expect(actual).toBe(sessionStorage);
  });

  it('answers null where reading session storage throws', () => {
    // Arrange
    const refusing = {
      get sessionStorage(): Storage {
        throw new Error('SecurityError: the document is sandboxed');
      },
    };

    // Act
    const actual = browserTrailStorage(refusing);

    // Assert
    expect(actual).toBeNull();
  });
});

describe('destinationPath', () => {
  it.each([
    ['/d/daemon-a', '/d/daemon-a'],
    ['/d/daemon-a?from=chat', '/d/daemon-a'],
    ['/d/daemon-a/new#continue', '/d/daemon-a/new'],
    ['https://elsewhere.example.test/d/daemon-b?x=1#y', '/d/daemon-b'],
  ])('reads %s as the page %s', (input, expected) => {
    // Act
    const actual = destinationPath(input);

    // Assert
    expect(actual).toBe(expected);
  });
});

describe('useOptionalRouter', () => {
  function OptionalProbe() {
    const router = useOptionalRouter();
    return <output>{router === null ? 'none' : router.route.kind}</output>;
  }

  it('answers null outside a router and the router inside one', async () => {
    // Arrange
    setPath('/d/daemon-a');

    // Act
    const outside = await mount(<OptionalProbe />);
    const inside = await mount(
      <RouterProvider trailStorage={null}>
        <OptionalProbe />
      </RouterProvider>,
    );
    try {
      // Assert
      expect(outside.container.textContent).toBe('none');
      expect(inside.container.textContent).toBe('home');
    } finally {
      await outside.unmount();
      await inside.unmount();
    }
  });
});
