import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER } from '@ferretry/protocol';
import {
  actOnLearningProposal,
  applyLearningProposal,
  cancelLearningScan,
  estimateLearningScan,
  fetchApplyPreview,
  fetchLearningConfig,
  fetchLearningProposals,
  fetchLearningScan,
  fetchLearningStatus,
  fetchSessionLearning,
  isApplyConflict,
  learningErrorMessage,
  patchLearningConfig,
  patchSessionLearning,
  startLearningScan,
} from '../../src/lib/learning-api.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import { AT, config, estimate, fakeLearningDaemon, learningDaemon, lesson, preview, progress } from '../support/learning.ts';

describe('learning transport', () => {
  it('dials every learning route on the paired daemon with the stated verb and body', async () => {
    const daemon = fakeLearningDaemon();
    daemon.state.sessions = [{ sessionId: 's', passive: true, since: AT, setBy: 'owner' }];
    const status = {
      enabled: true,
      intervalMinutes: 60,
      pending: { total: 0, strong: 0, weak: 0 },
      totals: { observations: 0, proposals: 0, tombstones: 0 },
      running: false,
      passiveDefault: true,
    };
    daemon.once('GET /v1/learning/status', { body: status });
    const fetcher = daemon.fetch;

    expect(await fetchLearningStatus(learningDaemon, fetcher)).toEqual(status);
    expect(await fetchLearningConfig(learningDaemon, fetcher)).toEqual(config());
    expect((await patchLearningConfig(learningDaemon, { passiveDefault: false }, fetcher)).passiveDefault).toBe(false);
    expect(await fetchLearningProposals(learningDaemon, fetcher)).toEqual([lesson()]);
    expect(await fetchLearningProposals(learningDaemon, fetcher, 'applied')).toEqual([lesson()]);
    expect((await actOnLearningProposal(learningDaemon, 'lesson-a', { action: 'accept' }, fetcher)).state).toBe(
      'accepted',
    );
    expect(await fetchApplyPreview(learningDaemon, 'lesson-a', fetcher)).toEqual(preview());
    expect((await applyLearningProposal(learningDaemon, 'lesson-a', 'etag-1', fetcher)).state).toBe('applied');
    expect(await fetchSessionLearning(learningDaemon, fetcher)).toEqual(daemon.state.sessions);
    expect((await patchSessionLearning(learningDaemon, 'a/b', true, fetcher)).learning.sessionId).toBe('a/b');
    const request = { scope: { kind: 'not-passive' } } as const;
    expect(await estimateLearningScan(learningDaemon, request, fetcher)).toEqual(estimate());
    expect(await startLearningScan(learningDaemon, request, fetcher)).toEqual(progress());
    expect(await fetchLearningScan(learningDaemon, fetcher)).toEqual({ scan: progress() });
    expect((await cancelLearningScan(learningDaemon, fetcher)).state).toBe('cancelled');

    expect(daemon.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/learning/status',
      'GET /v1/learning/config',
      'PATCH /v1/learning/config',
      'GET /v1/learning/proposals',
      'GET /v1/learning/proposals?state=applied',
      'POST /v1/learning/proposals/lesson-a',
      'GET /v1/learning/proposals/lesson-a/apply-preview',
      'POST /v1/learning/proposals/lesson-a/apply',
      'GET /v1/learning/sessions',
      'PATCH /v1/sessions/a%2Fb/learning',
      'POST /v1/learning/scan/estimate',
      'POST /v1/learning/scan',
      'GET /v1/learning/scan',
      'POST /v1/learning/scan/cancel',
    ]);
    expect(daemon.calls.map(call => call.body)).toContainEqual({ etag: 'etag-1' });
    expect(daemon.calls.map(call => call.body)).toContainEqual({ passive: true });
    expect(daemon.calls.map(call => call.body)).toContainEqual(request);
  });

  it('stamps every write with a fresh request id and a JSON content type', async () => {
    const seen: Headers[] = [];
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify(progress()));
    };
    await cancelLearningScan(learningDaemon, fetcher);
    await cancelLearningScan(learningDaemon, fetcher);
    expect(seen.map(headers => headers.get('content-type'))).toEqual(['application/json', 'application/json']);
    const [first, second] = seen.map(headers => headers.get(FY_REQUEST_ID_HEADER));
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('turns a refusal into a typed error and recognises an apply conflict', async () => {
    const daemon = fakeLearningDaemon();
    daemon.once('POST /v1/learning/proposals/lesson-a/apply', {
      status: 409,
      body: { error: 'the file changed', code: 'apply_conflict' },
    });
    const conflict = await applyLearningProposal(learningDaemon, 'lesson-a', 'etag-1', daemon.fetch).catch(
      (reason: unknown) => reason,
    );
    expect(conflict).toBeInstanceOf(DaemonResponseError);
    expect(isApplyConflict(conflict)).toBe(true);
    expect(learningErrorMessage(conflict)).toBe('the file changed');

    daemon.once('GET /v1/learning/config', { status: 500, body: 'not json at all' });
    const plain = await fetchLearningConfig(learningDaemon, daemon.fetch).catch((reason: unknown) => reason);
    expect(plain).toBeInstanceOf(DaemonResponseError);
    expect((plain as DaemonResponseError).message).toBe('HTTP 500');
    expect(isApplyConflict(plain)).toBe(false);
    expect(isApplyConflict(new DaemonResponseError(409, 'scan running', 'scan_running'))).toBe(false);
    expect(isApplyConflict(new Error('x'))).toBe(false);
    expect(learningErrorMessage('nope')).toBe('Learning is unavailable on this daemon.');

    const broken = async () => new Response('{', { status: 502 });
    expect(((await fetchLearningConfig(learningDaemon, broken).catch(e => e)) as Error).message).toBe('HTTP 502');
  });

  it('rejects an answer that is not the contract', async () => {
    const daemon = fakeLearningDaemon();
    daemon.once('POST /v1/learning/scan/estimate', { body: { sessions: -1 } });
    await expect(estimateLearningScan(learningDaemon, { scope: { kind: 'not-passive' } }, daemon.fetch)).rejects.toThrow();
  });
});
