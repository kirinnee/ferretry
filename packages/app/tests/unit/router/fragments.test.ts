import { describe, expect, test } from 'bun:test';
import type { ScreenRef } from '../../../src/layout/engine.ts';
import {
  AddressTaker,
  type AddressBrowser,
  type DeclaredFragment,
  fragmentKey,
  HELD_FOR_MS,
  type HoldClock,
} from '../../../src/router/address.ts';
import { routeTable } from '../../../src/router/routes.ts';

/**
 * DECLARED FRAGMENTS (shell contract S3): only a declared, stripping part leaves the address, before anything renders;
 * it is held whole for its one taker, counted per arrival, taken once, and dropped after two minutes. The keyed
 * strings here follow the builders' grammar (`agendaDeepLinkFragment`, `ruleDeepLink`, `machineDetailHash`); the plugin
 * suites run the real builders through the same taker (`@ferretry/app/testing` `fragmentTaker`).
 */

const AGENDA = '#agenda/A3?session=s-1&machine=fy_daemon_abc';
const RULES = '#rules/st_1?machine=fy_daemon_abc';
const MACHINES = '#machines/desk/runtimes/claude';

const screen = (plugin: string, id: string, path: string): ScreenRef => ({ plugin, id, path, label: id });
const join = screen('catalogs', 'join', '/join');
const pair = screen('access', 'pair', '/pair');

const declared: DeclaredFragment[] = [
  { plugin: 'agenda', decl: { form: 'keyed', key: 'agenda' } },
  { plugin: 'accounts', decl: { form: 'keyed', key: 'rules' } },
  { plugin: 'runtimes', decl: { form: 'keyed', key: 'machines', strip: false } },
  { plugin: 'catalogs', decl: { form: 'path', screen: 'join' }, screen: join },
  { plugin: 'access', decl: { form: 'path', screen: 'pair' }, screen: pair },
];

interface FakeBrowser extends AddressBrowser {
  go: (href: string) => void;
  replaced: { state: unknown; url: string }[];
  fire: () => void;
  readonly href: () => string;
}

function browserAt(href: string, state: unknown = { fyEntry: 'e1', fyIndex: 0 }): FakeBrowser {
  const url = new URL(href, 'https://app.test');
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  let current = state;
  const listeners: (() => void)[] = [];
  const replaced: { state: unknown; url: string }[] = [];
  return {
    location,
    history: {
      get state() {
        return current;
      },
      replaceState: (next: unknown, _unused: string, to?: string | URL | null) => {
        current = next;
        const moved = new URL(String(to ?? ''), `https://app.test${location.pathname}`);
        location.pathname = moved.pathname;
        location.search = moved.search;
        location.hash = moved.hash;
        replaced.push({ state: next, url: String(to) });
      },
    } as unknown as AddressBrowser['history'],
    addEventListener: (_type, listener) => void listeners.push(listener),
    go: next => {
      const moved = new URL(next, 'https://app.test');
      location.pathname = moved.pathname;
      location.search = moved.search;
      location.hash = moved.hash;
    },
    replaced,
    fire: () => {
      for (const listener of listeners) listener();
    },
    href: () => `${location.pathname}${location.search}${location.hash}`,
  };
}

function fakeClock(): HoldClock & { advance: (ms: number) => void } {
  let now = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    after: (delayMs, run) => void timers.push({ at: now + delayMs, run }),
    advance: ms => {
      now += ms;
      for (const timer of timers.filter(t => t.at <= now)) timer.run();
    },
  };
}

const device = (plugin: string) => ({ plugin, place: 'device' });

