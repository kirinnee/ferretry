/**
 * The provisioner's three routes over real HTTP: the shared shapes on the way out and back, a refusal
 * read as the service said it, and a failure that is never a partial success.
 */

import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { HostedTunnelProvisioner } from '../../../src/adapters/tunnel/hosted-tunnel-provisioner.ts';

const servers: Array<{ stop: (closeActive?: boolean) => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly body: unknown;
}

function serving(answer: (path: string) => Response): { readonly origin: string; readonly seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      seen.push({
        method: request.method,
        path,
        contentType: request.headers.get('content-type'),
        body: await request.json(),
      });
      return answer(path);
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${String(server.port)}`, seen };
}

const NONCE = 'A'.repeat(43);
const SIGNED = { daemonId: 'fy_daemon_x', publicKey: 'k', nonce: NONCE, signature: 's' };

describe('the hosted tunnel provisioner', () => {
  it('should post JSON to each route and parse the documented answers', async () => {
    // Arrange
    const service = serving(path => {
      if (path === '/v1/tunnel/challenge') return Response.json({ version: 1, nonce: NONCE, deadlineSeconds: 60 });
      if (path === '/v1/tunnel/provision')
        return Response.json({
          version: 1,
          tunnelUrl: 'https://quiet-otter.tunnels.example',
          connectorToken: 'fake-connector-token',
          renewAfterSeconds: 3_600,
        });
      return Response.json({ version: 1, released: false });
    });
    const subject = new HostedTunnelProvisioner(service.origin);

    // Act
    const challenge = await subject.challenge({ daemonId: 'fy_daemon_x' });
    const provision = await subject.provision({ ...SIGNED, originPort: 41_234 });
    const release = await subject.release(SIGNED);

    // Assert
    should(subject.origin).equal(service.origin);
    should(challenge).deepEqual({ kind: 'ok', value: { version: 1, nonce: NONCE, deadlineSeconds: 60 } });
    should(provision).deepEqual({
      kind: 'ok',
      value: {
        version: 1,
        tunnelUrl: 'https://quiet-otter.tunnels.example',
        connectorToken: 'fake-connector-token',
        renewAfterSeconds: 3_600,
      },
    });
    should(release).deepEqual({ kind: 'ok', value: { version: 1, released: false } });
    should(service.seen.map(seen => `${seen.method} ${seen.path} ${String(seen.contentType)}`)).deepEqual([
      'POST /v1/tunnel/challenge application/json',
      'POST /v1/tunnel/provision application/json',
      'POST /v1/tunnel/release application/json',
    ]);
    should(service.seen[1]?.body).deepEqual({ ...SIGNED, originPort: 41_234 });
  });

  it('should read a refusal as the service said it, and a bare error status as its number', async () => {
    // Arrange
    const service = serving(path =>
      path === '/v1/tunnel/provision'
        ? Response.json({ error: { code: 'tunnel_capacity', message: 'every account is full' } }, { status: 503 })
        : new Response('Bad Gateway', { status: 502 }),
    );
    const subject = new HostedTunnelProvisioner(service.origin);

    // Act
    const refused = await subject.provision({ ...SIGNED, originPort: 1 });
    const bare = await subject.release(SIGNED);

    // Assert
    should(refused).deepEqual({
      kind: 'refused',
      status: 503,
      code: 'tunnel_capacity',
      message: 'every account is full',
    });
    should(bare).deepEqual({
      kind: 'refused',
      status: 502,
      code: undefined,
      message: '/v1/tunnel/release answered 502',
    });
  });

  it('should treat an answer it cannot read, or no answer, as a failure', async () => {
    // Arrange — a provision answer missing its token is not a tunnel this daemon can run.
    const service = serving(() => Response.json({ version: 1, tunnelUrl: 'https://quiet-otter.tunnels.example' }));
    const closed = serving(() => new Response('unused'));
    await servers.splice(-1)[0]?.stop(true);

    // Act
    const unreadable = await new HostedTunnelProvisioner(service.origin).provision({ ...SIGNED, originPort: 1 });
    const unreachable = await new HostedTunnelProvisioner(closed.origin, { timeoutMs: 1_000 }).challenge({
      daemonId: 'fy_daemon_x',
    });

    // Assert
    should(unreadable).deepEqual({
      kind: 'failed',
      reason: 'the hosted tunnel service answered /v1/tunnel/provision with a document this daemon cannot read',
    });
    should(unreachable).deepEqual({ kind: 'failed', reason: 'this daemon could not reach the hosted tunnel service' });
  });
});
