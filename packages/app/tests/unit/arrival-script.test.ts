/**
 * `public/arrival.js` must take a declared pairing or share fragment off the address, synchronously, before the module
 * graph is fetched, and agree with what the plugins declare (shell contract S3).
 *
 * Like `pre-paint.test.ts`, this runs the REAL FILE (read from disk, executed with `window` supplied as a parameter),
 * because the script is a hand-written classic script nothing imports or typechecks. Its list of paths is a second
 * statement of the plugins' declared `path` fragments, and the last test fails if the two ever differ.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registeredFragments } from '../../src/connect/provides.ts';
import { generated } from '../../src/generated/surfaces.ts';
import { viewsOf } from '../../src/layout/engine.ts';
import { AddressTaker, EARLY_ARRIVAL_KEY } from '../../src/router/address.ts';

const source = readFileSync(join(import.meta.dir, '../../public/arrival.js'), 'utf8');
const FAKE = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00'; // an obviously fake pairing fragment

interface Run {
  readonly window: Record<string, unknown> & { location: { pathname: string; search: string; hash: string } };
  readonly replaced: { state: unknown; url: string }[];
}

/** Runs the script against one address, as the parser would, and reports what it did to the address and the window. */
function boot(href: string, replaceState?: () => void, drop = false): Run {
  const url = new URL(href, 'https://app.test');
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  const replaced: { state: unknown; url: string }[] = [];
  const win: Run['window'] = {
    location,
    document: { currentScript: { hasAttribute: (name: string) => drop && name === 'data-drop' } },
    history: {
      state: { fyEntry: 'e1', fyIndex: 0 },
      replaceState: (state: unknown, _title: string, to: string) => {
        if (replaceState !== undefined) return replaceState();
        replaced.push({ state, url: to });
        location.hash = '';
      },
    },
  };
  new Function('window', source)(win);
  return { window: win, replaced };
}

const held = (run: Run): unknown => run.window[EARLY_ARRIVAL_KEY];

describe('public/arrival.js', () => {
  test('a pairing link leaves the address at once, keeping the entry state, and is held in memory', () => {
    const run = boot(`/pair${FAKE}`);
    expect(run.window.location.hash).toBe('');
    expect(run.replaced).toEqual([{ state: { fyEntry: 'e1', fyIndex: 0 }, url: '/pair' }]);
    expect(held(run)).toEqual({ pathname: '/pair', hash: FAKE });
    expect(Object.keys(run.window)).not.toContain(EARLY_ARRIVAL_KEY); // not enumerable: it never shows in a dump
  });

  test('the /app prefix, a query, a share link and a path beneath a declared screen are all taken', () => {
    for (const [href, path] of [
      [`/app/pair${FAKE}`, '/app/pair'],
      [`/pair?refused=fy_daemon_x${FAKE}`, '/pair'],
      [`/join${FAKE}`, '/join'],
      [`/pair/extra${FAKE}`, '/pair/extra'],
    ] as const) {
      const run = boot(href);
      expect(run.window.location.hash).toBe('');
      expect((held(run) as { pathname: string }).pathname).toBe(path);
      expect(run.replaced[0]?.url).toBe(href.replace(FAKE, ''));
    }
  });

  test('a pairing-shaped fragment is stripped on ANY path, and held there for nobody to take', () => {
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
      expect(held(run)).toBeDefined();
    }
  });

  test('a page with no taker (the landing page) strips the fragment and holds nothing at all', () => {
    for (const href of [`/${FAKE}`, `/pair${FAKE}`]) {
      const run = boot(href, undefined, true);
      expect(run.window.location.hash).toBe('');
      expect(held(run)).toBeUndefined();
    }
  });

  test('anything else is left exactly where it is: no strip, nothing held', () => {
    for (const href of [
      '/pair',
      '/pair#',
      '/app/#agenda/A3?session=s-1',
      '/d/d1/settings#machines/desk',
      '/#v2;x=1',
      '/#v10',
      '/#xv1;a=1',
    ]) {
      const run = boot(href);
      expect(run.replaced).toEqual([]);
      expect(held(run)).toBeUndefined();
    }
  });

  test('a declared screen takes whatever fragment arrived on it, pairing-shaped or not', () => {
    const run = boot('/join#share-token');
    expect(run.window.location.hash).toBe('');
    expect(held(run)).toEqual({ pathname: '/join', hash: '#share-token' });
  });

  test('an undecodable path segment never names a declared path (only a pairing-shaped fragment leaves it)', () => {
    const plain = boot('/%E0%A4%A#note');
    expect(plain.replaced).toEqual([]);
    expect(held(plain)).toBeUndefined();
    expect(boot(`/%E0%A4%A${FAKE}`).window.location.hash).toBe('');
  });

  test('a browser that refuses replaceState does not take the app down, and holds nothing', () => {
    const run = boot(`/pair${FAKE}`, () => {
      throw new Error('SecurityError');
    });
    expect(held(run)).toBeUndefined();
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
