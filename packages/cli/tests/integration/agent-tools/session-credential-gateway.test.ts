import { afterEach, describe, it } from 'bun:test';
import { z } from 'zod';
import should from 'should';
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
