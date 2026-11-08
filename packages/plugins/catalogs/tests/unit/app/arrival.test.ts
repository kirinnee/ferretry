import { describe, expect, it } from 'bun:test';
import { takeArrival } from '../../../app/lib/arrival.ts';

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
