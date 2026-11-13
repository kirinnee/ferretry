/**
 * `public/arrival.js` must take a declared pairing or share fragment off the address, synchronously, before anything
 * else on the page runs, hand it to ONE consumer ONCE, and drop everything that has no declared taker (shell contract
 * S3). Like `pre-paint.test.ts`, this runs the REAL FILE (read from disk, executed with `window`, `Date` and
 * `setTimeout` supplied as parameters), because the script is a hand-written classic script nothing imports or
 * typechecks. Its list of paths is a second statement of the plugins' declared `path` fragments, and the drift test
 * fails if the two ever differ.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAIRING_FRAGMENT_PATTERN } from '../../../plugins/access/contract/pairing.ts';
import { registeredFragments } from '../../src/connect/provides.ts';
import { generated } from '../../src/generated/surfaces.ts';
import { viewsOf } from '../../src/layout/engine.ts';
import { AddressTaker, CREDENTIAL_FRAGMENT, EARLY_ARRIVAL_KEY, HELD_FOR_MS } from '../../src/router/address.ts';

const source = readFileSync(join(import.meta.dir, '../../public/arrival.js'), 'utf8');
const FAKE = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00'; // an obviously fake pairing fragment

type Listener = () => void;
interface Run {
  readonly window: Record<string, unknown> & {
    location: { pathname: string; search: string; hash: string };
    history: { state: unknown; replaceState: unknown };
  };
  readonly replaced: { state: unknown; url: string }[];
  /** A same-document arrival: the fragment changes and the browser fires these events. */
  readonly arrive: (hash: string, ...types: string[]) => void;
  /** Advances the driven clock; timers that fall due run. Without `throttled`, as the browser would. */
  readonly advance: (ms: number, throttled?: boolean) => void;
}

/** Runs the script against one address, as the parser would, and reports what it did to the address and the window. */
function boot(href: string, options: { drop?: boolean; refuse?: boolean } = {}): Run {
  const url = new URL(href, 'https://app.test');
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  const replaced: { state: unknown; url: string }[] = [];
  const listeners = new Map<string, Listener[]>();
  let now = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  const win: Run['window'] = {
    location,
    document: { currentScript: { hasAttribute: (name: string) => options.drop === true && name === 'data-drop' } },
    history: {
      state: { fyEntry: 'e1', fyIndex: 0 },
      replaceState: (state: unknown, _title: string, to: string) => {
        if (options.refuse === true) throw new Error('SecurityError');
        replaced.push({ state, url: to });
        location.hash = '';
      },
    },
    addEventListener: (type: string, listener: Listener) =>
      void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };
  const fakeDate = { now: () => now };
  const fakeTimeout = (run: () => void, delay: number) => void timers.push({ at: now + delay, run });
  new Function('window', 'Date', 'setTimeout', source)(win, fakeDate, fakeTimeout);
  return {
    window: win,
    replaced,
    arrive: (hash, ...types) => {
      location.hash = hash;
      for (const type of types.length > 0 ? types : ['hashchange'])
        for (const listener of listeners.get(type) ?? []) listener();
    },
    advance: (ms, throttled = false) => {
      now += ms;
      if (!throttled) for (const timer of timers.filter(t => t.at <= now)) timer.run();
    },
  };
}

type Take = () => { pathname: string; hash: string; remainingMs: number } | undefined;
/** The consumer's end of the hand-off: the function the script leaves on the window, or `undefined` when none is there. */
const handoff = (run: Run): Take | undefined => {
  const found = run.window[EARLY_ARRIVAL_KEY];
  return typeof found === 'function' ? (found as Take) : undefined;
};
const taken = (run: Run) => handoff(run)?.();
/** Whatever the window exposes, by any route a page script has: own names, descriptors and values, stringified. */
const exposed = (run: Run): string =>
  JSON.stringify(
    Object.getOwnPropertyNames(run.window).map(name => {
      const value = run.window[name];
      return typeof value === 'function' ? [name, 'fn'] : [name, value];
    }),
  );

