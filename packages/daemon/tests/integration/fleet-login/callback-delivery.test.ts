/**
 * Delivering a Codex callback address, against a real listener on this machine.
 *
 * The listener stands in for Codex's own `codex login` server and answers the way codex-cli 0.145.0 was
 * measured to: a redirect for a good callback, `400 State mismatch` for a stale one, `404` elsewhere.
 */
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { deliverCodexCallback } from '../../../src/adapters/fleet-login/callback-delivery.ts';

const servers: { stop(force?: boolean): unknown }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A loopback listener that answers every request with `answer`, recording what it was asked. */
function listener(answer: (url: URL) => Response): { readonly port: number; readonly asked: URL[] } {
  const asked: URL[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const url = new URL(request.url);
      asked.push(url);
      return answer(url);
    },
  });
  servers.push(server);
  return { port: server.port ?? 0, asked };
}

const QUERY = 'code=code-TESTONLY&state=STATE';

describe('deliverCodexCallback', () => {
  it('should GET the callback on loopback, exactly once, without following Codex’s redirect', async () => {
    // Arrange
    const codex = listener(url =>
      url.pathname === '/auth/callback'
        ? new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${url.port}/success` } })
        : new Response('ok'),
    );

    // Act
    const actual = await deliverCodexCallback({ port: codex.port, path: '/auth/callback', query: QUERY });

    // Assert
    should(actual).equal('delivered');
    should(codex.asked.map(url => `${url.hostname}${url.pathname}${url.search}`)).deepEqual([
      `127.0.0.1/auth/callback?${QUERY}`,
    ]);
  });

  it('should count Codex’s own error page as delivered, because the exit says how it went', async () => {
    const codex = listener(() => new Response('<title>Codex Sign-in Error</title>', { status: 200 }));

    should(await deliverCodexCallback({ port: codex.port, path: '/auth/callback', query: QUERY })).equal('delivered');
  });

  it('should report a stale state or an unknown path as not waited for', async () => {
    const stale = listener(() => new Response('State mismatch', { status: 400 }));
    const elsewhere = listener(() => new Response('', { status: 404 }));

    should(await deliverCodexCallback({ port: stale.port, path: '/auth/callback', query: QUERY })).equal('refused');
    should(await deliverCodexCallback({ port: elsewhere.port, path: '/auth/callback', query: QUERY })).equal('refused');
  });

  it('should report nobody listening as unreachable', async () => {
    // Arrange — a port that was just released, so nothing is on it.
    const gone = listener(() => new Response('ok'));
    servers.pop()?.stop(true);

    // Act
    const actual = await deliverCodexCallback({ port: gone.port, path: '/auth/callback', query: QUERY });

    // Assert
    should(actual).equal('unreachable');
  });
});
