import { describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { getFerretCompactAt, patchFerretCompactAt } from '../../../../app/compact-at/compact-at-api.ts';
import { fakeClient, refusal } from '../../../support/app/fake-client.ts';

const READ = { own: 250_000, effective: 250_000, window: 1_000_000, restartRequired: true, note: 'At next launch.' };
const SAVED = { effective: 300_000, restartRequired: false, note: 'Saved.' };

const rejection = async (work: Promise<unknown>): Promise<DaemonCallError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonCallError);
  return error as DaemonCallError;
};

describe('the compact-at dials', () => {
  it('reads what a launch would use from the ferret’s own route', async () => {
    const client = fakeClient({ 'GET /v1/ferrets/:ferretId/compact-at': () => READ });
    expect(await getFerretCompactAt(client, 'f/1')).toEqual(READ);
    expect(client.calls.map(call => [call.route, call.params])).toEqual([
      ['GET /v1/ferrets/:ferretId/compact-at', { ferretId: 'f/1' }],
    ]);
  });

  it('sets a value with its body and a request id', async () => {
    const client = fakeClient({ 'PATCH /v1/ferrets/:ferretId/compact-at': () => SAVED });
    const answer = await patchFerretCompactAt(client, 'f/1', 300_000);
    expect(answer.note).toBe('Saved.');
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.params).toEqual({ ferretId: 'f/1' });
    expect(client.calls[0]?.body).toEqual({ compactAt: 300_000 });
    expect(client.calls[0]?.headers['x-fy-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('sends `inherit` through unchanged', async () => {
    const client = fakeClient({
      'PATCH /v1/ferrets/:ferretId/compact-at': () => ({ effective: 'auto', restartRequired: false, note: 'Saved.' }),
    });
    await patchFerretCompactAt(client, 'f', 'inherit');
    expect(client.calls[0]?.body).toEqual({ compactAt: 'inherit' });
  });

  it('passes the daemon’s refusal through, on a read and on a write', async () => {
    const refused = () => {
      throw refusal(400, 'compact_at_too_large', 'too large for this window');
    };
    const client = fakeClient({
      'GET /v1/ferrets/:ferretId/compact-at': refused,
      'PATCH /v1/ferrets/:ferretId/compact-at': () => {
        throw refusal(409, 'conflict', 'held');
      },
    });
    const read = await rejection(getFerretCompactAt(client, 'f'));
    expect(read.status).toBe(400);
    expect(read.message).toBe('too large for this window');
    expect(read.code).toBe('compact_at_too_large');
    const write = await rejection(patchFerretCompactAt(client, 'f', 'auto'));
    expect(write.status).toBe(409);
  });

  it('refuses an answer that is not the contract’s shape', async () => {
    const client = fakeClient({ 'GET /v1/ferrets/:ferretId/compact-at': () => ({ effective: 7 }) });
    await expect(getFerretCompactAt(client, 'f')).rejects.toThrow();
  });
});
