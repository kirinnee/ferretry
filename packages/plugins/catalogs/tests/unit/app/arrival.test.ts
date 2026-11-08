import { describe, expect, it } from 'bun:test';
import { heldArrival, releaseArrival, resetArrivals, takeArrival, watchArrivals } from '../../../app/lib/arrival.ts';

const browser = (hash: string) => {
  const replaced: unknown[][] = [];
  return {
    replaced,
    window: {
      location: { pathname: '/join', search: '?a=1', hash },
      history: { replaceState: (...args: unknown[]) => void replaced.push(args) },
    },
  };
};

describe('a share link leaves the address bar', () => {
  it('reads the fragment once and rewrites the address without it, by replace (Back cannot restore the code)', () => {
    const { replaced, window } = browser('#v1;code=fy_share_secret');
    expect(takeArrival(window)).toBe('#v1;code=fy_share_secret');
    expect(replaced).toEqual([[{}, '', '/join?a=1']]);
  });

  it('rewrites nothing when there is no fragment', () => {
    const { replaced, window } = browser('');
    expect(takeArrival(window)).toBe('');
    expect(replaced).toEqual([]);
  });
});

describe('N1 the code leaves the address bar before any view loads', () => {
  const win = (pathname: string, hash: string) => {
    const replaced: unknown[][] = [];
    const listeners: Record<string, () => void> = {};
    const location = { pathname, search: '', hash };
    return {
      replaced,
      listeners,
      location,
      window: {
        location,
        history: {
          replaceState: (...args: unknown[]) => {
            replaced.push(args);
            location.hash = '';
          },
        },
        addEventListener: (type: string, listener: () => void) => {
          listeners[type] = listener;
        },
      },
    };
  };

  it('holds the fragment from the moment the half is watched, and releases it once', () => {
    resetArrivals();
    const { window, replaced, location } = win('/join', '#v1;code=fy_share_secret');
    watchArrivals(window);
    expect(location.hash).toBe('');
    expect(replaced).toEqual([[{}, '', '/join']]);
    expect(heldArrival()).toBe('#v1;code=fy_share_secret');
    expect(heldArrival()).toBe('#v1;code=fy_share_secret'); // a thrown-away render finds it again
    expect(releaseArrival()).toBe('#v1;code=fy_share_secret');
    expect(heldArrival()).toBe('');
  });

  it('takes a later arrival on /join too, and leaves every other page alone', () => {
    resetArrivals();
    const join = win('/join', '');
    watchArrivals(join.window);
    join.location.hash = '#v1;code=fy_share_later';
    join.listeners.hashchange?.();
    expect(join.location.hash).toBe('');
    expect(releaseArrival()).toBe('#v1;code=fy_share_later');
    resetArrivals();
    const other = win('/sharing', '#subscriptions');
    watchArrivals(other.window);
    expect(other.replaced).toEqual([]);
    expect(heldArrival()).toBe('');
  });
});
