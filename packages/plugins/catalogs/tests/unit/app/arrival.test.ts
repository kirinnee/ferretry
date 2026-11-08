import { describe, expect, it } from 'bun:test';
import { addressPlace, type ScreenRef } from '@ferretry/app';
import { armArrivalHold, takeArrival } from '../../../app/lib/arrival.ts';
import { JOIN_PATH } from '../../../app/lib/routes.ts';

/** Where an address stands to the join screen, by the shell router's own parse (as the half arms it). */
const JOIN: ScreenRef = { plugin: 'catalogs', id: 'join', path: JOIN_PATH, label: 'Join' };
const atJoin = (pathname: string) => addressPlace(JOIN, pathname);

const browser = (hash: string, state: unknown = { fyEntry: 'e1', fyIndex: 3 }) => {
  const replaced: unknown[][] = [];
  return {
    replaced,
    window: {
      location: { pathname: '/join', search: '?a=1', hash },
      history: { state, replaceState: (...args: unknown[]) => void replaced.push(args) },
    },
  };
};

describe('a share link leaves the address bar', () => {
  it('reads the fragment once and rewrites the address without it, by replace (Back cannot restore the code)', () => {
    const { replaced, window } = browser('#v1;code=fy_share_secret');
    expect(takeArrival(window)).toBe('#v1;code=fy_share_secret');
    expect(replaced).toEqual([[{ fyEntry: 'e1', fyIndex: 3 }, '', '/join?a=1']]);
  });

  it('R2-N3 keeps the entry’s own history state, so the router’s trail and scroll identity survive', () => {
    const state = { fyEntry: 'e9', fyIndex: 7 };
    const { replaced, window } = browser('#v1;code=fy_share_secret', state);
    takeArrival(window);
    expect(replaced[0]?.[0]).toBe(state);
  });

  it('rewrites nothing when there is no fragment', () => {
    const { replaced, window } = browser('');
    expect(takeArrival(window)).toBe('');
    expect(replaced).toEqual([]);
  });
});

/** A window at `path` whose address bar the hold really rewrites. */
const windowAt = (path: string, hash: string) => {
  const address = { pathname: path, search: '', hash };
  const listeners: (() => void)[] = [];
  const replaced: unknown[][] = [];
  return {
    address,
    replaced,
    fire: () => {
      for (const listener of listeners) listener();
    },
    window: {
      location: address,
      history: {
        state: { fyEntry: 'e1' },
        replaceState: (...args: unknown[]) => {
          replaced.push(args);
          address.hash = '';
        },
      },
      addEventListener: (_type: 'hashchange', listener: () => void) => void listeners.push(listener),
    },
  };
};

describe('R3-B1 the hold takes the code off the address before any screen exists', () => {
  it('strips a link already in the address the moment it is armed, and holds it for the screen', () => {
    const at = windowAt('/join', '#v1;code=fy_share_a');
    const hold = armArrivalHold(at.window, atJoin);
    expect(at.address.hash).toBe('');
    expect(at.replaced).toEqual([[{ fyEntry: 'e1' }, '', '/join']]);
    expect(hold.waiting()).toBe('#v1;code=fy_share_a');
    expect(hold.take()).toBe('#v1;code=fy_share_a');
    expect(hold.take()).toBe('');
  });

  it('leaves a fragment on any other page alone', () => {
    const at = windowAt('/shared', '#anchor');
    const hold = armArrivalHold(at.window, atJoin);
    expect(at.address.hash).toBe('#anchor');
    expect(at.replaced).toEqual([]);
    expect(hold.waiting()).toBe('');
  });

  it('strips a second link on hashchange and holds it while no screen listens', () => {
    const at = windowAt('/join', '');
    const hold = armArrivalHold(at.window, atJoin);
    at.address.hash = '#v1;code=fy_share_b';
    at.fire();
    expect(at.address.hash).toBe('');
    expect(hold.take()).toBe('#v1;code=fy_share_b');
  });

  it('delivers a later link to the listening screen instead of holding it, until the screen stops', () => {
    const at = windowAt('/join', '');
    const hold = armArrivalHold(at.window, atJoin);
    const seen: string[] = [];
    const stop = hold.subscribe(fragment => void seen.push(fragment));
    at.address.hash = '#v1;code=fy_share_c';
    at.fire();
    expect(seen).toEqual(['#v1;code=fy_share_c']);
    expect(hold.waiting()).toBe('');
    stop();
    at.address.hash = '#v1;code=fy_share_d';
    hold.read();
    expect(seen).toEqual(['#v1;code=fy_share_c']);
    expect(hold.waiting()).toBe('#v1;code=fy_share_d');
  });

  it('holds nothing and reads nothing where there is no window (the registry generator, a non-browser caller)', () => {
    const hold = armArrivalHold({}, atJoin);
    hold.read();
    expect(hold.waiting()).toBe('');
    expect(hold.take()).toBe('');
  });

  it('rewrites nothing when there is no fragment', () => {
    const at = windowAt('/join', '');
    armArrivalHold(at.window, atJoin).read();
    expect(at.replaced).toEqual([]);
  });
});

describe('R4-S1 the hold strips at every address the router draws the join screen at', () => {
  const FRAGMENT = '#v1;code=fy_share_x';

  for (const pathname of ['/join', '/join/', '/app/join', '/app/join/', '/j%6Fin']) {
    it(`R4-S1 ${pathname}: the code leaves the address by one replace, and is held for the join screen`, () => {
      const at = windowAt(pathname, FRAGMENT);
      const hold = armArrivalHold(at.window, atJoin);
      expect(at.address.hash).toBe('');
      expect(at.replaced).toEqual([[{ fyEntry: 'e1' }, '', pathname]]);
      expect(hold.take()).toBe(FRAGMENT);
    });

    it(`R4-S1 ${pathname}: a second link (hashchange) there leaves the address too, and is held`, () => {
      const at = windowAt(pathname, '');
      const hold = armArrivalHold(at.window, atJoin);
      at.address.hash = FRAGMENT;
      at.fire();
      expect(at.address.hash).toBe('');
      expect(at.replaced.map(call => call[2])).toEqual([pathname]);
      expect(hold.take()).toBe(FRAGMENT);
    });
  }

  for (const pathname of ['/join/x', '/app/join/x', '/join/x/y']) {
    it(`R4-S1 ${pathname} (beneath the join address, drawn as not-found): the code leaves the address and is dropped`, () => {
      const at = windowAt(pathname, FRAGMENT);
      const hold = armArrivalHold(at.window, atJoin);
      const seen: string[] = [];
      hold.subscribe(fragment => void seen.push(fragment));
      expect(at.address.hash).toBe('');
      expect(at.replaced).toEqual([[{ fyEntry: 'e1' }, '', pathname]]);
      // No join screen is drawn there, so nothing holds the code and no listening screen is handed it.
      expect(hold.take()).toBe('');
      at.address.hash = FRAGMENT;
      at.fire();
      expect(at.address.hash).toBe('');
      expect(seen).toEqual([]);
      expect(hold.waiting()).toBe('');
    });
  }

  for (const pathname of ['/shared', '/joined', '/d/d1/join', '/x/join', '/app/app/join']) {
    it(`R4-S1 ${pathname}: a fragment on a page that is not the join screen is left alone`, () => {
      const at = windowAt(pathname, '#anchor');
      const hold = armArrivalHold(at.window, atJoin);
      at.fire();
      expect(at.address.hash).toBe('#anchor');
      expect(at.replaced).toEqual([]);
      expect(hold.waiting()).toBe('');
    });
  }
});
