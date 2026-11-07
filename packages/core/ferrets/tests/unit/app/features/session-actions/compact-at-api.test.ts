import { describe, expect, it } from 'bun:test';
import { daemonConnection } from '../../../../../app/lib/daemon-connection.ts';
import { getSessionCompactAt, patchSessionCompactAt } from '../../../../../../../plugins/conversation/app/lib/compact-at-api.ts';
import { type DaemonFetch, DaemonResponseError } from '../../../../../../../plugins/runtimes/app/lib/runtime-models.ts';
import { schemaValidSessionView } from '@ferretry/app/testing';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'a-token' });

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
  readonly headers: Headers;
}

const recording = (status: number, body: unknown): { fetcher: DaemonFetch; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    },
  };
};

const rejection = async (work: Promise<unknown>): Promise<DaemonResponseError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonResponseError);
  return error as DaemonResponseError;
};

const READ = { own: 250_000, effective: 250_000, window: 1_000_000, restartRequired: true, note: 'At next launch.' };

describe('the compact-at dials', () => {
  it('reads what a launch would use from the session’s own path', async () => {
    const { fetcher, calls } = recording(200, READ);
    expect(await getSessionCompactAt(daemon, 'ses/1', fetcher)).toEqual(READ);
    expect(calls.map(call => [call.url, call.method ?? 'GET'])).toEqual([
      ['https://a.example.test/v1/sessions/ses%2F1/compact-at', 'GET'],
    ]);
  });

  it('sets a value with a JSON body and a request id', async () => {
    const result = {
      view: schemaValidSessionView('ses/1'),
      effective: 300_000,
      restartRequired: false,
      note: 'Saved.',
    };
    const { fetcher, calls } = recording(200, result);
    const answer = await patchSessionCompactAt(daemon, 'ses/1', 300_000, fetcher);
    expect(answer.note).toBe('Saved.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/ses%2F1/compact-at');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.body).toEqual({ compactAt: 300_000 });
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('sends `inherit` through unchanged', async () => {
    const result = { view: schemaValidSessionView('s'), effective: 'auto', restartRequired: false, note: 'Saved.' };
    const { fetcher, calls } = recording(200, result);
    await patchSessionCompactAt(daemon, 's', 'inherit', fetcher);
    expect(calls[0]?.body).toEqual({ compactAt: 'inherit' });
  });

  it('turns a refusal into the daemon’s own words and code, on a read and on a write', async () => {
    const body = { error: 'too large for this window', code: 'compact_at_too_large' };
    const read = await rejection(getSessionCompactAt(daemon, 's', recording(400, body).fetcher));
    expect(read.status).toBe(400);
    expect(read.message).toBe('too large for this window');
    expect(read.code).toBe('compact_at_too_large');
    const write = await rejection(patchSessionCompactAt(daemon, 's', 'auto', recording(409, body).fetcher));
    expect(write.status).toBe(409);
  });

  it('falls back to the status when the refusal is not JSON or says nothing useful', async () => {
    const plain = await rejection(getSessionCompactAt(daemon, 's', recording(502, 'bad gateway').fetcher));
    expect(plain.message).toBe('HTTP 502');
    expect(plain.code).toBeUndefined();
    const odd = await rejection(getSessionCompactAt(daemon, 's', recording(500, { error: 7, code: 7 }).fetcher));
    expect(odd.message).toBe('HTTP 500');
    expect(odd.code).toBeUndefined();
  });
});
