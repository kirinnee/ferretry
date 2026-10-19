import { describe, expect, it } from 'bun:test';
import type { UpdateReport } from '@ferretry/protocol';
import {
  ageWords,
  changelogRelease,
  checkWords,
  installWords,
  isMissingRoute,
  jobWords,
  midTurnWords,
  shouldPoll,
  startRefusal,
  updateHeadline,
  versionPairWords,
} from '../../../../src/features/settings/about-machine-model.ts';
import { latestRelease as latest, updateView } from './about-machine-support.ts';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

const report = (outcome: UpdateReport['outcome']): UpdateReport => ({
  from: '4.28.0',
  target: '4.29.0',
  outcome,
  message: `the update ${outcome}`,
  finishedAt: '2026-10-18T11:00:00.000Z',
});

describe('about machine words', () => {
  it('says how old a check is in the coarsest honest unit', () => {
    expect(ageWords('2026-10-18T12:00:30.000Z', NOW)).toBe('just now');
    expect(ageWords('2026-10-18T11:59:00.000Z', NOW)).toBe('1 minute ago');
    expect(ageWords('2026-10-18T11:30:00.000Z', NOW)).toBe('30 minutes ago');
    expect(ageWords('2026-10-18T11:00:00.000Z', NOW)).toBe('1 hour ago');
    expect(ageWords('2026-10-18T07:00:00.000Z', NOW)).toBe('5 hours ago');
    expect(ageWords('2026-10-17T12:00:00.000Z', NOW)).toBe('1 day ago');
    expect(ageWords('2026-10-15T12:00:00.000Z', NOW)).toBe('3 days ago');
  });

  it('heads the panel with the update, the version, or that it is current', () => {
    expect(updateHeadline(updateView())).toBe('Update available 4.28.0 → 4.29.0');
    expect(updateHeadline(updateView({ available: false, check: { state: 'never' } }))).toBe('Version 4.28.0');
    expect(updateHeadline(updateView({ available: false, current: '4.29.0' }))).toBe('Up to date — version 4.29.0');
  });

  it('names the install method with its detail', () => {
    expect(installWords(updateView())).toEqual({ label: 'Homebrew', detail: 'Homebrew cask ferretry' });
  });

  it('says what the last check found, keeping the last good answer through a failure', () => {
    expect(checkWords({ state: 'never' }, NOW)).toBe('This machine has not checked for a newer release yet.');
    expect(checkWords(updateView().check, NOW)).toBe('Latest release 4.29.0, checked 2 hours ago.');
    expect(
      checkWords({ state: 'failed', checkedAt: '2026-10-18T11:00:00.000Z', reason: 'GitHub did not answer' }, NOW),
    ).toBe('The last check, 1 hour ago, failed: GitHub did not answer.');
    expect(
      checkWords(
        {
          state: 'failed',
          checkedAt: '2026-10-18T11:00:00.000Z',
          reason: 'offline',
          lastKnown: { checkedAt: '2026-10-17T12:00:00.000Z', latest },
        },
        NOW,
      ),
    ).toBe('The last check, 1 hour ago, failed: offline. The last answer, 1 day ago, said 4.29.0.');
    expect(changelogRelease(updateView())).toEqual(latest);
  });

  it('counts ferrets mid-turn', () => {
    expect(midTurnWords(1)).toBe('1 ferret is mid-turn');
    expect(midTurnWords(3)).toBe('3 ferrets are mid-turn');
  });

  it('describes every job state with a tone', () => {
    expect(
      jobWords({ state: 'waiting-for-idle', target: '4.29.0', requestedAt: '2026-10-18T11:00:00.000Z', midTurn: 2 }),
    ).toEqual({
      tone: 'pend',
      text: 'Waiting to update to 4.29.0: 2 ferrets are mid-turn. It starts when they are idle.',
    });
    expect(jobWords({ state: 'running', target: '4.29.0', startedAt: '2026-10-18T11:00:00.000Z' }).tone).toBe('pend');
    expect(jobWords({ state: 'finished', report: report('succeeded') })).toEqual({
      tone: 'ok',
      text: 'the update succeeded',
    });
    expect(jobWords({ state: 'finished', report: report('rolled-back') }).tone).toBe('warn');
    expect(jobWords({ state: 'finished', report: report('failed') }).tone).toBe('err');
  });

  it('polls only while an update is waiting or running', () => {
    expect(shouldPoll(updateView())).toBe(false);
    expect(shouldPoll(updateView({ job: { state: 'finished', report: report('succeeded') } }))).toBe(false);
    expect(
      shouldPoll(updateView({ job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T11:00:00.000Z' } })),
    ).toBe(true);
  });

  it('warns whenever the app and the machine differ, and says which is older', () => {
    expect(versionPairWords(undefined, '4.28.0').tone).toBe('pend');
    expect(versionPairWords('4.28.0', '4.28.0')).toEqual({ tone: 'ok', text: 'App and machine are both 4.28.0.' });
    expect(versionPairWords('4.29.0', '4.28.0').text).toContain('The machine is older');
    expect(versionPairWords('4.27.0', '4.28.0').text).toContain('The app is older');
    expect(versionPairWords('dev', '4.28.0')).toEqual({
      tone: 'warn',
      text: 'App dev, machine 4.28.0: the versions differ. They are different builds.',
    });
  });

  it('turns a refused Update into the mid-turn choice or the daemon’s sentence', () => {
    expect(
      startRefusal({ status: 409, code: 'update_mid_turn', body: { error: 'x', code: 'update_mid_turn', midTurn: 2 } }),
    ).toEqual({ kind: 'mid-turn', count: 2 });
    expect(startRefusal({ status: 409, code: 'update_mid_turn', body: 'garbled' })).toEqual({
      kind: 'mid-turn',
      count: 1,
    });
    expect(startRefusal(new Error('update_in_progress'))).toEqual({ kind: 'message', text: 'update_in_progress' });
    expect(startRefusal('boom')).toEqual({ kind: 'message', text: 'boom' });
  });

  it('recognises an older machine with no update route', () => {
    expect(isMissingRoute({ status: 404 })).toBe(true);
    expect(isMissingRoute({ status: 500 })).toBe(false);
    expect(isMissingRoute(null)).toBe(false);
  });
});
