import { describe, expect, test } from 'bun:test';
import { DAEMON_UPDATE_CODES, DaemonUpdateViewSchema, planUpdate } from '../../../contract/index.ts';
import {
  behindSentence,
  headlineSentence,
  refusalSentence,
  updateOffer,
  updateRequest,
} from '../../../app/lib/behind.ts';

const LATEST = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };
const profile = { kind: 'nix-profile', element: 'ferretry' } as const;
const apt = { kind: 'system-package', manager: 'apt' } as const;

const view = (overrides: Record<string, unknown> = {}) =>
  DaemonUpdateViewSchema.parse({
    current: '4.28.0',
    method: profile,
    plan: planUpdate(profile, { product: 'ferretry', clientName: 'fy' }),
    check: { state: 'ok', checkedAt: '2026-10-18T09:00:00.000Z', latest: LATEST },
    available: true,
    midTurn: 2,
    autoInstall: false,
    job: null,
    ...overrides,
  });

describe('the behind notice', () => {
  test('says nothing for a daemon that is current or has never checked', () => {
    expect(behindSentence(view({ available: false }))).toBeUndefined();
    expect(behindSentence(view({ available: true, check: { state: 'never' } }))).toBeUndefined();
  });
  test('names the running version and the one that is out', () => {
    expect(behindSentence(view())).toBe('This daemon is behind: 4.28.0 runs, 4.29.0 is out.');
  });
});

describe('the update offer', () => {
  test('a self-updatable daemon offers the update, with the ferrets mid-turn counted', () => {
    expect(updateOffer(view())).toEqual({ kind: 'update', target: '4.29.0', midTurn: 2 });
  });
  test('a daemon the app cannot update for you gets the steps', () => {
    const offer = updateOffer(view({ method: apt, plan: planUpdate(apt, { product: 'ferretry', clientName: 'fy' }) }));
    expect(offer.kind).toBe('steps');
  });
  test('an update on its way is not offered twice', () => {
    const running = view({ job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T09:59:00.000Z' } });
    expect(updateOffer(running).kind).toBe('busy');
  });
  test('nothing to offer when nothing is newer', () => {
    expect(updateOffer(view({ available: false })).kind).toBe('none');
  });
  test('the request names the version the person saw, and when', () => {
    expect(updateRequest('4.29.0', 'when-idle')).toEqual({ target: '4.29.0', when: 'when-idle' });
  });
  test('each refusal code has its own sentence, and an unknown one keeps the daemon’s', () => {
    expect(refusalSentence(DAEMON_UPDATE_CODES.staleTarget, 'x')).toContain('newer release came out');
    expect(refusalSentence('other', 'the daemon said this')).toBe('the daemon said this');
  });
});

describe('the update offer while an update is in flight, and the refusal sentences', () => {
  test('an update waiting for no ferret to be mid-turn says so and names the target', () => {
    const waiting = view({
      job: { state: 'waiting-for-idle', target: '4.29.0', requestedAt: '2026-10-18T09:59:00.000Z', midTurn: 1 },
    });
    expect(updateOffer(waiting)).toEqual({
      kind: 'busy',
      sentence: 'Waiting for no ferret to be mid-turn, then updating to 4.29.0.',
    });
  });
  test('a running update names the target', () => {
    const running = view({ job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T09:59:00.000Z' } });
    expect(updateOffer(running)).toEqual({ kind: 'busy', sentence: 'Updating to 4.29.0.' });
  });
  test('a daemon the app cannot update carries the plan’s explanation and steps', () => {
    const offer = updateOffer(view({ method: apt, plan: planUpdate(apt, { product: 'ferretry', clientName: 'fy' }) }));
    if (offer.kind !== 'steps') throw new Error('expected steps');
    expect(offer.explanation.length).toBeGreaterThan(0);
    expect(offer.steps.length).toBeGreaterThan(0);
  });
  test('every refusal code the update routes answer with has its own sentence', () => {
    expect(refusalSentence(DAEMON_UPDATE_CODES.inProgress, 'x')).toBe('An update is already on its way.');
    expect(refusalSentence(DAEMON_UPDATE_CODES.notAvailable, 'x')).toBe('There is no newer release to update to.');
    expect(refusalSentence(DAEMON_UPDATE_CODES.notSelfUpdatable, 'x')).toBe(
      'This daemon cannot update itself; follow the steps shown.',
    );
    expect(refusalSentence(undefined, 'fallback')).toBe('fallback');
  });
});

describe('the line under "Running …" (never "up to date" for a latest nobody checked)', () => {
  test('says up to date only when a newer release was looked for and none is newer', () => {
    expect(headlineSentence(view({ available: false }))).toBe('This daemon is up to date.');
  });
  test('names the update when one is available', () => {
    expect(headlineSentence(view())).toBe('This daemon is behind: 4.28.0 runs, 4.29.0 is out.');
  });
  test('a daemon that has never checked says so instead of "up to date"', () => {
    const sentence = headlineSentence(view({ available: false, check: { state: 'never' } }));
    expect(sentence).toBe('This daemon has not checked for a newer release yet.');
    expect(sentence).not.toContain('up to date');
  });
  test('a failed check with no earlier answer says the check failed and why', () => {
    const sentence = headlineSentence(
      view({
        available: false,
        check: { state: 'failed', checkedAt: '2026-10-18T09:00:00.000Z', reason: 'network unreachable' },
      }),
    );
    expect(sentence).toBe(
      'The last check for a newer release failed (network unreachable), so this daemon may not be up to date.',
    );
  });
  test('a failed check that still has an earlier answer keeps that answer and flags the failure', () => {
    const sentence = headlineSentence(
      view({
        available: false,
        check: {
          state: 'failed',
          checkedAt: '2026-10-18T09:30:00.000Z',
          reason: 'network unreachable',
          lastKnown: { checkedAt: '2026-10-18T09:00:00.000Z', latest: { ...LATEST, version: '4.28.0' } },
        },
      }),
    );
    expect(sentence).toBe(
      'This daemon is up to date as of the last good check; the newest check failed (network unreachable).',
    );
  });
});
