/**
 * The one read that decides whether this boot asks for a tunnel, against a real loopback server: the
 * path, `no-store`, and every way a service can fail to say yes.
 */

import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { HostedTunnelService } from '../../../src/adapters/tunnel/hosted-tunnel-service.ts';

const servers: Array<{ stop: (closeActive?: boolean) => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function serving(answer: () => Response): { readonly origin: string; readonly paths: string[] } {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      paths.push(new URL(request.url).pathname);
      return answer();
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${String(server.port)}`, paths };
}

describe('the hosted tunnel service read', () => {
  it('should read available from the protocol’s own path, and keep the origin it asked', async () => {
    // Arrange
    const service = serving(() => Response.json({ version: 1, available: true }));

    // Act
    const availability = await new HostedTunnelService(`${service.origin}/`).read();

    // Assert
    should(availability).deepEqual({ kind: 'available', origin: service.origin });
    should(service.paths).deepEqual(['/v1/tunnel-service']);
  });

  it('should ask with no-store, because available:false is the operator’s switch', async () => {
    // Arrange
    const init: RequestInit[] = [];
    const subject = new HostedTunnelService('https://relay.example', {
      fetcher: async (_input, options) => {
        init.push(options ?? {});
        return Response.json({ version: 1, available: false });
      },
    });

    // Act
    const availability = await subject.read();

    // Assert
    should(availability).deepEqual({
      kind: 'unavailable',
      reason: 'the hosted tunnel service is not set up by its operator',
    });
    should(init[0]?.cache).equal('no-store');
  });

  it('should fold every failure into one unavailable sentence and never throw', async () => {
    // Arrange
    const failing = serving(() => new Response('nope', { status: 503 }));
    const garbled = serving(() => new Response('<html>', { status: 200 }));
    const closed = serving(() => new Response('unused'));
    await servers.splice(-1)[0]?.stop(true);

    // Act
    const answers = await Promise.all([
      new HostedTunnelService(undefined).read(),
      new HostedTunnelService('http://relay.example').read(),
      new HostedTunnelService(failing.origin).read(),
      new HostedTunnelService(garbled.origin).read(),
      new HostedTunnelService(closed.origin, { timeoutMs: 1_000 }).read(),
    ]);

    // Assert
    should(answers.map(answer => (answer.kind === 'unavailable' ? answer.reason : answer.kind))).deepEqual([
      'this build carries no hosted service to ask',
      'the configured hosted service is not an address this daemon may ask',
      'the hosted tunnel service answered 503',
      'the hosted tunnel service answered something that is not a document',
      'this daemon could not reach the hosted tunnel service',
    ]);
  });
});
