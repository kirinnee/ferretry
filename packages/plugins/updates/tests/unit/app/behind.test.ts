import { describe, expect, test } from 'bun:test';
import { DAEMON_UPDATE_CODES, DaemonUpdateViewSchema, planUpdate } from '../../../contract/index.ts';
import { behindSentence, refusalSentence, updateOffer, updateRequest } from '../../../app/lib/behind.ts';

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