describe('keyed fragments', () => {
  test('a declared key leaves the address at construction, keeping the entry state, and is held whole', () => {
    const browser = browserAt(`/app/${AGENDA}`);
    const taker = new AddressTaker(declared, browser);
    expect(browser.href()).toBe('/app/');
    expect(browser.replaced).toEqual([{ state: { fyEntry: 'e1', fyIndex: 0 }, url: '/app/' }]);
    const slot = taker.slotFor(device('agenda'), 'agenda') as string;
    expect(taker.arrival(slot)).toBe(1);
    // The whole part, `?` and `&` included, reaches the taker as it arrived.
    expect(taker.take(slot)).toBe(AGENDA);
    expect(taker.take(slot)).toBeUndefined();
  });

  test('the rules link survives the split whole too', () => {
    const browser = browserAt(`/${RULES}`);
    const taker = new AddressTaker(declared, browser);
    expect(browser.href()).toBe('/');
    expect(taker.take(taker.slotFor(device('accounts'), 'rules') as string)).toBe(RULES);
  });

  test('an undeclared hash and a strip:false key stay exactly as they were, and are not held', () => {
    for (const hash of ['#elsewhere/1', '#anything', MACHINES, '#Agenda/A3', '#9x/1']) {
      const browser = browserAt(`/d/d1/settings${hash}`);
      const taker = new AddressTaker(declared, browser);
      browser.fire();
      expect(browser.href()).toBe(`/d/d1/settings${hash}`);
      expect(browser.replaced).toEqual([]);
      expect(taker.slotFor(device('runtimes'), 'machines')).toBeUndefined();
    }
  });

  test('a second arrival (hashchange) replaces the held value and bumps the count', () => {
    const browser = browserAt(`/${AGENDA}`);
    const taker = new AddressTaker(declared, browser);
    const slot = taker.slotFor(device('agenda'), 'agenda') as string;
    let heard = 0;
    taker.subscribe(() => {
      heard += 1;
    });
    browser.go('/#agenda/A4');
    browser.fire();
    expect(taker.arrival(slot)).toBe(2);
    expect(heard).toBe(1);
    expect(taker.take(slot)).toBe('#agenda/A4');
  });

  test('only the declaring plugin, in its device view, may take a keyed fragment', () => {
    const taker = new AddressTaker(declared, browserAt(`/${AGENDA}`));
    expect(taker.slotFor(device('agenda'), 'agenda')).toBe('keyed:agenda');
    expect(taker.slotFor(device('accounts'), 'agenda')).toBeUndefined();
    expect(taker.slotFor({ plugin: 'agenda', place: 'daemon' }, 'agenda')).toBeUndefined();
    expect(taker.slotFor({ plugin: 'agenda', place: 'device-panel' }, 'agenda')).toBeUndefined();
    expect(taker.slotFor({ plugin: 'agenda', place: 'daemonless', screen: 'agenda' }, 'agenda')).toBeUndefined();
    expect(taker.slotFor(device('agenda'), 'nobody')).toBeUndefined();
  });

  test('of two plugins declaring one key, only the first keeps it; a key outside the grammar is never claimed', () => {
    const taker = new AddressTaker(
      [
        { plugin: 'first', decl: { form: 'keyed', key: 'shared' } },
        { plugin: 'second', decl: { form: 'keyed', key: 'shared' } },
        { plugin: 'odd', decl: { form: 'keyed', key: 'Bad Key' } },
      ],
      browserAt('/'),
    );
    expect(taker.slotFor(device('first'), 'shared')).toBe('keyed:shared');
    expect(taker.slotFor(device('second'), 'shared')).toBeUndefined();
    expect(taker.slotFor(device('odd'), 'Bad Key')).toBeUndefined();
  });

  test('the key is the text before the first / or =', () => {
    expect(fragmentKey('#agenda/A3?x=1')).toBe('agenda');
    expect(fragmentKey('#rules=st_1')).toBe('rules');
    expect(fragmentKey('agenda/A3')).toBe('agenda');
    expect(fragmentKey('#agenda')).toBeUndefined();
    expect(fragmentKey('#/x')).toBeUndefined();
    expect(fragmentKey('#Agenda/x')).toBeUndefined();
    expect(fragmentKey('')).toBeUndefined();
  });
});

