import { describe, expect, it } from 'bun:test';
import type { PrLink } from '@ferretry/protocol';
import {
  ageLabel,
  cardSegments,
  fallbackFerretName,
  ferretNamer,
  headlinePr,
  peopleLabel,
  subsDone,
} from '../../src/lib/board-present.ts';
import { card } from './board-support.ts';

const ASK = { sessionId: 'mvudnuly-ec442385', id: 'A1' };
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const names = ferretNamer(new Map([['mvuc7tsf-0c3d50df', 'denisha']]));

const pr = (extra: Partial<PrLink> = {}): PrLink => ({
  url: 'https://github.com/acme/app/pull/7',
  number: 7,
  repo: 'acme/app',
  state: 'open',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: '2026-08-01T10:00:00.000Z',
  ...extra,
});

const segment = (
  task: ReturnType<typeof card>,
  key: string,
  category: Parameters<typeof cardSegments>[1]['category'] = 'active',
) => cardSegments(task, { names, now: NOW, category, machine: null }).find(entry => entry.key === key);

describe('ageLabel', () => {
  it('uses the coarsest unit that is at least one', () => {
    expect(ageLabel('2026-08-01T10:03:40.000Z', NOW)).toBe('now');
    expect(ageLabel('2026-08-01T10:00:00.000Z', NOW)).toBe('4m');
    expect(ageLabel('2026-08-01T08:00:00.000Z', NOW)).toBe('2h');
    expect(ageLabel('2026-07-29T10:00:00.000Z', NOW)).toBe('3d');
  });

  it('never goes negative and says nothing without a valid instant', () => {
    expect(ageLabel('2026-08-02T10:00:00.000Z', NOW)).toBe('now');
    expect(ageLabel(null, NOW)).toBeNull();
    expect(ageLabel('not a date', NOW)).toBeNull();
  });
});

describe('ferret names', () => {
  it('names a ferret by callsign, else the start of its id', () => {
    expect(names('mvuc7tsf-0c3d50df')).toBe('Denisha');
    expect(names('mvudnuly-ec442385')).toBe('mvudnuly');
    expect(fallbackFerretName('abcdefghijkl')).toBe('abcdefgh');
  });

  it('shows owner→assignee only when they differ', () => {
    expect(peopleLabel({ owner: 'mvuc7tsf-0c3d50df', assignee: null }, names)).toBe('Denisha');
    expect(peopleLabel({ owner: 'mvuc7tsf-0c3d50df', assignee: 'mvuc7tsf-0c3d50df' }, names)).toBe('Denisha');
    expect(peopleLabel({ owner: 'mvuc7tsf-0c3d50df', assignee: 'mvudnuly-ec442385' }, names)).toBe('Denisha→mvudnuly');
  });
});

