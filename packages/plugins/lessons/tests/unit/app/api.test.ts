import { describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import {
  actOnLessonsProposal,
  applyLessonsProposal,
  cancelLessonsScan,
  estimateLessonsScan,
  fetchApplyPreview,
  fetchFerretLessons,
  fetchLessonsConfig,
  fetchLessonsFerrets,
  fetchLessonsProposals,
  fetchLessonsScan,
  isApplyConflict,
  lessonsErrorMessage,
  patchFerretLessons,
  patchLessonsConfig,
  startLessonsScan,
} from '../../../app/src/api.ts';
import {
  AT,
  config,
  directory,
  estimate,
  fakeLessonsDaemon,
  lesson,
  preview,
  progress,
} from '../../support/app/lessons.ts';

describe('lessons transport', () => {
  it('dials every lessons route through the client with the stated route and body', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.state.ferrets = [{ ferretId: 's', passive: true, since: AT, setBy: 'owner' }];
    const { connection } = daemon;

    expect(await fetchLessonsConfig(connection)).toEqual(config());
    expect((await patchLessonsConfig(connection, { passiveDefault: false })).passiveDefault).toBe(false);
    expect(await fetchLessonsProposals(connection)).toEqual([lesson()]);
    expect(await fetchLessonsProposals(connection, 'applied')).toEqual([lesson()]);
    expect((await actOnLessonsProposal(connection, 'lesson-a', { action: 'accept' })).state).toBe('accepted');
    expect(await fetchApplyPreview(connection, 'lesson-a')).toEqual(preview());
    expect((await applyLessonsProposal(connection, 'lesson-a', 'etag-1')).state).toBe('applied');
    expect(await fetchFerretLessons(connection)).toEqual(daemon.state.ferrets);
    expect((await patchFerretLessons(connection, 'a/b', true)).lessons.ferretId).toBe('a/b');
    expect(await fetchLessonsFerrets(connection)).toEqual(directory);
    const request = { scope: { kind: 'not-passive' } } as const;
    expect(await estimateLessonsScan(connection, request)).toEqual(estimate());
    expect(await startLessonsScan(connection, request)).toEqual(progress());
    expect(await fetchLessonsScan(connection)).toEqual({ scan: progress() });
    expect((await cancelLessonsScan(connection)).state).toBe('cancelled');

    expect(daemon.calls.map(call => call.route)).toEqual([
      'GET /v1/lessons/config',
      'PATCH /v1/lessons/config',
      'GET /v1/lessons/proposals',
      'GET /v1/lessons/proposals',
      'POST /v1/lessons/proposals/:id',
      'GET /v1/lessons/proposals/:id/apply-preview',
      'POST /v1/lessons/proposals/:id/apply',
      'GET /v1/lessons/ferrets',
      'PATCH /v1/ferrets/:ferretId/lessons',
      'GET /v1/lessons/directory',
      'POST /v1/lessons/scan/estimate',
      'POST /v1/lessons/scan',
      'GET /v1/lessons/scan',
      'POST /v1/lessons/scan/cancel',
    ]);
    expect(daemon.calls[3]?.query).toEqual({ state: 'applied' });
    expect(daemon.calls[8]?.params).toEqual({ ferretId: 'a/b' });
    expect(daemon.calls.map(call => call.body)).toContainEqual({ etag: 'etag-1' });
    expect(daemon.calls.map(call => call.body)).toContainEqual({ passive: true });
    expect(daemon.calls.map(call => call.body)).toContainEqual(request);
  });

  it('turns a refusal into a typed error and recognises an apply conflict', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('POST /v1/lessons/proposals/:id/apply', {
      refuse: { status: 409, code: 'apply_conflict', message: 'the file changed' },
    });
    const conflict = await applyLessonsProposal(daemon.connection, 'lesson-a', 'etag-1').catch(
      (reason: unknown) => reason,
    );
    expect(conflict).toBeInstanceOf(DaemonCallError);
    expect(isApplyConflict(conflict)).toBe(true);
    expect(lessonsErrorMessage(conflict)).toBe('the file changed');

    expect(isApplyConflict(new DaemonCallError(409, 'scan_running', 'scan running'))).toBe(false);
    expect(isApplyConflict(new DaemonCallError(500, 'apply_conflict', 'x'))).toBe(false);
    expect(isApplyConflict(new Error('x'))).toBe(false);
    expect(lessonsErrorMessage('nope')).toBe('Lessons are unavailable on this daemon.');
  });

  it('rejects an answer that is not the contract', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('POST /v1/lessons/scan/estimate', { body: { ferrets: -1 } });
    await expect(estimateLessonsScan(daemon.connection, { scope: { kind: 'not-passive' } })).rejects.toThrow();
  });
});
