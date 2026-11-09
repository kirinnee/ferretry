/**
 * The deadlines and races of the logins adapters, against a real listener that never answers and a real child whose
 * stdin goes away: a Codex callback nobody answers is `unreachable`, a hosted catalog that hangs costs a check and
 * not a boot, and a write into a child that has just gone is reported as not delivered, never thrown.
 */
import { afterEach, describe, it } from 'bun:test';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { deliverCodexCallback } from '../../daemon/adapters/harness-login/callback-delivery.ts';
import { spawnHarnessLoginChild } from '../../daemon/adapters/harness-login/login-child.ts';
import { HostedModelCatalog } from '../../daemon/adapters/models/hosted-model-catalog.ts';
import { realClock, realFetch } from '../support/real-ports.ts';

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A loopback listener that takes the request and never answers it. */
function silentListener(): number {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });
  servers.push(server);
  return server.port ?? 0;
}

describe('the deadlines', () => {
  it('should report a Codex callback nobody answers as unreachable once its deadline passes', async () => {
    // Arrange — the same real clock, with the deadline brought down to what a test can wait for.
    const quick = {
      after: (_delay: unknown, fn: () => void) => {
        const handle = setTimeout(fn, 100);
        return () => clearTimeout(handle);
      },
    };
    const port = silentListener();

    // Act
    const actual = await deliverCodexCallback(
      realFetch,
      quick as never,
    )({
      port,
      path: '/auth/callback',
      query: 'code=code-TESTONLY&state=STATE',
    });

    // Assert
    should(actual).equal('unreachable');
  });

  it('should answer nothing when the hosted catalog never answers within its timeout', async () => {
    const port = silentListener();

    const answer = await new HostedModelCatalog(`http://127.0.0.1:${port}`, realFetch, realClock, 100).get(
      'catalog/version.json',
    );

    should(answer).be.undefined();
  });
});

describe('a write into a child that goes away', () => {
  it('should report the value as not delivered when the pipe breaks during the write', async () => {
    // Arrange — a real child; the handle's write is the point where the pipe is gone.
    const real = bunSpawn({ PATH: '/usr/bin:/bin' });
    const breaking = {
      ...real,
      start: (...given: Parameters<typeof real.start>) => {
        const handle = real.start(...given);
        return {
          ...handle,
          write: () => {
            throw new Error('EPIPE');
          },
        };
      },
    };
    const child = spawnHarnessLoginChild(breaking as never)({
      command: ['sleep', '30'],
      environment: { PATH: '/usr/bin:/bin' },
      onLine: () => undefined,
    });

    // Act
    const delivered = await child.write('a-value\n');
    child.kill('SIGKILL');
    const code = await child.exited;

    // Assert
    should(delivered).equal(false);
    should(code).not.equal(0);
  });
});