describe('path fragments', () => {
  test('at the screen (by the router’s own parse) the whole fragment is stripped and held for that screen', () => {
    for (const path of ['/join', '/join/', '/app/join', '/j%6Fin']) {
      const browser = browserAt(`${path}#code-1`);
      const taker = new AddressTaker(declared, browser);
      expect(browser.location.hash).toBe('');
      const slot = taker.slotFor({ plugin: 'catalogs', place: 'daemonless', screen: 'join' }, 'join') as string;
      expect(taker.take(slot)).toBe('#code-1');
    }
  });

  test('beneath the screen (/join/x#code) the code leaves the address and nobody is handed it', () => {
    const browser = browserAt('/join/x#code-1');
    const taker = new AddressTaker(declared, browser);
    expect(browser.href()).toBe('/join/x');
    const slot = taker.slotFor({ plugin: 'catalogs', place: 'daemonless', screen: 'join' }, 'join') as string;
    expect(taker.arrival(slot)).toBe(0);
    expect(taker.take(slot)).toBeUndefined();
  });

  test('a cold /pair#v1… served from the /app shell reaches the pair screen and hands its fragment to the pair taker', () => {
    // Pages serves the shell for `/pair` with the visitor's path and fragment intact (public/_redirects → `/app/`).
    // An obviously fake code: nothing here is, or may become, a real pairing code.
    const browser = browserAt('/pair#v1;FAKE-NOT-A-REAL-CODE');
    const taker = new AddressTaker(declared, browser);
    expect(browser.href()).toBe('/pair');
    expect(routeTable([pair]).parse(browser.location.pathname)).toEqual({ kind: 'screen', screen: pair, params: {} });
    const slot = taker.slotFor({ plugin: 'access', place: 'daemonless', screen: 'pair' }, 'pair') as string;
    expect(taker.take(slot)).toBe('#v1;FAKE-NOT-A-REAL-CODE');
  });

  test('a path fragment is taken only on its own declaring daemon-less screen', () => {
    const taker = new AddressTaker(declared, browserAt('/pair#v1.code'));
    expect(taker.slotFor({ plugin: 'access', place: 'daemonless', screen: 'pair' }, 'pair')).toBe('path:access.pair');
    expect(taker.slotFor({ plugin: 'access', place: 'daemonless', screen: 'other' }, 'pair')).toBeUndefined();
    expect(taker.slotFor({ plugin: 'catalogs', place: 'daemonless', screen: 'pair' }, 'pair')).toBeUndefined();
    expect(taker.slotFor({ plugin: 'access', place: 'daemon' }, 'pair')).toBeUndefined();
    expect(taker.slotFor({ plugin: 'access', place: 'device' }, 'pair')).toBeUndefined();
  });

  test('a path declaration on a screen the plugin does not own, or that is not daemon-less, takes nothing', () => {
    const browser = browserAt('/join#code');
    const taker = new AddressTaker(
      [
        { plugin: 'thief', decl: { form: 'path', screen: 'join' }, screen: join },
        { plugin: 'catalogs', decl: { form: 'path', screen: 'home' }, screen: screen('catalogs', 'home', 'home') },
        { plugin: 'catalogs', decl: { form: 'path', screen: 'ghost' } },
      ],
      browser,
    );
    expect(browser.href()).toBe('/join#code');
    expect(taker.slotFor({ plugin: 'thief', place: 'daemonless', screen: 'join' }, 'join')).toBeUndefined();
  });

  test('a declared screen with no fragment rewrites nothing', () => {
    const browser = browserAt('/join');
    new AddressTaker(declared, browser);
    expect(browser.replaced).toEqual([]);
    const empty = browserAt('/join#');
    new AddressTaker(declared, empty);
    expect(empty.replaced).toEqual([]);
  });
});

