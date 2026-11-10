import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ClientSessionApi, FERRET_ROUTES } from '../../../cli/lib/client.ts';

type Init = Parameters<PluginClient['call']>[1] & { readonly headers?: { readonly 'x-fy-request-id'?: string } };
const stub = (call: (route: string, init?: Init) => Promise<unknown>): PluginClient => ({
  call: async <Answer>(route: string, init?: Init) => (await call(route, init)) as Answer,
  subscribe: () => () => undefined,
});

test('V-0434 R-0332 the actual CLI start retries with one request id and the same frozen body', async () => {
  const calls: (Init | undefined)[] = [];
  const input = { folder: '/work/a', prompt: 'first' };
  const api = new ClientSessionApi(
    stub(async (_route, init) => {
      calls.push(init);
      if (calls.length === 1) {
        input.prompt = 'changed while waiting';
        throw new TypeError('fetch failed');
      }
      return { id: 'child' };
    }),
  );
  expect(await api.start(input)).toEqual({ id: 'child' });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.headers?.['x-fy-request-id']).toBeTruthy();
  expect(calls[1]).toBe(calls[0]);
  expect(calls[1]?.body).toEqual({ folder: '/work/a', prompt: 'first' });
});

test('V-0434 R-0187 two lost CLI answers recover by the same request id and exact body digest', async () => {
  const calls: { route: string; init?: Init }[] = [];
  const body = { folder: '/work/a', prompt: 'hello' };
  const api = new ClientSessionApi(
    stub(async (route, init) => {
      calls.push({ route, init });
      if (route === FERRET_ROUTES.start) throw new TypeError('fetch failed');
      return { id: 'recovered' };
    }),
  );
  expect(await api.start(body)).toEqual({ id: 'recovered' });
  expect(calls).toHaveLength(3);
  const requestId = calls[0]?.init?.headers?.['x-fy-request-id'];
  expect(requestId).toBeTruthy();
  expect(calls[2]).toMatchObject({
    route: 'GET /v1/ferrets/by-request/:requestId',
    init: {
      params: { requestId },
      query: { payload: createHash('sha256').update(JSON.stringify(body)).digest('hex') },
    },
  });
});

test('S54 a CLI start refusal is final and never retried or recovered', async () => {
  let count = 0;
  const refusal = Object.assign(new Error('a start needs a request id'), { status: 400, code: 'missing_request_id' });
  const api = new ClientSessionApi(
    stub(async () => {
      count += 1;
      throw refusal;
    }),
  );
  await expect(api.start({ folder: '/work/a' })).rejects.toBe(refusal);
  expect(count).toBe(1);
});

const lostCodes = [
  'ConnectionRefused',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ENOENT',
  'ECONNRESET',
  'ConnectionClosed',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
] as const;

const startsTwiceThenRecovers = async (lost: unknown): Promise<number> => {
  let starts = 0;
  const api = new ClientSessionApi(
    stub(async route => {
      if (route !== FERRET_ROUTES.start) return { id: 'recovered' };
      starts += 1;
      throw lost;
    }),
  );
  expect(await api.start({ folder: '/work/a' })).toEqual({ id: 'recovered' });
  return starts;
};

for (const code of lostCodes) {
  test(`S54 a CLI start whose transport failed with ${code} is retried once and then recovered`, async () => {
    expect(await startsTwiceThenRecovers(Object.assign(new Error('socket gone'), { code }))).toBe(2);
  });
}

test('S54 a CLI start that timed out is a lost answer and is retried once and then recovered', async () => {
  const timeout = Object.assign(new Error('the call timed out'), { name: 'TimeoutError' });
  expect(await startsTwiceThenRecovers(timeout)).toBe(2);
});

test('S54 a CLI start wrapped around a lost transport cause is a lost answer', async () => {
  const wrapped = new Error('start failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  expect(await startsTwiceThenRecovers(wrapped)).toBe(2);
});

test('S54 a CLI start with an unknown error code and no cause is final', async () => {
  const final = Object.assign(new Error('something else'), { code: 'EACCES' });
  let starts = 0;
  const api = new ClientSessionApi(
    stub(async () => {
      starts += 1;
      throw final;
    }),
  );
  await expect(api.start({ folder: '/work/a' })).rejects.toBe(final);
  expect(starts).toBe(1);
});

test('S54 a CLI start whose error is its own cause is final instead of looping', async () => {
  const looping: Error & { cause?: unknown } = new Error('start failed');
  looping.cause = looping;
  let starts = 0;
  const api = new ClientSessionApi(
    stub(async () => {
      starts += 1;
      throw looping;
    }),
  );
  await expect(api.start({ folder: '/work/a' })).rejects.toBe(looping);
  expect(starts).toBe(1);
});
