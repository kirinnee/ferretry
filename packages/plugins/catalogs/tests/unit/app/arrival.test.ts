import { describe, expect, it } from 'bun:test';
import { armArrivalHold, takeArrival } from '../../../app/lib/arrival.ts';

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
    const hold = armArrivalHold(at.window, '/join');
    expect(at.address.hash).toBe('');
    expect(at.replaced).toEqual([[{ fyEntry: 'e1' }, '', '/join']]);
    expect(hold.waiting()).toBe('#v1;code=fy_share_a');
    expect(hold.take()).toBe('#v1;code=fy_share_a');
    expect(hold.take()).toBe('');
  });

  it('leaves a fragment on any other page alone', () => {
    const at = windowAt('/shared', '#anchor');
    const hold = armArrivalHold(at.window, '/join');
    expect(at.address.hash).toBe('#anchor');
    expect(at.replaced).toEqual([]);
    expect(hold.waiting()).toBe('');
  });

  it('strips a second link on hashchange and holds it while no screen listens', () => {
    const at = windowAt('/join', '');
    const hold = armArrivalHold(at.window, '/join');
    at.address.hash = '#v1;code=fy_share_b';
    at.fire();
    expect(at.address.hash).toBe('');
    expect(hold.take()).toBe('#v1;code=fy_share_b');
  });

  it('delivers a later link to the listening screen instead of holding it, until the screen stops', () => {
    const at = windowAt('/join', '');
    const hold = armArrivalHold(at.window, '/join');
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
    const hold = armArrivalHold({}, '/join');
    hold.read();
    expect(hold.waiting()).toBe('');
    expect(hold.take()).toBe('');
  });

  it('rewrites nothing when there is no fragment', () => {
    const at = windowAt('/join', '');
    armArrivalHold(at.window, '/join').read();
    expect(at.replaced).toEqual([]);
  });
});
