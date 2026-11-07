import { describe, expect, it } from 'bun:test';
import { readRelaunchSettings } from '../../../../src/features/session-info/relaunch-settings-api.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import { type DaemonFetch, DaemonResponseError } from '../../../../src/lib/runtime-models.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'a-token' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'b-token' });
const scopeA = daemonSessionScope(daemonA, 'ses/1');

function answering(status: number, body: string): { fetcher: DaemonFetch; urls: string[]; signals: unknown[] } {
  const urls: string[] = [];
  const signals: unknown[] = [];
  return {
    urls,
    signals,
    fetcher: async (url, init) => {
      urls.push(`${init?.method} ${String(url)}`);
      signals.push(init?.signal);
      return new Response(body, { status });
    },
  };
}

const rejection = async (work: Promise<unknown>): Promise<DaemonResponseError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonResponseError);
  return error as DaemonResponseError;
};

describe('the relaunch-settings dial', () => {
  it('reads one ferret answer from the daemon that owns it, with the caller signal', async () => {
    // Arrange
    const { fetcher, urls, signals } = answering(200, JSON.stringify({ current: false, reasons: ['settings'] }));
    const signal = new AbortController().signal;

    // Act
    const answer = await readRelaunchSettings(daemonA, scopeA, fetcher, signal);
    await readRelaunchSettings(daemonA, scopeA, fetcher);

    // Assert
    expect(answer).toEqual({ current: false, reasons: ['settings'] });
    expect(urls).toEqual([
      'GET https://a.example.test/v1/sessions/ses%2F1/relaunch-settings',
      'GET https://a.example.test/v1/sessions/ses%2F1/relaunch-settings',
    ]);
    expect(signals[0]).toBe(signal);
    expect(signals[1]).toBeUndefined();
  });

  it('refuses to ask one daemon about another daemon session', async () => {
    // Arrange
    const { fetcher, urls } = answering(200, '{}');

    // Act / Assert
    await expect(readRelaunchSettings(daemonB, scopeA, fetcher)).rejects.toThrow('does not own');
    expect(urls).toEqual([]);
  });

  it('carries the daemon sentence on a refusal, and its status when it says nothing', async () => {
    // Act
    const said = await rejection(
      readRelaunchSettings(
        daemonA,
        scopeA,
        answering(404, JSON.stringify({ error: 'no session', code: 'not-found' })).fetcher,
      ),
    );
    const silent = await rejection(readRelaunchSettings(daemonA, scopeA, answering(500, 'not json').fetcher));

    // Assert
    expect([said.status, said.message, said.code]).toEqual([404, 'no session', 'not-found']);
    expect([silent.status, silent.message, silent.code]).toEqual([500, 'HTTP 500', undefined]);
  });

  it('refuses a body it cannot read rather than claiming anything about the ferret', async () => {
    // Act
    const malformed = await rejection(
      readRelaunchSettings(daemonA, scopeA, answering(200, '{"current":"yes"}').fetcher),
    );
    const unparsable = await rejection(readRelaunchSettings(daemonA, scopeA, answering(200, 'nope').fetcher));

    // Assert
    expect(malformed.status).toBe(502);
    expect(unparsable.status).toBe(502);
  });
});
