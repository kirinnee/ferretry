import { describe, expect, it } from 'bun:test';
import { fragmentOf, takeArrival } from '../../../app/lib/arrival.ts';

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

  it('reads the fragment off an address, and nothing off one that has none or is not an address', () => {
    expect(fragmentOf('https://app.example/join#v1;code=fy_share_x')).toBe('#v1;code=fy_share_x');
    expect(fragmentOf('https://app.example/join')).toBe('');
    expect(fragmentOf('not an address')).toBe('');
  });
});
