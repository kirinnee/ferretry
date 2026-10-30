import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER } from '@ferretry/protocol';
import { restartFerrets } from '../../../../src/features/restart-outdated/restart-outdated-api.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { type DaemonFetch, DaemonResponseError } from '../../../../src/lib/runtime-models.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'a-token' });
const RESULT = { restarted: [{ id: 'a' }], queued: [], skipped: [], failed: [] };

function answering(status: number, body: string) {
  const calls: { url: string; method?: string; body?: unknown; id: string | null }[] = [];
  const fetcher: DaemonFetch = async (url, init) => {
    calls.push({
      url: String(url),
      ...(init?.method === undefined ? {} : { method: init.method }),
      body: init?.body,
      id: new Headers(init?.headers).get(FY_REQUEST_ID_HEADER),
    });
    return new Response(body, { status });
  };
  return { fetcher, calls };
}

describe('restartFerrets', () => {
  it('should post the request with a stable request id and parse the answer', async () => {
    const { fetcher, calls } = answering(200, JSON.stringify(RESULT));

    const result = await restartFerrets(daemon, fetcher, { scope: 'outdated' }, 'req-1');

    expect(result).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://a.example.test/v1/restarts');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('{"scope":"outdated"}');
    expect(calls[0]?.id).toBe('req-1');
  });

  it('should mint a request id when none is given', async () => {
    const { fetcher, calls } = answering(200, JSON.stringify(RESULT));

    await restartFerrets(daemon, fetcher, { scope: 'outdated' });

    expect(calls[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should refuse with the daemon message, and with the status when it gave none', async () => {
    const refused = answering(409, JSON.stringify({ error: 'busy', code: 'busy' }));
    const bare = answering(500, 'nope');

    const first = await restartFerrets(daemon, refused.fetcher, { scope: 'all' }).catch((e: unknown) => e);
    const second = await restartFerrets(daemon, bare.fetcher, { scope: 'all' }).catch((e: unknown) => e);

    expect(first).toBeInstanceOf(DaemonResponseError);
    expect((first as DaemonResponseError).message).toBe('busy');
    expect((second as DaemonResponseError).message).toBe('HTTP 500');
  });

  it('should refuse a body it cannot read', async () => {
    const { fetcher } = answering(200, '{"restarted":3}');

    const error = await restartFerrets(daemon, fetcher, { scope: 'outdated' }).catch((e: unknown) => e);

    expect((error as DaemonResponseError).status).toBe(502);
  });
});
