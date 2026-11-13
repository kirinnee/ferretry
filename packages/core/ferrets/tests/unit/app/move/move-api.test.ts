import { describe, expect, it } from 'bun:test';
import {
  askToStopJobs,
  moveFerret,
  moveToOtherHarness,
  readConversionPreview,
  readFerret,
  UnreadableAnswerError,
} from '../../../../app/features/move/move-api.ts';
import type { FerretsClient } from '../../../../app/lib/client.ts';
import { type Call, scripted } from '../support/client.ts';
import { readyPreview, summaryOf } from './support.ts';

type Init = { params?: Record<string, string>; body?: unknown; headers?: unknown };

/** A client that records every call (route, init) and answers one scripted value. */
const recording = (answer: unknown, log: { route: string; init: Init | undefined }[]): FerretsClient => ({
  call: (async (route: string, init?: Init) => {
    log.push({ route, init });
    return answer;
  }) as FerretsClient['call'],
});

describe('readFerret', () => {
  it('reads the ferret by id and parses the summary', async () => {
    const calls: Call[] = [];
    const client = scripted({ 'GET /v1/ferrets/:ferretId': summaryOf() }, calls);
    expect((await readFerret(client, 'f/1')).name).toBe('Hadi');
    expect(calls[0]).toMatchObject({ route: 'GET /v1/ferrets/:ferretId', params: { ferretId: 'f/1' } });
  });

  it('fails a body it cannot read, without quoting it', async () => {
    const client = scripted({ 'GET /v1/ferrets/:ferretId': { nonsense: 'secret-looking text' } });
    const failing = readFerret(client, 'f-1');
    await expect(failing).rejects.toBeInstanceOf(UnreadableAnswerError);
    await expect(failing).rejects.toThrow('this page cannot read');
  });
});

describe('moveFerret', () => {
  it('posts the target with the request id, and parses the moved summary', async () => {
    const log: { route: string; init: Init | undefined }[] = [];
    const client = recording(summaryOf({ runtime: 'claude-b' }), log);
    const moved = await moveFerret(
      client,
      'f-1',
      { agent: 'claude-b', model: 'claude-opus-5[1m]', allowContextDowngrade: false },
      'req-1',
    );
    expect(moved.runtime).toBe('claude-b');
    expect(log).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/move',
        init: {
          params: { ferretId: 'f-1' },
          body: { agent: 'claude-b', model: 'claude-opus-5[1m]', allowContextDowngrade: false, forceInflight: false },
          headers: { 'x-fy-request-id': 'req-1' },
        },
      },
    ]);
  });

  it('leaves the model out when none was asked for', async () => {
    const calls: Call[] = [];
    const client = scripted({ 'POST /v1/ferrets/:ferretId/move': summaryOf() }, calls);
    await moveFerret(client, 'f-1', { agent: 'claude-b', allowContextDowngrade: true }, 'r');
    expect(calls[0]?.body).toEqual({ agent: 'claude-b', allowContextDowngrade: true, forceInflight: false });
  });
});

describe('readConversionPreview', () => {
  it('posts the agent to the ferret’s preview route and parses the answer', async () => {
    const calls: Call[] = [];
    const client = scripted({ 'POST /v1/ferrets/:ferretId/conversion-preview': readyPreview }, calls);
    expect(await readConversionPreview(client, 'f/1', 'codex-a')).toEqual(readyPreview);
    expect(calls[0]).toMatchObject({
      route: 'POST /v1/ferrets/:ferretId/conversion-preview',
      params: { ferretId: 'f/1' },
      body: { agent: 'codex-a' },
    });
  });

  it('passes a daemon refusal through as it came', async () => {
    const refusal = Object.assign(new Error('no such agent'), { status: 404, code: 'unknown_agent' });
    const client = scripted({ 'POST /v1/ferrets/:ferretId/conversion-preview': refusal });
    await expect(readConversionPreview(client, 'f-1', 'x')).rejects.toMatchObject({
      status: 404,
      message: 'no such agent',
      code: 'unknown_agent',
    });
  });

  it('fails a body it cannot read', async () => {
    const client = scripted({ 'POST /v1/ferrets/:ferretId/conversion-preview': { kind: 'maybe' } });
    await expect(readConversionPreview(client, 'f-1', 'x')).rejects.toBeInstanceOf(UnreadableAnswerError);
  });
});

describe('moveToOtherHarness', () => {
  it('moves with conversation convert and the request id, forcing only when told to', async () => {
    const log: { route: string; init: Init | undefined }[] = [];
    const client = recording(summaryOf({ harness: 'codex' }), log);
    await moveToOtherHarness(client, 'f-1', 'codex-a', 'req-1', false);
    await moveToOtherHarness(client, 'f-1', 'codex-a', 'req-2', true);
    expect(log.map(entry => ({ body: entry.init?.body, headers: entry.init?.headers }))).toEqual([
      {
        body: { agent: 'codex-a', allowContextDowngrade: false, forceInflight: false, conversation: 'convert' },
        headers: { 'x-fy-request-id': 'req-1' },
      },
      {
        body: { agent: 'codex-a', allowContextDowngrade: false, forceInflight: true, conversation: 'convert' },
        headers: { 'x-fy-request-id': 'req-2' },
      },
    ]);
  });
});

describe('askToStopJobs', () => {
  it('asks the ferret and parses the queued message', async () => {
    const calls: Call[] = [];
    const client = scripted(
      {
        'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs': {
          messageId: 'm-1',
          jobs: [{ pid: 5100, command: 'bash /tmp/job.sh' }],
          alreadyAsked: false,
        },
      },
      calls,
    );
    expect((await askToStopJobs(client, 'f-1')).messageId).toBe('m-1');
    expect(calls[0]).toMatchObject({
      route: 'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs',
      params: { ferretId: 'f-1' },
    });
  });
});
