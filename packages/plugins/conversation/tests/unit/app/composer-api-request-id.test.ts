import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { composerApi } from '../../../app/composer/composer-api.ts';

type Init = NonNullable<Parameters<PluginClient['call']>[1]>;

const RESULT = { ferret: 'f1', disposition: 'queued', sendId: 'req-1' };

/** A client that records each call and answers the send route, or throws the next queued failure. */
const build = (failures: Error[] = []) => {
  const calls: Array<{ route: string; init: Init | undefined }> = [];
  const client = {
    call: (async (route: string, init?: Init) => {
      calls.push({ route, init });
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return RESULT;
    }) as unknown as PluginClient['call'],
  };
  return { client, calls };
};

describe('the composer’s send carries its idempotency key in the header the daemon requires', () => {
  it('sends x-fy-request-id equal to the body sendId, or the daemon refuses the send (missing_request_id)', async () => {
    const { client, calls } = build();
    await composerApi(client, { requestId: () => 'req-1' }).send('f1', { message: 'hello' });
    expect(calls[0]?.route).toBe('POST /v1/ferrets/:ferretId/send');
    expect(calls[0]?.init?.body).toEqual({ message: 'hello', sendId: 'req-1' });
    expect(calls[0]?.init?.headers).toEqual({ 'x-fy-request-id': 'req-1' });
  });

  it('puts a caller-chosen request id in both places, and a retry of a failed send reuses the same one in both', async () => {
    const { client, calls } = build([new Error('lost answer')]);
    let minted = 0;
    const api = composerApi(client, {
      requestId: () => {
        minted += 1;
        return `minted-${minted}`;
      },
    });
    await expect(api.send('f1', { message: 'again' })).rejects.toThrow('lost answer');
    await api.send('f1', { message: 'again' });
    expect(minted).toBe(1);
    for (const call of calls) {
      expect(call.init?.headers).toEqual({ 'x-fy-request-id': 'minted-1' });
      expect(call.init?.body).toEqual({ message: 'again', sendId: 'minted-1' });
    }
    await api.send('f1', { message: 'other' }, 'given-9');
    expect(calls[2]?.init?.headers).toEqual({ 'x-fy-request-id': 'given-9' });
    expect(calls[2]?.init?.body).toEqual({ message: 'other', sendId: 'given-9' });
  });
});
