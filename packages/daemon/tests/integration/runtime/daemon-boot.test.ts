import { describe, it } from 'bun:test';
import should from 'should';
import { DaemonBinder, DaemonHealthProbe } from '../../../src/adapters/runtime/daemon-boot.ts';
import type { DaemonFetchPort } from '../../../src/lib/runtime/boot.ts';
import { healthViewFixture } from '../../fixtures/health-view.ts';

/** A responder that always answers the same way, recording what it was asked. */
function fixedResponder(response: () => Response): {
  readonly fetcher: DaemonFetchPort;
  readonly calls: Array<{ readonly url: string; readonly init: RequestInit }>;
} {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  return {
    calls,
    fetcher: {
      async fetch(url, init) {
        calls.push({ url, init });
        return response();
      },
    },
  };
}

describe('daemon boot adapters', () => {
  it('should identify a responder that serves this product health report as one of these daemons', async () => {
    // Arrange
    const responder = fixedResponder(() => Response.json(healthViewFixture({ version: '9.9.9', pid: 4_242 })));

    // Act
    const occupant = await new DaemonHealthProbe(responder.fetcher).identify({
      url: 'http://127.0.0.1:7089/',
      token: 'token',
    });

    // Assert
    should(occupant).deepEqual({ kind: 'daemon', version: '9.9.9', pid: 4_242 });
    should(responder.calls).have.length(1);
    should(responder.calls[0]).containDeep({
      url: 'http://127.0.0.1:7089/v1/health',
      init: { headers: { authorization: 'Bearer token' } },
    });
  });

  it('should refuse to call a foreign responder its own incumbent', async () => {
    // Arrange: exactly what the agent supervisor this product coexists with answers on its own port.
    const unauthorized = fixedResponder(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const notJson = fixedResponder(() => new Response('<html>hello</html>', { status: 200 }));

    // Act
    const foreign = await new DaemonHealthProbe(unauthorized.fetcher).identify({ url: 'http://127.0.0.1:7089' });
    const webPage = await new DaemonHealthProbe(notJson.fetcher).identify({ url: 'http://127.0.0.1:7089' });

    // Assert
    should(foreign.kind).equal('stranger');
    should(webPage.kind).equal('stranger');
    // The evidence names what was actually seen, because 401 and "not our JSON" are different faults.
    should(foreign)
      .have.property('evidence')
      .match(/HTTP 401/u);
    should(webPage)
      .have.property('evidence')
      .match(/HTTP 200/u);
  });

  it('should clear the way only for an actively refused connection', async () => {
    // Arrange: the runtime reports a vacant port by error CODE; everything else leaves it open.
    const refused: DaemonFetchPort = {
      fetch: async () =>
        await Promise.reject(Object.assign(new Error('Unable to connect.'), { code: 'ConnectionRefused' })),
    };
    const timedOut: DaemonFetchPort = {
      fetch: async () =>
        await Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })),
    };

    // Act
    const vacant = await new DaemonHealthProbe(refused).identify({ url: 'http://127.0.0.1:7089' });
    const held = await new DaemonHealthProbe(timedOut).identify({ url: 'http://127.0.0.1:7089' });

    // Assert
    should(vacant).deepEqual({ kind: 'vacant' });
    // FAIL CLOSED: a probe that could not finish is not evidence of a free address.
    should(held.kind).equal('stranger');
    should(held)
      .have.property('evidence')
      .match(/timed out/u);
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