describe('holding', () => {
  test('a held fragment no one takes is gone after two minutes (a pairing code is a live credential)', () => {
    const clock = fakeClock();
    const taker = new AddressTaker(declared, browserAt('/pair#v1.code'), clock);
    const slot = 'path:access.pair';
    clock.advance(HELD_FOR_MS - 1);
    // Still held one millisecond before.
    const early = new AddressTaker(declared, browserAt('/pair#v1.other'), clock);
    expect(early.take(slot)).toBe('#v1.other');
    clock.advance(1);
    expect(taker.take(slot)).toBeUndefined();
    expect(taker.arrival(slot)).toBe(1);
  });

  test('the expiry holds even if the timer never ran (the take checks the clock)', () => {
    let now = 0;
    const taker = new AddressTaker(declared, browserAt('/pair#v1.code'), { now: () => now, after: () => {} });
    now = HELD_FOR_MS;
    expect(taker.take('path:access.pair')).toBeUndefined();
  });

  test('the expiry timer forgets the held code itself: a live credential does not stay in memory', () => {
    const timers: (() => void)[] = [];
    // A clock that never moves: only the timer can drop the value.
    const taker = new AddressTaker(declared, browserAt('/pair#v1.code'), {
      now: () => 0,
      after: (_ms, run) => void timers.push(run),
    });
    for (const run of timers) run();
    expect(taker.take('path:access.pair')).toBeUndefined();
  });

  test('an expiry timer for an older arrival does not drop a newer one', () => {
    const clock = fakeClock();
    const browser = browserAt('/pair#v1.first');
    const taker = new AddressTaker(declared, browser, clock);
    clock.advance(HELD_FOR_MS / 2);
    browser.go('/pair#v1.second');
    browser.fire();
    clock.advance(HELD_FOR_MS / 2);
    expect(taker.take('path:access.pair')).toBe('#v1.second');
  });

  test('with no browser nothing is read, held or rewritten', () => {
    const taker = new AddressTaker(declared);
    taker.read();
    expect(taker.arrival('keyed:agenda')).toBe(0);
    expect(taker.take('keyed:agenda')).toBeUndefined();
    const stop = taker.subscribe(() => {});
    stop();
  });
});

/**
 * THE EARLY ARRIVAL (`public/arrival.js`, run before the module graph is fetched): the fragment is already off the
 * address when the taker is built, and the value reaches it through ONE function on `window` that the taker calls
 * once, with what is left of the two minutes counted from the arrival. The taker takes it by the plugins' own
 * declarations.
 */
