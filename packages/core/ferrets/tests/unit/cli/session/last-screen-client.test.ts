import { expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ClientSessionApi } from '../../../../cli/lib/client.ts';

const answering = (answer: () => unknown, calls: unknown[] = []): PluginClient => ({
  call: async <T>(key: string, init?: unknown): Promise<T> => {
    calls.push({ key, init });
    return (await answer()) as T;
  },
  subscribe: () => () => {},
});

test('the client asks the stored last-screen route quietly for the one ferret and hands back its screen', async () => {
  const calls: unknown[] = [];
  const api = new ClientSessionApi(answering(() => ({ screen: '$ build\nout of memory\nKilled\n' }), calls));
  expect(await api.lastScreen('fern')).toBe('$ build\nout of memory\nKilled\n');
  expect(calls).toEqual([
    { key: 'GET /v1/ferrets/:ferretId/last-screen', init: { params: { ferretId: 'fern' }, quiet: true } },
  ]);
});

test('a last screen the daemon refuses or cannot answer is no screen, never a failure of the caller', async () => {
  const refused = Object.assign(new Error('forbidden'), { status: 403 });
  const none = Object.assign(new Error('no stored last screen'), { status: 409 });
  for (const fail of [refused, none]) {
    const api = new ClientSessionApi(
      answering(() => {
        throw fail;
      }),
    );
    expect(await api.lastScreen('fern')).toBeUndefined();
  }
});

test('an answer that is not a screen (no field, wrong type, nothing at all) is no screen', async () => {
  for (const answer of [{}, { screen: 7 }, 'a plain string', null, undefined]) {
    expect(await new ClientSessionApi(answering(() => answer)).lastScreen('fern')).toBeUndefined();
  }
});
