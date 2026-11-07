/**
 * Today's `request(path, schema, init)` over Access's own guarded client: the route key, the body, and the refusal.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { routeRequestClient } from '../../../app/lib/route-request.ts';
import { FyHttpError } from '../../../app/shell-grants.ts';

function recorder(answer: () => Promise<unknown>) {
  const calls: { route: string; init: unknown }[] = [];
  const client = routeRequestClient({
    call: async <Answer>(route: string, init?: unknown): Promise<Answer> => {
      calls.push({ route, init });
      return (await answer()) as Answer;
    },
  });
  return { client, calls };
}

describe('the route request client', () => {
  it('should name the route by method and path, and hand the JSON body over as a value', async () => {
    const { client, calls } = recorder(async () => ({ expiresAt: 'soon' }));
    const answer = await client.request('/v1/step-up', z.strictObject({ expiresAt: z.string() }), {
      method: 'post',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'cred' }),
    });
    expect(answer).toEqual({ expiresAt: 'soon' });
    expect(calls).toEqual([{ route: 'POST /v1/step-up', init: { body: { id: 'cred' } } }]);
  });

  it('should read a call with no method as a GET with no body', async () => {
    const { client, calls } = recorder(async () => ({ ok: true }));
    await client.request('/v1/security', z.strictObject({ ok: z.boolean() }));
    expect(calls).toEqual([{ route: 'GET /v1/security', init: {} }]);
  });

  it('should turn a refusal into today’s FyHttpError, with its status, code and whole body', async () => {
    const body = { error: 'Not verified.', code: 'step_up_not_verified' };
    const { client } = recorder(async () => {
      throw Object.assign(new Error('Not verified.'), { status: 403, code: 'step_up_not_verified', body });
    });
    const failure = await client.request('/v1/step-up', z.unknown(), { method: 'POST', body: '{}' }).catch(e => e);
    expect(failure).toBeInstanceOf(FyHttpError);
    expect((failure as FyHttpError).status).toBe(403);
    expect((failure as FyHttpError).code).toBe('step_up_not_verified');
    expect((failure as FyHttpError).body).toEqual(body);
  });

  it('should refuse an answer that does not parse rather than guess', async () => {
    const { client } = recorder(async () => ({ expiresAt: 7 }));
    const failure = await client
      .request('/v1/step-up', z.strictObject({ expiresAt: z.string() }), { method: 'POST', body: '{}' })
      .catch(e => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(FyHttpError);
  });

  it('should pass any other failure on as it came', async () => {
    const reason = new TypeError('socket closed');
    const { client } = recorder(async () => {
      throw reason;
    });
    expect(await client.request('/v1/passkeys', z.unknown()).catch(e => e)).toBe(reason);
  });
});