describe('early arrival', () => {
  const EARLY = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00'; // an obviously fake pairing fragment
  /** What the script's hand-off returns, and how often it was called. */
  const withEarly = (
    browser: FakeBrowser,
    pathname: string,
    hash: string,
    remainingMs: number = HELD_FOR_MS,
  ): FakeBrowser & { readonly calls: () => number } => {
    let calls = 0;
    Object.defineProperty(browser, '__fyArrival', {
      configurable: true,
      value: () => {
        calls += 1;
        return calls === 1 ? { pathname, hash, remainingMs } : undefined;
      },
    });
    return Object.assign(browser, { calls: () => calls });
  };

  test('a fragment the early script took is held for its declared screen, with nothing left to rewrite', () => {
    const browser = withEarly(browserAt('/pair'), '/pair', EARLY);
    const taker = new AddressTaker(declared, browser);
    expect(browser.href()).toBe('/pair');
    expect(browser.replaced).toEqual([]);
    expect(taker.arrival('path:access.pair')).toBe(1);
    expect(taker.take('path:access.pair')).toBe(EARLY);
    expect(taker.take('path:access.pair')).toBeUndefined();
  });

  test('the hand-off is called once and leaves the window, so nothing else can read the code from there', () => {
    const browser = withEarly(browserAt('/app/pair'), '/app/pair', EARLY);
    new AddressTaker(declared, browser);
    expect(browser.calls()).toBe(1);
    expect('__fyArrival' in browser).toBe(false);
    expect(new AddressTaker(declared, browser).arrival('path:access.pair')).toBe(0);
  });

  test('an arrival beneath a screen, or on a path nobody declares, is dropped and handed to no one', () => {
    for (const pathname of ['/pair/extra', '/settings', '/d/d1/settings']) {
      const taker = new AddressTaker(declared, withEarly(browserAt(pathname), pathname, EARLY));
      expect(taker.take('path:access.pair')).toBeUndefined();
      expect(taker.take('path:catalogs.join')).toBeUndefined();
    }
  });

  test('the hold still ends after two minutes when the taker is built at once', () => {
    const clock = fakeClock();
    const taker = new AddressTaker(declared, withEarly(browserAt('/pair'), '/pair', EARLY), clock);
    clock.advance(HELD_FOR_MS);
    expect(taker.take('path:access.pair')).toBeUndefined();
  });

  test('a late boot does NOT restart the hold: it ends at the original deadline, and not a moment later', () => {
    const clock = fakeClock();
    // The script reports 30 s left: the module took 90 s to boot.
    const taker = new AddressTaker(declared, withEarly(browserAt('/pair'), '/pair', EARLY, 30_000), clock);
    clock.advance(29_999);
    expect(taker.take('path:access.pair')).toBe(EARLY);
    const expired = new AddressTaker(declared, withEarly(browserAt('/pair'), '/pair', EARLY, 30_000), clock);
    clock.advance(30_000);
    expect(expired.take('path:access.pair')).toBeUndefined();
  });

  test('a hand-off that is spent, odd, throws or reports no time left gives nothing, and is removed', () => {
    const values: unknown[] = [
      null,
      'x',
      { pathname: '/pair', hash: EARLY, remainingMs: 1 }, // a value, not a function
      () => undefined,
      () => {
        throw new Error('spent');
      },
      () => ({ pathname: 1, hash: EARLY, remainingMs: 5 }),
      () => ({ pathname: '/pair', hash: '#', remainingMs: 5 }),
      () => ({ pathname: '/pair', hash: EARLY, remainingMs: 0 }),
      () => ({ pathname: '/pair', hash: EARLY, remainingMs: -1 }),
      () => ({ pathname: '/pair', hash: EARLY, remainingMs: HELD_FOR_MS + 1 }),
      () => ({ pathname: '/pair', hash: EARLY }),
    ];
    for (const value of values) {
      const browser = Object.defineProperty(browserAt('/pair'), '__fyArrival', { configurable: true, value });
      const taker = new AddressTaker(declared, browser);
      expect(taker.arrival('path:access.pair')).toBe(0);
      expect('__fyArrival' in browser).toBe(false);
    }
  });
});

/**
 * A PAIRING-SHAPED FRAGMENT ON A PATH NO ONE DECLARED has no taker, and a live code must not sit in the address: the
 * runtime reader drops it too, at construction, on every hashchange and after the router's own pushState (the router
 * calls `read` after every write).
 */
describe('a credential on an undeclared path', () => {
  const FAKE = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00';

  test('is stripped at construction, keeping the entry state, and held by nobody', () => {
    for (const path of ['/app/', '/', '/pairing', '/d/d1/settings']) {
      const browser = browserAt(`${path}${FAKE}`);
      const taker = new AddressTaker(declared, browser);
      expect(browser.href()).toBe(path);
      expect(browser.replaced).toEqual([{ state: { fyEntry: 'e1', fyIndex: 0 }, url: path }]);
      expect(taker.take('path:access.pair')).toBeUndefined();
      expect(taker.take('path:catalogs.join')).toBeUndefined();
    }
  });

  test('is stripped when it arrives later by hashchange, or by a router write followed by read', () => {
    const browser = browserAt('/app/');
    const taker = new AddressTaker(declared, browser);
    browser.go(`/app/${FAKE}`);
    browser.fire();
    expect(browser.href()).toBe('/app/');
    browser.go(`/settings${FAKE}`); // pushState puts it there and fires nothing
    taker.read();
    expect(browser.href()).toBe('/settings');
    expect(taker.take('path:access.pair')).toBeUndefined();
  });

  test('a keyed or unrelated fragment on the same path is still left alone', () => {
    for (const hash of ['#agenda-ish', '#v2;x=1', '#v10', '#xv1;a=1', '#machines/desk']) {
      const browser = browserAt(`/app/${hash}`);
      new AddressTaker(declared, browser);
      expect(browser.href()).toBe(`/app/${hash}`);
      expect(browser.replaced).toEqual([]);
    }
  });
});
