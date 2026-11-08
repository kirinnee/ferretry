import { describe, expect, it } from 'bun:test';
import { SessionCompactAtError } from '../../../../daemon/turns/compact-at/lib/service.ts';
import {
  type SessionCompactAtSubsystem,
  sessionCompactAtRoutes,
} from '../../../../daemon/turns/lib/mounts/session-compact-at.ts';
import { answerOf, refusalOf } from '../../../support/mount-call.ts';

const PATH = '/v1/ferrets/:ferretId/compact-at';
const ID = { ferretId: 'f1' };

const build = (failure?: unknown) => {
  const calls: unknown[][] = [];
  const subsystem = {
    get: async (...args: unknown[]) => {
      calls.push(['get', ...args]);
      if (failure !== undefined) throw failure;
      return { effective: 'auto', restartRequired: false, note: 'default' };
    },
    set: async (...args: unknown[]) => {
      calls.push(['set', ...args]);
      if (failure !== undefined) throw failure;
      return { view: {}, outcome: { effective: 200_000, restartRequired: true, note: 'on restart' } };
    },
  } as unknown as SessionCompactAtSubsystem;
  return { routes: sessionCompactAtRoutes(subsystem), calls };
};

describe('GET compact-at', () => {
  it('answers the ferret’s setting', async () => {
    const { routes, calls } = build();
    expect(await answerOf(routes, 'GET', PATH, { params: ID })).toEqual({
      status: 200,
      json: { effective: 'auto', restartRequired: false, note: 'default' },
    });
    expect(calls).toEqual([['get', 'f1']]);
  });

  it('refuses a path that is not a usable ferret id', async () => {
    const refusal = await refusalOf(build().routes, 'GET', PATH, { params: { ferretId: '' } });
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('invalid_session_id');
  });
});

describe('PATCH compact-at', () => {
  it('sets the threshold and answers what it means for the running ferret', async () => {
    const { routes, calls } = build();
    const answer = await answerOf(routes, 'PATCH', PATH, { params: ID, body: { compactAt: 200_000 } });
    expect(answer).toEqual({ status: 200, json: { effective: 200_000, restartRequired: true, note: 'on restart' } });
    expect(calls).toEqual([['set', 'f1', 200_000]]);
  });

  it('answers 404 for a ferret it does not know, 400 for a value it refuses, and lets any other failure through', async () => {
    const missing = await refusalOf(build(new SessionCompactAtError('not-found', 'no f1')).routes, 'PATCH', PATH, {
      params: ID,
      body: { compactAt: 'inherit' },
    });
    expect([missing.status, missing.code]).toEqual([404, 'not-found']);
    const invalid = await refusalOf(build(new SessionCompactAtError('invalid', 'too small')).routes, 'PATCH', PATH, {
      params: ID,
      body: { compactAt: 'auto' },
    });
    expect([invalid.status, invalid.code]).toEqual([400, 'invalid_compact_at']);
    const broken = await refusalOf(build(new TypeError('boom')).routes, 'GET', PATH, { params: ID });
    expect(broken.message).toBe('boom');
  });
});
