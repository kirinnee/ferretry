import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { BunApiServer, toApiRequest } from '../../../src/adapters/api/index.ts';
import {
  ApiDispatcher,
  ApiRouter,
  jsonResponse,
  textResponse,
  type ApiRoute,
  type ApiServerHandle,
} from '../../../src/lib/api/index.ts';

/**
 * These tests bind a REAL socket, so every one of them asks for port 0 on 127.0.0.1 and stops the
 * server in teardown. A fixed port would collide with whatever the host already runs and fail for a
 * reason that has nothing to do with the code under test.
 */
const BIND = { host: '127.0.0.1', port: 0 } as const;

const running: ApiServerHandle[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

async function serve(...routes: readonly ApiRoute[]): Promise<ApiServerHandle> {
  const dispatcher = new ApiDispatcher(new ApiRouter(routes), { admin: 'admin-secret' });
  const handle = await new BunApiServer().listen(dispatcher, BIND);
  running.push(handle);
  return handle;
}

/** Echoes the request as the domain saw it, so the assertions are about the translation. */
const mirror: ApiRoute = {
  method: 'GET',
  path: '/mirror/:id',
  scope: 'public',
  handle: async context =>
    jsonResponse({
      method: context.request.method,
      path: context.request.path,
      id: context.params.get('id'),
      loopback: context.request.loopback,
      client: context.request.headers.get('x-ferretry-client') ?? null,
      after: context.request.query.get('after') ?? null,
    }),
};

describe('BunApiServer', () => {
  it('should bind an ephemeral port and report the address it actually got', async () => {
    // Arrange / Act
    const handle = await serve(mirror);

    // Assert
    should(handle.port).be.above(0);
    should(handle.url).equal(`http://127.0.0.1:${handle.port}`);
  });

  it('should serve a route over real HTTP', async () => {
    // Arrange
    const handle = await serve(mirror);

    // Act
    const response = await fetch(`${handle.url}/mirror/s-1?after=7`, { headers: { 'X-Ferretry-Client': 'cli' } });
    const body = (await response.json()) as Record<string, unknown>;

    // Assert
    should(response.status).equal(200);
    should(body.method).equal('GET');
    should(body.path).equal('/mirror/s-1');
    should(body.id).equal('s-1');
    should(body.after).deepEqual(['7']);
  });

  it('should lowercase header names so the domain reads them consistently', async () => {
    // Arrange
    const handle = await serve(mirror);

    // Act
    const response = await fetch(`${handle.url}/mirror/x`, { headers: { 'X-FERRETRY-CLIENT': 'cli' } });

    // Assert
    should(((await response.json()) as Record<string, unknown>).client).equal('cli');
  });

  it('should recognise a request from the loopback interface', async () => {
    // Arrange
    const handle = await serve(mirror);

    // Act
    const response = await fetch(`${handle.url}/mirror/x`);

    // Assert
    should(((await response.json()) as Record<string, unknown>).loopback).be.true();
  });

  it('should leave a percent-encoded path segment encoded', async () => {
    // Decoding in the transport is what lets an encoded traversal mean one thing to the
    // authorization check and another to the handler.
    // Arrange
    const handle = await serve(mirror);

    // Act
    const response = await fetch(`${handle.url}/mirror/a%2Fb%20c`);

    // Assert
    should(((await response.json()) as Record<string, unknown>).id).equal('a%2Fb%20c');
  });

  it('should carry the status and headers the domain chose', async () => {
    // Arrange
    const handle = await serve({
      method: 'GET',
      path: '/teapot',
      scope: 'public',
      noStore: true,
      handle: async () => textResponse('short and stout', 418, 'text/plain; charset=utf-8'),
    });

    // Act
    const response = await fetch(`${handle.url}/teapot`);

    // Assert
    should(response.status).equal(418);
    should(response.headers.get('cache-control')).equal('no-store');
    should(await response.text()).equal('short and stout');
  });

  it('should deliver a request body to the handler', async () => {
    // Arrange
    const handle = await serve({
      method: 'POST',
      path: '/echo',
      scope: 'public',
      handle: async context => jsonResponse({ received: await context.request.text() }),
    });

    // Act
    const response = await fetch(`${handle.url}/echo`, { method: 'POST', body: 'hello daemon' });

    // Assert
    should(((await response.json()) as Record<string, unknown>).received).equal('hello daemon');
  });

  it('should enforce authorization over the wire', async () => {
    // Arrange
    const handle = await serve({
      method: 'GET',
      path: '/v1/private',
      scope: 'admin',
      handle: async () => jsonResponse({ ok: true }),
    });

    // Act
    const anonymous = await fetch(`${handle.url}/v1/private`);
    const authorized = await fetch(`${handle.url}/v1/private`, {
      headers: { authorization: 'Bearer admin-secret' },
    });

    // Assert
    should(anonymous.status).equal(401);
    should(authorized.status).equal(200);
  });

  it('should release the port when stopped', async () => {
    // Arrange
    const handle = await serve(mirror);
    const url = `${handle.url}/mirror/x`;

    // Act
    await handle.stop();
    running.length = 0;
    const reachable = await fetch(url)
      .then(() => true)
      .catch(() => false);

    // Assert
    should(reachable).be.false();
  });

  it('should bind two servers at once without either choosing the other port', async () => {
    // Arrange / Act
    const first = await serve(mirror);
    const second = await serve(mirror);

    // Assert
    should(first.port).not.equal(second.port);
  });
});

describe('BunApiServer against a substituted host', () => {
  /** A host that reports neither address, which is what Bun's types allow for a unix socket. */
  const silentHost = {
    serve: () => ({ requestIp: () => undefined, stop: () => undefined }),
  };

  it('should fall back to the requested address when the host reports none', async () => {
    // Arrange
    const dispatcher = new ApiDispatcher(new ApiRouter([mirror]), { admin: 'admin-secret' });

    // Act
    const handle = await new BunApiServer(silentHost).listen(dispatcher, { host: '::1', port: 4242 });

    // Assert: an IPv6 host is bracketed so the URL a client is handed is one it can parse.
    should(handle.port).equal(4242);
    should(handle.url).equal('http://[::1]:4242');
  });
});

describe('toApiRequest', () => {
  it('should treat every loopback form as loopback', () => {
    // Arrange
    const source = new Request('http://127.0.0.1/healthz');

    // Act / Assert
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      should(toApiRequest(source, address).loopback).be.true();
  });

  it('should treat a remote or unknown peer as not loopback', () => {
    // An unknown peer must never be trusted with the query-parameter token path.
    // Arrange
    const source = new Request('http://127.0.0.1/healthz');

    // Act / Assert
    should(toApiRequest(source, '10.0.0.4').loopback).be.false();
    should(toApiRequest(source, undefined).loopback).be.false();
  });

  it('should keep repeated query parameters', () => {
    // Arrange
    const source = new Request('http://127.0.0.1/v1/events?sessionId=a&sessionId=b');

    // Act
    const translated = toApiRequest(source, '127.0.0.1');

    // Assert
    should(translated.query.get('sessionId')).deepEqual(['a', 'b']);
  });
});
