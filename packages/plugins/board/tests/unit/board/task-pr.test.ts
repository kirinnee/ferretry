import { describe, expect, test } from 'bun:test';
import type { PrLink } from '../../../contract/index.ts';
import { prOf } from '../../../daemon/lib/board/task-pr.ts';

const link = (number: number, state: PrLink['state'], extra: Partial<PrLink> = {}): PrLink => ({
  url: `https://github.com/acme/repo/pull/${number}`,
  number,
  repo: 'acme/repo',
  state,
  draft: false,
  checks: 'passing',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: null,
  ...extra,
});

describe('prOf: the PR a lead pack table shows for a card', () => {
  test('a card with no PR shows none', () => {
    expect(prOf([])).toBeUndefined();
  });

  test('the newest open one wins over a newer closed one', () => {
    const shown = prOf([link(1, 'open'), link(2, 'open'), link(3, 'closed')]);
    expect(shown).toEqual({
      number: 2,
      url: 'https://github.com/acme/repo/pull/2',
      state: 'open',
      draft: false,
      checks: 'passing',
    });
  });

  test('a PR that was never polled counts as live', () => {
    expect(prOf([link(1, 'closed'), link(2, 'unknown')])?.number).toBe(2);
  });

  test('with none live, the newest linked one is shown', () => {
    expect(prOf([link(1, 'closed'), link(2, 'closed')])?.number).toBe(2);
  });
});