describe('public/arrival.js', () => {
  test('a pairing link leaves the address at once, keeping the entry state, and waits in memory for ONE take', () => {
    const run = boot(`/pair${FAKE}`);
    expect(run.window.location.hash).toBe('');
    expect(run.replaced).toEqual([{ state: { fyEntry: 'e1', fyIndex: 0 }, url: '/pair' }]);
    expect(Object.keys(run.window)).not.toContain(EARLY_ARRIVAL_KEY); // not enumerable
    expect(exposed(run)).not.toContain('FAKEFAKE'); // no property of the window holds the value to read
    expect(taken(run)).toEqual({ pathname: '/pair', hash: FAKE, remainingMs: HELD_FOR_MS });
  });

  test('the hand-off is consumed by the first reader: a page script reading again, or twice, finds nothing', () => {
    const run = boot(`/pair${FAKE}`);
    const take = handoff(run) as Take;
    expect(take()).toBeDefined();
    expect(take()).toBeUndefined();
    expect(EARLY_ARRIVAL_KEY in run.window).toBe(false);
    expect(exposed(run)).not.toContain('FAKEFAKE');
  });

  test('the /app prefix, a query, a share link and a trailing slash all reach the screen that declared them', () => {
    for (const [href, path] of [
      [`/app/pair${FAKE}`, '/app/pair'],
      [`/pair?refused=fy_daemon_x${FAKE}`, '/pair'],
      [`/join${FAKE}`, '/join'],
      [`/pair/${FAKE}`, '/pair/'],
    ] as const) {
      const run = boot(href);
      expect(run.window.location.hash).toBe('');
      expect(taken(run)?.pathname).toBe(path);
      expect(run.replaced[0]?.url).toBe(href.replace(FAKE, ''));
    }
  });

  test('a path BENEATH a declared screen has no taker: it is stripped and dropped, never kept', () => {
    const run = boot(`/pair/extra${FAKE}`);
    expect(run.window.location.hash).toBe('');
    expect(run.replaced).toHaveLength(1);
    expect(taken(run)).toBeUndefined();
    expect(exposed(run)).not.toContain('FAKEFAKE');
  });

  test('a pairing-shaped fragment on ANY other path is stripped and dropped AT ONCE, with no hand-off at all', () => {
    for (const href of [
      `/app/${FAKE}`,
      `/${FAKE}`,
      `/pairing${FAKE}`,
      `/x/pair${FAKE}`,
      `/d/d1/settings${FAKE}`,
      '/app/#v1',
    ]) {
      const run = boot(href);
      expect(run.window.location.hash).toBe('');
      expect(run.replaced).toHaveLength(1);
      expect(run.replaced[0]?.url).not.toContain('#');
      expect(taken(run)).toBeUndefined();
      expect(exposed(run)).not.toContain('FAKEFAKE');
    }
  });

  test('a page with no taker (data-drop) strips the fragment and holds nothing at all', () => {
    for (const href of [`/${FAKE}`, `/pair${FAKE}`, `/get-started/${FAKE}`, `/oauth/mcp-callback${FAKE}`]) {
      const run = boot(href, { drop: true });
      expect(run.window.location.hash).toBe('');
      expect(handoff(run)).toBeUndefined(); // no taker, so no hand-off exists at all
      expect(exposed(run)).not.toContain('FAKEFAKE');
    }
  });

  test('anything else is left exactly where it is: no strip, nothing held', () => {
    for (const href of [
      '/pair',
      '/pair#',
      '/app/#agenda/A3?session=s-1',
      '/d/d1/settings#machines/desk',
      '/get-started/#install',
      '/#v2;x=1',
      '/#v10',
      '/#xv1;a=1',
    ]) {
      const run = boot(href);
      expect(run.replaced).toEqual([]);
      expect(taken(run)).toBeUndefined();
    }
  });

  test('a declared screen takes whatever fragment arrived on it, pairing-shaped or not', () => {
    const run = boot('/join#share-token');
    expect(run.window.location.hash).toBe('');
    expect(taken(run)).toEqual({ pathname: '/join', hash: '#share-token', remainingMs: HELD_FOR_MS });
  });

  test('an undecodable path segment never names a declared path (only a pairing-shaped fragment leaves it)', () => {
    const plain = boot('/%E0%A4%A#note');
    expect(plain.replaced).toEqual([]);
    expect(taken(plain)).toBeUndefined();
    const shaped = boot(`/%E0%A4%A${FAKE}`);
    expect(shaped.window.location.hash).toBe('');
    expect(taken(shaped)).toBeUndefined();
  });

  test('a browser that refuses replaceState does not take the app down, and holds nothing', () => {
    const run = boot(`/pair${FAKE}`, { refuse: true });
    expect(taken(run)).toBeUndefined();
  });

  describe('the hold has its own deadline, kept from the moment of arrival', () => {
    test('what waits is reported with what is left of its two minutes', () => {
      const run = boot(`/pair${FAKE}`);
      run.advance(45_000);
      expect(taken(run)?.remainingMs).toBe(HELD_FOR_MS - 45_000);
    });

    test('an unclaimed value is removed when the deadline passes, whether or not the module ever boots', () => {
      const run = boot(`/pair${FAKE}`);
      run.advance(HELD_FOR_MS);
      expect(taken(run)).toBeUndefined();
      expect(exposed(run)).not.toContain('FAKEFAKE');
    });

    test('a throttled timer cannot keep it alive: a late take past the deadline finds nothing', () => {
      const run = boot(`/pair${FAKE}`);
      run.advance(300_000, true); // a background tab: no timer ran
      expect(taken(run)).toBeUndefined();
    });
  });

  describe('later arrivals in the same document', () => {
    test('a pairing-shaped fragment set on an undeclared path is stripped and dropped at once', () => {
      const run = boot('/app/');
      run.arrive(FAKE);
      expect(run.window.location.hash).toBe('');
      expect(run.replaced).toHaveLength(1);
      expect(taken(run)).toBeUndefined();
    });

    test('so is one that arrives by history traversal (popstate)', () => {
      const run = boot('/app/');
      run.arrive(FAKE, 'popstate');
      expect(run.window.location.hash).toBe('');
    });

    test('a page with no taker strips every later arrival too', () => {
      const run = boot('/get-started/', { drop: true });
      run.arrive(FAKE);
      expect(run.window.location.hash).toBe('');
      expect(taken(run)).toBeUndefined();
    });

    test('while the module is still loading, a second declared arrival replaces the held value and restarts its two minutes', () => {
      const run = boot(`/pair${FAKE}`);
      run.advance(30_000);
      run.arrive('#v1;a=127.0.0.1:9;c=SECONDFAKE;fp=00');
      expect(run.window.location.hash).toBe('');
      expect(taken(run)).toEqual({
        pathname: '/pair',
        hash: '#v1;a=127.0.0.1:9;c=SECONDFAKE;fp=00',
        remainingMs: HELD_FOR_MS,
      });
    });

    test('once the taker owns the page, a declared arrival is LEFT for it, but a stray one is still dropped here', () => {
      const run = boot(`/pair${FAKE}`);
      taken(run); // the taker took it, and with it the page
      run.arrive(FAKE);
      expect(run.window.location.hash).toBe(FAKE); // the taker's own listener strips and holds it
      run.window.location.pathname = '/app/';
      run.arrive(FAKE);
      expect(run.window.location.hash).toBe('');
    });
  });

  test('the taker takes what the script held, by the real declarations, and the property is gone afterwards', () => {
    const run = boot(`/pair${FAKE}`);
    const views = viewsOf(generated.surfaces);
    const declared = registeredFragments(generated.surfaces, (plugin, screen) =>
      views.screens.get(`${plugin}.${screen}`),
    );
    const taker = new AddressTaker(declared, run.window as never);
    expect(taker.take('path:access.pair')).toBe(FAKE);
    expect(EARLY_ARRIVAL_KEY in run.window).toBe(false);
  });

  test('the credential shape is one pattern in three places: the contract, the taker and this script', () => {
    expect(CREDENTIAL_FRAGMENT.source).toBe(PAIRING_FRAGMENT_PATTERN.source);
    expect(CREDENTIAL_FRAGMENT.flags).toBe(PAIRING_FRAGMENT_PATTERN.flags);
    const match = /var PAIRING_SHAPED = \/(.*)\/;/u.exec(source);
    expect(match?.[1]).toBe(PAIRING_FRAGMENT_PATTERN.source);
  });

  test('PATHS is exactly the daemon-less screens the plugins declare as path fragments (no drift)', () => {
    const views = viewsOf(generated.surfaces);
    const declared = registeredFragments(generated.surfaces, (plugin, screen) =>
      views.screens.get(`${plugin}.${screen}`),
    )
      .flatMap(fragment => (fragment.decl.form === 'path' ? [fragment.screen?.path] : []))
      .sort();
    const match = /var PATHS = (\[[^\]]*\]);/u.exec(source);
    const listed = (JSON.parse((match?.[1] ?? '[]').replaceAll("'", '"')) as string[]).sort();
    expect(listed).toEqual(declared as string[]);
    // The script matches literal segments only; a parameter in a declared path needs the script taught first.
    for (const path of listed) expect(path).toMatch(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u);
  });
});