describe('cardSegments', () => {
  it('words each liveness state', () => {
    const text = (extra: Record<string, unknown>, category: 'active' | 'verify' = 'active') =>
      segment(card('F1', extra), 'activity', category)?.text;
    expect(text({ activity: 'active' })).toBe('● 4m');
    expect(text({ activity: 'active', lastTouchedAt: null })).toBe('● active');
    expect(text({ activity: 'idle', lastTouchedAt: '2026-08-01T08:04:00.000Z' })).toBe('idle 2h');
    expect(text({ activity: 'idle', lastTouchedAt: null })).toBe('idle');
    expect(text({ activity: 'stale', lastTouchedAt: '2026-07-31T10:04:00.000Z' })).toBe('▲ stale 1d');
    expect(text({ activity: 'stale', lastTouchedAt: null })).toBe('▲ stale');
    expect(text({ activity: 'orphaned' })).toBe('⛔ orphaned');
    expect(text({ activity: 'waiting' })).toBe('🚧 waiting');
    expect(text({ activity: 'waiting', waitingOnOwner: [ASK], openAsks: [ASK] })).toBe('🚧 waiting on you');
  });

  it('never words a card in the To test lane as stale or idle', () => {
    expect(segment(card('F1', { activity: 'stale' }), 'activity', 'verify')?.text).toBe('🧪 to test');
  });

  it('draws the ref, the people and the machine only when there are several', () => {
    const task = card('F412', { assignee: 'mvudnuly-ec442385' });
    const keys = cardSegments(task, { names, now: NOW, category: 'active', machine: 'laptop' }).map(entry => entry.key);
    expect(keys).toEqual(['ref', 'people', 'activity', 'machine']);
    expect(segment(task, 'ref')?.text).toBe('&F412');
    expect(segment(task, 'people')?.text).toBe('Denisha→mvudnuly');
    expect(segment(task, 'machine')).toBeUndefined();
  });

  it('words the headline PR by its checks', () => {
    const text = (extra: Partial<PrLink>) =>
      segment(card('F1', { links: { prs: [pr(extra)], branch: null, commits: [], docs: [] } }), 'pr')?.text;
    expect(text({ checks: 'passing' })).toBe('PR ✓');
    expect(text({ checks: 'failing' })).toBe('PR ✗');
    expect(text({ checks: 'pending' })).toBe('PR ⏳');
    expect(text({ checks: 'none' })).toBe('PR');
    expect(text({ draft: true })).toBe('PR draft');
    expect(text({ state: 'merged', mergedAt: '2026-08-01T09:00:00.000Z', mergeSha: SHA })).toBe('PR merged');
    expect(text({ state: 'closed' })).toBe('PR closed');
  });

  it('says how many more PRs are linked and has none without any', () => {
    const task = card('F1', {
      links: {
        prs: [pr(), pr({ number: 8, url: 'https://github.com/acme/app/pull/8' })],
        branch: null,
        commits: [],
        docs: [],
      },
    });
    expect(segment(task, 'pr')?.text).toBe('PR +1');
    expect(segment(card('F2'), 'pr')).toBeUndefined();
  });

  it('draws blockers, sub-task progress and the release a card shipped in', () => {
    const task = card('F1', {
      blockedBy: [{ id: 'F2' }, { id: 'F3' }],
      rollup: {
        children: 3,
        byCategory: { backlog: 0, active: 1, review: 0, shipped: 0, verify: 0, closed: 2 },
        active: 1,
        lastTouchedAt: null,
      },
      shippedIn: { version: '4.110.0', tag: 'v4.110.0', at: '2026-08-01T09:00:00.000Z' },
    });
    expect(segment(task, 'blocked')?.text).toBe('⛓ 2');
    expect(segment(task, 'subs')?.text).toBe('subs 2/3 ●');
    expect(segment(task, 'shipped')?.text).toBe('in 4.110.0');
    expect(subsDone(task)).toBe(2);
    const quiet = card('F4', {
      rollup: {
        children: 2,
        byCategory: { backlog: 2, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
        active: 0,
        lastTouchedAt: null,
      },
    });
    expect(segment(quiet, 'subs')?.text).toBe('subs 0/2');
    expect(segment(quiet, 'subs')?.tone).toBe('quiet');
  });
});

describe('headlinePr', () => {
  it('prefers an open PR, then the newest merged one, then the last linked', () => {
    const merged = (n: number, at: string) => pr({ number: n, state: 'merged', mergedAt: at, mergeSha: SHA });
    expect(headlinePr([])).toBeNull();
    expect(headlinePr([merged(1, '2026-07-01T00:00:00.000Z'), pr({ number: 2 })])?.number).toBe(2);
    expect(headlinePr([merged(1, '2026-07-01T00:00:00.000Z'), merged(3, '2026-07-03T00:00:00.000Z')])?.number).toBe(3);
    expect(headlinePr([pr({ number: 4, state: 'closed' }), pr({ number: 5, state: 'closed' })])?.number).toBe(5);
  });
});
