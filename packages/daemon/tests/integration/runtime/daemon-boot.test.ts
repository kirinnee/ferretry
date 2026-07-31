import { describe, it } from 'bun:test';
import should from 'should';
import { DaemonBinder, DaemonHealthProbe } from '../../../src/adapters/runtime/daemon-boot.ts';
import type { DaemonFetchPort } from '../../../src/lib/runtime/boot.ts';

describe('daemon boot adapters', () => {
  it('should probe the health endpoint with an optional bearer token and treat any response as occupied', async () => {
    // Arrange
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetcher: DaemonFetchPort = {
      async fetch(url, init) {
        calls.push({ url, init });
        return new Response(null, { status: 401 });
      },
    };

    // Act
    const occupied = await new DaemonHealthProbe(fetcher).responds({ url: 'http://127.0.0.1:7337/', token: 'token' });

    // Assert
    should(occupied).be.true();
    should(calls).have.length(1);
    should(calls[0]).containDeep({
      url: 'http://127.0.0.1:7337/v1/health',
      init: { headers: { authorization: 'Bearer token' } },
    });
  });

  it('should clear the way only when a probe fails', async () => {
    // Arrange
    const rejected: DaemonFetchPort = { fetch: async () => await Promise.reject(new Error('connection refused')) };

    // Act + Assert
    should(await new DaemonHealthProbe(rejected).responds({ url: 'http://127.0.0.1:7337' })).be.false();
  });

  it('should retry an address conflict but preserve terminal binding errors', async () => {
    // Arrange
    let now = 0;
    const sleeps: number[] = [];
    const binder = new DaemonBinder(
      {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      },
      { now: () => now },
      { backoffMs: 10, totalMs: 20, maxAttempts: 2 },
    );
    let attempts = 0;

    // Act
    const result = await binder.bind(() => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
      return 'bound';
    });

    // Assert
    should(result).equal('bound');
    should(sleeps).deepEqual([10]);
    await binder
      .bind(() => {
        throw new Error('permission denied');
      })
      .then(
        () => {
          throw new Error('expected terminal bind error');
        },
        error => should(error.message).equal('permission denied'),
      );
    await new DaemonBinder({ async sleep() {} }, { now: () => 0 }, { backoffMs: 1, totalMs: 1_000, maxAttempts: 2 })
      .bind(() => {
        throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
      })
      .then(
        () => {
          throw new Error('expected bounded retry failure');
        },
        error => should(error.code).equal('EADDRINUSE'),
      );
  });
});
