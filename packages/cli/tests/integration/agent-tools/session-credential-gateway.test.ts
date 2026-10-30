import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { SessionCredentialGateway } from '../../../src/adapters/agent-tools/session-credential-gateway';

/** A stand-in daemon that records what each request carried and answers as told. */
function daemon(answer: (request: Request) => Response) {
  const seen: { readonly path: string; readonly headers: Record<string, string> }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      seen.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers.entries()) });
      return answer(request);
    },
  });
  servers.push(server);
  return { seen, base: `http://127.0.0.1:${String(server.port)}` };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const Answer = z.object({ summary: z.string() });

describe('the agent’s way to the daemon', () => {
  it('should carry the session credential and NO bearer token, even when a caller passes one', async () => {
    // Arrange
    const { seen, base } = daemon(() => Response.json({ summary: 'ok' }));
    const gateway = new SessionCredentialGateway(async () => base);

    // Act
    const answer = await gateway.request('/v1/agent/tools', Answer, {
      method: 'POST',
      body: '{}',
      headers: { 'x-fy-session-capability': 'cap-1', authorization: 'Bearer host-admin-token' },
    });

    // Assert
    should(answer).deepEqual({ summary: 'ok' });
    should(seen[0]?.headers).have.property('x-fy-session-capability', 'cap-1');
    should(seen[0]?.headers).not.have.property('authorization');
  });

  it('should say what the daemon refused, in its words, or name the status', async () => {
    const said = daemon(() =>
      Response.json({ error: 'A person has taken over %terminal:dev; wait or ask them.' }, { status: 409 }),
    );
    const bare = daemon(() => new Response('not json', { status: 502 }));
    await should(new SessionCredentialGateway(async () => said.base).request('/x', Answer)).be.rejectedWith(
      'A person has taken over %terminal:dev; wait or ask them.',
    );
    await should(new SessionCredentialGateway(async () => bare.base).request('/x', Answer)).be.rejectedWith(
      'fyd answered HTTP 502',
    );
  });

  it('should refuse to send a session credential to a daemon that is not on this machine', async () => {
    let sent = false;
    const gateway = new SessionCredentialGateway(
      async () => 'https://elsewhere.example:7431',
      async () => {
        sent = true;
        return Response.json({});
      },
    );
    await should(gateway.request('/v1/agent/tools', Answer)).be.rejectedWith(
      /talk only to the daemon on this machine/u,
    );
    should(sent).be.false();
  });
});

describe('the agent’s way to the daemon, through a restart', () => {
  /** A free loopback port: bound once, then released, so nothing listens on it until a test says. */
  async function freePort(): Promise<number> {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
    const port = probe.port;
    await probe.stop(true);
    if (port === undefined) throw new Error('no port');
    return port;
  }

  /** `onWaiting` runs when the gateway says it is waiting for the daemon: the moment a restarted daemon may come up. */
  const restart = (told: { count: number }, onWaiting: () => void = () => undefined) => ({
    patience: {
      expected: () => true,
      waiting: () => {
        told.count += 1;
        onWaiting();
      },
      windowMs: 60_000,
    },
    nowMs: () => Date.now(),
    sleep: (milliseconds: number) => Bun.sleep(milliseconds),
  });

  it('should wait for a daemon that is down and answer once it serves again, saying so once', async () => {
    // Arrange
    const port = await freePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const told = { count: 0 };
    const gateway = new SessionCredentialGateway(
      async () => base,
      fetch,
      restart(told, () => {
        servers.push(
          Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ summary: 'back after the restart' }) }),
        );
      }),
    );

    // Act
    const answer = await gateway.request('/v1/agent/tools', Answer, {
      method: 'POST',
      body: JSON.stringify({ tool: 'terminal.send', name: 'dev', text: 'ls\n' }),
    });

    // Assert
    should(answer).deepEqual({ summary: 'back after the restart' });
    should(told.count).equal(1);
  });

  it('should repeat a read the daemon dropped mid-request, and never a send that may already have typed', async () => {
    // Arrange — the first request of each kind arrives, and the daemon goes down holding it.
    const dropped = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    const arrived: string[] = [];
    const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
      const tool = (JSON.parse(String(init.body)) as { tool: string }).tool;
      arrived.push(tool);
      if (arrived.filter(each => each === tool).length === 1) throw dropped;
      return Response.json({ summary: tool });
    };
    const told = { count: 0 };
    const gateway = new SessionCredentialGateway(async () => 'http://127.0.0.1:9', fetcher, {
      ...restart(told),
      sleep: async () => undefined,
    });

    // Act
    const read = await gateway.request('/v1/agent/tools', Answer, {
      method: 'POST',
      body: JSON.stringify({ tool: 'terminal.read', name: 'dev' }),
    });
    const send = await gateway
      .request('/v1/agent/tools', Answer, {
        method: 'POST',
        body: JSON.stringify({ tool: 'terminal.send', name: 'dev', text: 'rm -rf build\n' }),
      })
      .catch((error: unknown) => error);

    // Assert
    should(read).deepEqual({ summary: 'terminal.read' });
    should(send).equal(dropped);
    should(arrived).deepEqual(['terminal.read', 'terminal.read', 'terminal.send']);
    should(told.count).equal(1);
  });

  it('should repeat a dropped GET and refuse a body that is not a tool call', async () => {
    // Arrange
    const dropped = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    const calls: string[] = [];
    const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
      calls.push(`${init.method ?? 'GET'} ${typeof init.body === 'string' ? init.body : ''}`);
      if (calls.length === 1 || calls.length === 3 || calls.length === 4) throw dropped;
      return Response.json({ summary: 'ok' });
    };
    const told = { count: 0 };
    const gateway = new SessionCredentialGateway(async () => 'http://127.0.0.1:9', fetcher, {
      patience: { expected: () => true, waiting: () => (told.count += 1) },
      nowMs: () => 0,
      sleep: async () => undefined,
    });

    // Act
    const read = await gateway.request('/v1/sessions/x/surfaces/terminals/control', Answer);
    const garbled = await gateway
      .request('/v1/agent/tools', Answer, { method: 'POST', body: 'not json' })
      .catch((error: unknown) => error);
    const streamed = await gateway
      .request('/v1/agent/tools', Answer, { method: 'POST', body: new Blob(['{}']) })
      .catch((error: unknown) => error);

    // Assert
    should(read).deepEqual({ summary: 'ok' });
    should(garbled).equal(dropped);
    should(streamed).equal(dropped);
    should(calls).have.length(4);
  });
});
