import { afterEach, describe, it } from 'bun:test';
import { HealthViewSchema } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import type { z } from 'zod';
import { HEALTH_PATH, type HealthApiClient, ProtocolDaemonHealth } from '../../../src/adapters/daemon/health';

const body = {
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete',
  bootstrapDegraded: false,
  version: '1.2.3',
  pid: 4242,
  sessions: 1,
  running: 1,
  monitors: 1,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: 0,
  wardenTimerArmed: true,
  eventLoopLagMs: 0.5,
  lastSelfCheckAt: '2026-07-31T00:00:00.000Z',
  wedgeCount: 0,
  scratchGcEnabled: false,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: '2026-07-31T00:00:01.000Z',
};

/**
 * A real HTTP server on an EPHEMERAL loopback port — never a known port, never the live daemon.
 * The protocol client and the protocol schema are both the real ones, so what this proves is the
 * whole round trip.
 */
function serve(handler: (request: Request) => Response): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  return { server, url: `http://127.0.0.1:${String(server.port)}` };
}

async function client(url: string): Promise<HealthApiClient> {
  const connected = await FyApiClient.connect({ baseUrl: url, token: 'test-token', version: '1.2.3' });
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> =>
      timeoutMs === undefined
        ? connected.request(path, schema, init)
        : connected.request(path, schema, init, timeoutMs),
  };
}

describe('protocol daemon health', () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop(true);
  });

  it('should ask the daemon about itself over the public health route', async () => {
    // Arrange
    const paths: string[] = [];
    const { server, url } = serve(request => {
      paths.push(new URL(request.url).pathname);
      return Response.json(body);
    });
    servers.push(server);
    const subject = new ProtocolDaemonHealth(await client(url));

    // Act
    const actual = await subject.probe();

    // Assert
    should(paths).deepEqual([HEALTH_PATH]);
    should(actual?.pid).equal(4242);
    should(actual?.version).equal('1.2.3');
  });

  it('should parse the answer against the protocol schema rather than trusting it', async () => {
    // Arrange — an error envelope must be a miss, not an object that breaks three frames later.
    const { server, url } = serve(() => Response.json({ error: 'unauthorized' }));
    servers.push(server);
    const subject = new ProtocolDaemonHealth(await client(url));

    // Act
    const actual = await subject.probe();

    // Assert
    should(actual).be.undefined();
  });

  it('should treat an HTTP failure as "did not answer"', async () => {
    // Arrange
    const { server, url } = serve(() => Response.json({ error: 'boom' }, { status: 500 }));
    servers.push(server);
    const subject = new ProtocolDaemonHealth(await client(url));

    // Act
    const actual = await subject.probe();

    // Assert
    should(actual).be.undefined();
  });

  it('should treat an unreachable daemon as "did not answer" rather than throwing', async () => {
    // Arrange — bind an ephemeral port, learn it, then release it so nothing is listening.
    const { server, url } = serve(() => Response.json(body));
    await server.stop(true);
    const subject = new ProtocolDaemonHealth(await client(url));

    // Act
    const actual = await subject.probe();

    // Assert — every caller treats an unreachable daemon as a fact to report.
    should(actual).be.undefined();
  });

  it('should apply the timeout it was configured with', async () => {
    // Arrange
    const seen: Array<number | undefined> = [];
    const recording: HealthApiClient = {
      request: <T>(_path: string, schema: z.ZodType<T>, _init?: RequestInit, timeoutMs?: number): Promise<T> => {
        seen.push(timeoutMs);
        return Promise.resolve(schema.parse(body));
      },
    };

    // Act
    await new ProtocolDaemonHealth(recording).probe();
    await new ProtocolDaemonHealth(recording, 500).probe();

    // Assert — a probe must not inherit the client's long default; a dead daemon has to answer fast.
    should(seen).deepEqual([2_000, 500]);
  });

  it('should accept exactly the shape the protocol schema accepts', () => {
    // Act + Assert — the fixture is real, so no test here asserts against an invented daemon reply.
    should(() => HealthViewSchema.parse(body)).not.throw();
  });
});
