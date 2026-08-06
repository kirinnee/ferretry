import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { BunApiServer, BunHttpServe, type HostServeOptions, toApiRequest } from '../../../src/adapters/api/index.ts';
import {
  ApiDispatcher,
  ApiError,
  type ApiRoute,
  ApiRouter,
  type ApiServerHandle,
  ApiSocketDispatcher,
  BodyTooLargeError,
  jsonResponse,
  MAX_REQUEST_BODY_BYTES,
  parseBody,
  SOCKET_MAX_PENDING_FRAMES,
  type SocketDownstream,
  type SocketHandler,
  type SocketRoute,
  textResponse,
} from '../../../src/lib/api/index.ts';

/**
 * These tests bind a REAL socket, so every one of them asks for port 0 on 127.0.0.1 and stops the
 * server in teardown. A fixed port would collide with whatever the host already runs and fail for a
 * reason that has nothing to do with the code under test.
 */
const BIND = { host: '127.0.0.1', port: 0 } as const;

const CREDENTIALS = { admin: 'admin-secret' } as const;
/** The transport translation is the subject here, so no ticket is redeemable. */
const NO_TICKETS = { redeem: () => undefined } as const;

const running: ApiServerHandle[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const handle = running.pop();
    handle?.closeSockets();
    await handle?.stop();
  }
});

function surfaceOf(routes: readonly ApiRoute[], sockets: readonly SocketRoute[] = []) {
  return {
    http: new ApiDispatcher(new ApiRouter(routes), CREDENTIALS),
    sockets: new ApiSocketDispatcher(new ApiRouter(sockets), CREDENTIALS, NO_TICKETS),
    corsOrigins: ['https://ferretry.pages.dev'],
  };
}

async function serve(...routes: readonly ApiRoute[]): Promise<ApiServerHandle> {
  const handle = await new BunApiServer().listen(surfaceOf(routes), BIND);
  running.push(handle);
  return handle;
}

/** Echoes the request as the domain saw it, so the assertions are about the translation. */
const mirror: ApiRoute = {
  method: 'GET',
  path: '/mirror/:id',
  scope: 'public',
  minimum: 'none',
  handle: async context =>
    jsonResponse({
      method: context.request.method,
      path: context.request.path,
      id: context.params.get('id'),
      loopback: context.request.loopback,
      clientAddress: context.request.clientAddress ?? null,
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

  it('should carry the transport-observed peer address for rate limiting', async () => {
    const handle = await serve(mirror);

    const response = await fetch(`${handle.url}/mirror/x`);

    should(((await response.json()) as Record<string, unknown>).clientAddress).equal('127.0.0.1');
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
      minimum: 'none',
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
      minimum: 'none',
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
      minimum: 'operator',
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

  it('should keep same-origin browser mutations working without a CORS allowlist entry', async () => {
    let calls = 0;
    const handle = await serve({
      method: 'POST',
      path: '/same-origin',
      scope: 'public',
      minimum: 'none',
      handle: async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    });

    const response = await fetch(`${handle.url}/same-origin`, {
      method: 'POST',
      headers: { origin: new URL(handle.url).origin },
    });

    should(response.status).equal(200);
    should(response.headers.get('access-control-allow-origin')).be.null();
    should(calls).equal(1);
  });

  it('should admit credentialed PWA preflights and expose daemon response metadata', async () => {
    const handle = await serve({
      method: 'POST',
      path: '/v1/private',
      scope: 'admin',
      minimum: 'operator',
      handle: async () => jsonResponse({ ok: true }),
    });
    const origin = 'https://ferretry.pages.dev';

    const preflight = await fetch(`${handle.url}/v1/private`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, Content-Type, X-Fy-Request-Id, X-Fy-Version',
      },
    });
    const response = await fetch(`${handle.url}/v1/private`, {
      method: 'POST',
      headers: { origin, authorization: 'Bearer admin-secret' },
    });

    should(preflight.status).equal(204);
    should(preflight.headers.get('access-control-allow-origin')).equal(origin);
    should(preflight.headers.get('access-control-allow-credentials')).equal('true');
    should(preflight.headers.get('access-control-allow-methods')).equal('POST');
    should(preflight.headers.get('access-control-allow-headers')).equal(
      'authorization, content-type, x-fy-request-id, x-fy-version',
    );
    should(response.status).equal(200);
    should(response.headers.get('access-control-allow-origin')).equal(origin);
    should(response.headers.get('access-control-allow-credentials')).equal('true');
    should(response.headers.get('access-control-expose-headers')).containEql('x-ferretry-version');
    should(response.headers.get('vary')).equal('Origin');
  });

  it('should refuse unlisted origins and unsupported preflight capabilities before dispatch', async () => {
    let calls = 0;
    const handle = await serve({
      method: 'POST',
      path: '/effect',
      scope: 'public',
      minimum: 'none',
      handle: async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    });

    const unlisted = await fetch(`${handle.url}/effect`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.test' },
    });
    const unsupported = await fetch(`${handle.url}/effect`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://ferretry.pages.dev',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'x-not-allowed',
      },
    });

    should(unlisted.status).equal(403);
    should(unsupported.status).equal(403);
    should(unlisted.headers.get('vary')).equal('Origin');
    should(unsupported.headers.get('vary')).containEql('Access-Control-Request-Headers');
    should(calls).equal(0);
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
    serve: () => ({ requestIp: () => undefined, upgrade: () => true, stop: () => undefined }),
  };

  it('should fall back to the requested address when the host reports none', async () => {
    // Act
    const handle = await new BunApiServer(silentHost).listen(surfaceOf([mirror]), { host: '::1', port: 4242 });

    // Assert: an IPv6 host is bracketed so the URL a client is handed is one it can parse.
    should(handle.port).equal(4242);
    should(handle.url).equal('http://[::1]:4242');
  });

  it('should answer 400 when the runtime refuses to switch the protocol', async () => {
    // A client that advertised `Upgrade: websocket` over a connection the runtime cannot switch must
    // be told so with a status, not left holding one the daemon believes is a socket.
    // Arrange
    let served: ((request: Request) => Promise<Response | undefined>) | undefined;
    const refusingHost = {
      serve: (options: { readonly fetch: (request: Request) => Promise<Response | undefined> }) => {
        served = options.fetch;
        return { requestIp: () => '127.0.0.1', upgrade: () => false, stop: () => undefined };
      },
    };
    await new BunApiServer(refusingHost).listen(surfaceOf([], [recordingSocket()]), BIND);

    // Act
    const response = await served?.(
      new Request('http://127.0.0.1/v1/stream', {
        headers: { upgrade: 'websocket', authorization: `Bearer ${CREDENTIALS.admin}` },
      }),
    );

    // Assert
    should(response?.status).equal(400);
    should(await answered(response)).have.property('code', 'upgrade_failed');
  });
});

/** What a recording socket handler observed, so a case can assert what reached the domain. */
interface Recorded {
  readonly frames: string[];
  opened: number;
  closed: number;
}

function recorded(): Recorded {
  return { frames: [], opened: 0, closed: 0 };
}

/**
 * A socket route the TEST fully controls.
 *
 * `gate` is awaited inside the attachment, which is the only way to drive the handshake window
 * deterministically: frames that arrive while a handler is still being attached have to be held, and
 * racing a real terminal open would make that case flaky rather than proven.
 */
function recordingSocket(
  options: {
    readonly gate?: Promise<void>;
    /** Makes the ATTACHMENT fail — after the switch, when no status can be sent. */
    readonly failAttachment?: boolean;
    /** Makes `accept` refuse — before the switch, when a status still can be. */
    readonly refuse?: unknown;
    readonly record?: Recorded;
  } = {},
): SocketRoute {
  return {
    method: 'GET',
    path: '/v1/stream',
    scope: 'admin',
    minimum: 'operator',
    accept: async () => {
      if (options.refuse !== undefined) throw options.refuse;
      return async (downstream: SocketDownstream): Promise<SocketHandler> => {
        await options.gate;
        if (options.failAttachment === true) throw new Error('the pane went away');
        const record = options.record ?? recorded();
        return {
          open: async () => {
            record.opened += 1;
            downstream.send(new TextEncoder().encode('hello'));
          },
          fromClient: frame => {
            record.frames.push(typeof frame === 'string' ? frame : `binary:${frame.byteLength}`);
          },
          close: () => {
            record.closed += 1;
          },
        };
      };
    },
  };
}

/** The body of a handshake answer. Fails loudly when the protocol switched instead, so a case can
 *  never optional-chain its way into asserting nothing. */
async function answered(response: Response | undefined): Promise<Record<string, unknown>> {
  if (response === undefined) throw new Error('the handshake switched protocols instead of answering');
  return (await response.json()) as Record<string, unknown>;
}

/** Sends one handshake request; `undefined` means the protocol switched and there is no response. */
type Handshake = (path: string, headers?: Readonly<Record<string, string>>) => Promise<Response | undefined>;

/**
 * A host that captures its own `fetch`.
 *
 * Upgrade decisions are asserted as STATUS CODES here, which is the whole point of deciding them
 * before the protocol switches: a real client would only ever see a failed handshake, and could not
 * tell "no such terminal" from "the daemon broke".
 */
async function handshakeHost(
  sockets: readonly SocketRoute[],
  routes: readonly ApiRoute[] = [],
  upgraded = true,
): Promise<Handshake> {
  let served: ((request: Request) => Promise<Response | undefined>) | undefined;
  const host = {
    serve: (options: { readonly fetch: (request: Request) => Promise<Response | undefined> }) => {
      served = options.fetch;
      return { requestIp: () => '127.0.0.1', upgrade: () => upgraded, stop: () => undefined };
    },
  };
  await new BunApiServer(host).listen(surfaceOf(routes, sockets), BIND);
  const fetchRequest = served;
  if (fetchRequest === undefined) throw new Error('the fixture host was never handed a request handler');
  return async (path, headers = { upgrade: 'websocket', authorization: `Bearer ${CREDENTIALS.admin}` }) =>
    await fetchRequest(new Request(`http://127.0.0.1${path}`, { headers }));
}

/** One client socket, with its frames and its close code collected. */
function connect(url: string): {
  readonly frames: string[];
  readonly closes: Array<readonly [number, string]>;
  readonly opened: Promise<void>;
  send(data: string | Uint8Array): void;
  close(): void;
  untilFrames(count: number): Promise<void>;
  untilClosed(): Promise<void>;
} {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const frames: string[] = [];
  const closes: Array<readonly [number, string]> = [];
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`the viewer socket never opened: ${url}`)));
  });
  socket.addEventListener('message', event => {
    frames.push(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
  });
  socket.addEventListener('close', event => closes.push([event.code, event.reason]));
  const settle = async (done: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && !done(); attempt += 1) await Bun.sleep(10);
  };
  return {
    frames,
    closes,
    opened,
    send: data => socket.send(data),
    close: () => socket.close(),
    untilFrames: async count => await settle(() => frames.length >= count),
    untilClosed: async () => await settle(() => closes.length > 0),
  };
}

describe('BunApiServer socket upgrades', () => {
  it('should refuse an unauthenticated upgrade before the protocol switches', async () => {
    // The socket must never be reachable over credentials the request/response surface would refuse:
    // an unauthenticated peer has to be turned away on the handshake, not after it holds a socket.
    // Arrange
    const request = await handshakeHost([recordingSocket()]);

    // Act
    const anonymous = await request('/v1/stream', { upgrade: 'websocket' });

    // Assert
    should(anonymous?.status).equal(401);
    should(await answered(anonymous)).have.property('code', 'unauthorized');
  });

  it('should switch the protocol for an authorized upgrade', async () => {
    // Arrange
    const request = await handshakeHost([recordingSocket()]);

    // Act
    const accepted = await request('/v1/stream');

    // Assert: no response at all is what "the protocol switched" looks like.
    should(accepted).be.undefined();
  });

  it('should report a refusal raised while accepting with the status the subsystem named', async () => {
    // Arrange
    const request = await handshakeHost([
      recordingSocket({ refuse: new ApiError(404, 'terminal not found', 'not_found') }),
    ]);

    // Act
    const missing = await request('/v1/stream');

    // Assert
    should(missing?.status).equal(404);
    should(await answered(missing)).have.property('code', 'not_found');
  });

  it('should report a defect raised while accepting as the daemon‘s fault, not the caller‘s', async () => {
    // Arrange
    const request = await handshakeHost([recordingSocket({ refuse: new Error('the session index is closed') })]);

    // Act
    const broken = await request('/v1/stream');

    // Assert
    should(broken?.status).equal(500);
    should(await answered(broken)).have.property('code', 'internal_error');
  });

  it('should still serve a public route that arrives with a stray upgrade header', async () => {
    // A proxy adds `Upgrade`, or a client copies a header set. Judging such a request against a
    // socket table it has nothing to do with would break liveness scraping for no security gain.
    // Arrange
    const request = await handshakeHost([recordingSocket()], [mirror]);

    // Act
    const served = await request('/mirror/x', { upgrade: 'websocket' });

    // Assert
    should(served?.status).equal(200);
    should((await answered(served)).id).equal('x');
  });
});

describe('BunApiServer over a live socket', () => {
  async function listen(...sockets: readonly SocketRoute[]): Promise<ApiServerHandle> {
    const handle = await new BunApiServer().listen(surfaceOf([], sockets), BIND);
    running.push(handle);
    return handle;
  }

  /** The socket URL, carrying the token the way a browser must: a `WebSocket` cannot set headers. */
  function streamUrl(handle: ApiServerHandle): string {
    return `${handle.url.replace('http://', 'ws://')}/v1/stream?token=${CREDENTIALS.admin}`;
  }

  it('should carry the handler‘s bytes out and the client‘s frames in', async () => {
    // Arrange
    const record = recorded();
    const handle = await listen(recordingSocket({ record }));
    const viewer = connect(streamUrl(handle));

    // Act
    await viewer.opened;
    await viewer.untilFrames(1);
    viewer.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    viewer.send(Uint8Array.of(13, 10));
    for (let attempt = 0; attempt < 200 && record.frames.length < 2; attempt += 1) await Bun.sleep(10);

    // Assert: the loopback query-parameter token authenticated it, and both frame kinds arrived
    // intact and in order.
    should(record.opened).equal(1);
    should(viewer.frames).deepEqual(['hello']);
    should(record.frames).deepEqual([JSON.stringify({ type: 'resize', cols: 100, rows: 30 }), 'binary:2']);
  });

  it('should hold frames that arrive while the handler is still being attached, then replay them', async () => {
    // The socket is live from the instant the protocol switches, but resolving a session and a pane
    // is not instant. Dropping what arrives in that window loses the first keystroke of every stream.
    // Arrange
    const record = recorded();
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const handle = await listen(recordingSocket({ record, gate }));
    const viewer = connect(streamUrl(handle));

    // Act
    await viewer.opened;
    viewer.send('first');
    viewer.send('second');
    await Bun.sleep(50);
    const beforeRelease = [...record.frames];
    release();
    for (let attempt = 0; attempt < 200 && record.frames.length < 2; attempt += 1) await Bun.sleep(10);

    // Assert
    should(beforeRelease).be.empty();
    should(record.frames).deepEqual(['first', 'second']);
  });

  it('should close a socket that floods the handshake queue', async () => {
    // Bounded, or a client that floods during the handshake grows the daemon's heap without limit.
    // Arrange
    const handle = await listen(recordingSocket({ gate: new Promise<void>(() => {}) }));
    const viewer = connect(streamUrl(handle));

    // Act
    await viewer.opened;
    for (let frame = 0; frame <= SOCKET_MAX_PENDING_FRAMES; frame += 1) viewer.send(`frame-${frame}`);
    await viewer.untilClosed();

    // Assert
    should(viewer.closes).deepEqual([[1009, 'socket handshake queue exceeded']]);
  });

  it('should close a socket whose handler could not be attached', async () => {
    // Arrange
    const handle = await listen(recordingSocket({ failAttachment: true }));
    const viewer = connect(streamUrl(handle));

    // Act
    await viewer.opened;
    await viewer.untilClosed();

    // Assert
    should(viewer.closes).deepEqual([[1011, 'socket handler unavailable']]);
  });

  it('should discard a handler that finishes attaching after the peer has gone', async () => {
    // The handler holds a timer and a viewer slot. Installing one against a peer that already left
    // would leak both, because nothing would ever tell it the stream was over.
    // Arrange
    const record = recorded();
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const handle = await listen(recordingSocket({ record, gate }));
    const viewer = connect(streamUrl(handle));

    // Act
    await viewer.opened;
    viewer.close();
    await viewer.untilClosed();
    await Bun.sleep(50);
    release();
    for (let attempt = 0; attempt < 200 && record.closed === 0; attempt += 1) await Bun.sleep(10);

    // Assert: closed without ever being opened.
    should(record.opened).equal(0);
    should(record.closed).equal(1);
  });

  it('should end every live socket when the daemon shuts down', async () => {
    // Arrange
    const record = recorded();
    const handle = await listen(recordingSocket({ record }));
    const viewer = connect(streamUrl(handle));
    await viewer.opened;
    await viewer.untilFrames(1);

    // Act
    handle.closeSockets();
    await viewer.untilClosed();

    // Assert: the reason carries the intent, because Bun rewrites the `1001` this really is to 1000.
    should(viewer.closes).deepEqual([[1000, 'daemon shutting down']]);
    should(record.closed).equal(1);
  });

  it('should still return from stop after it has closed its own sockets', async () => {
    // Bun's forceful stop never resolves once the server closed a WebSocket itself, so a shutdown
    // that runs `closeSockets` and then `stop` would hang the daemon forever.
    // Arrange
    const handle = await new BunApiServer().listen(surfaceOf([], [recordingSocket()]), BIND);
    const viewer = connect(`${handle.url.replace('http://', 'ws://')}/v1/stream?token=${CREDENTIALS.admin}`);
    await viewer.opened;
    await viewer.untilFrames(1);

    // Act
    handle.closeSockets();
    const stopped = await Promise.race([handle.stop().then(() => 'stopped'), Bun.sleep(2_000).then(() => 'hung')]);

    // Assert
    should(stopped).equal('stopped');
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

describe('BunApiServer request-body bounds', () => {
  const AnySchema = z.object({}).loose();

  /** A route bounded near its own contract rather than at the transport ceiling. */
  const bounded: ApiRoute = {
    method: 'POST',
    path: '/bounded',
    scope: 'public',
    minimum: 'none',
    handle: async context => jsonResponse(await parseBody(context.request, AnySchema, { maxBytes: 64 })),
  };

  it('should hand the runtime the daemon‘s own ceiling', async () => {
    // Bun's 128 MiB default is the only bound a `serve` without this option has, and it is four times
    // the largest request this API has a use for.
    // Arrange
    let served: HostServeOptions | undefined;
    const host = {
      serve: (options: HostServeOptions) => {
        served = options;
        return { requestIp: () => undefined, upgrade: () => true, stop: () => undefined };
      },
    };

    // Act
    await new BunApiServer(host).listen(surfaceOf([mirror]), BIND);

    // Assert
    should(served?.maxBodyBytes).equal(MAX_REQUEST_BODY_BYTES);
    should(MAX_REQUEST_BODY_BYTES).be.below(128 * 1024 * 1024);
  });

  it('should refuse a body over the runtime ceiling before any route runs', async () => {
    // Proven against an INJECTED ceiling: sending the shipped one would measure the machine rather
    // than the bound.
    // Arrange
    let calls = 0;
    const handle = await new BunApiServer(new BunHttpServe(), 64).listen(
      surfaceOf([
        {
          method: 'POST',
          path: '/echo',
          scope: 'public',
          minimum: 'none',
          handle: async context => {
            calls += 1;
            return jsonResponse({ received: await context.request.text() });
          },
        },
      ]),
      BIND,
    );
    running.push(handle);

    // Act
    const refused = await fetch(`${handle.url}/echo`, { method: 'POST', body: 'a'.repeat(200) });
    const admitted = await fetch(`${handle.url}/echo`, { method: 'POST', body: 'a'.repeat(64) });

    // Assert: the oversized body never reached the route, and a body of exactly the ceiling still did.
    should(refused.status).equal(413);
    should(admitted.status).equal(200);
    should(calls).equal(1);
  });

  it('should answer 413 over real HTTP for a body over a route bound', async () => {
    // Arrange
    const handle = await serve(bounded);

    // Act
    const refused = await fetch(`${handle.url}/bounded`, { method: 'POST', body: `{"a":"${'x'.repeat(200)}"}` });
    const admitted = await fetch(`${handle.url}/bounded`, { method: 'POST', body: '{"a":"x"}' });

    // Assert
    should(refused.status).equal(413);
    should((await refused.json()) as Record<string, unknown>).have.property('code', 'body_too_large');
    should(admitted.status).equal(200);
  });
});

describe('toApiRequest body reads', () => {
  /** A body delivered in installments with NO declared length, the way a chunked upload arrives. */
  function chunked(pieces: readonly string[]): Request {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    });
    return new Request('http://127.0.0.1/v1/thing', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  }

  it('should not touch the body until a route asks for it', async () => {
    // A body-less route and a protocol switch must each pay nothing for a body they never read.
    // Arrange
    const source = new Request('http://127.0.0.1/v1/thing', { method: 'POST', body: 'hello daemon' });

    // Act
    const translated = toApiRequest(source, '127.0.0.1');

    // Assert
    should(source.bodyUsed).be.false();
    should(await translated.text(64)).equal('hello daemon');
    should(source.bodyUsed).be.true();
  });

  it('should read a body of exactly the bound', async () => {
    // Arrange
    const source = new Request('http://127.0.0.1/v1/thing', { method: 'POST', body: 'a'.repeat(64) });

    // Act / Assert
    should((await toApiRequest(source, undefined).text(64)).length).equal(64);
  });

  it('should refuse the length a real client declares, before reading a byte', async () => {
    // A client that buffers its body sends `content-length`, which is the path an oversized upload
    // actually takes — and the only one that can be refused for free.
    // Arrange
    const source = new Request('http://127.0.0.1/v1/thing', {
      method: 'POST',
      body: 'a'.repeat(65),
      headers: { 'content-length': '65' },
    });

    // Act
    const error = await toApiRequest(source, undefined)
      .text(64)
      .catch((reason: unknown) => reason);

    // Assert
    should(error).be.instanceof(BodyTooLargeError);
    should((error as Error).message).equal('the request body is over the 64-byte limit');
  });

  it('should bound a chunked body while consuming it', async () => {
    // Arrange
    const source = chunked(['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]);

    // Act
    const error = await toApiRequest(source, undefined)
      .text(64)
      .catch((reason: unknown) => reason);

    // Assert: no declared length to check, so the running total is the only bound there is.
    should(source.headers.get('content-length')).be.null();
    should(error).be.instanceof(BodyTooLargeError);
  });

  it('should cancel the remainder of a body it refused instead of leaving it in flight', async () => {
    // Releasing the lock is not enough. A refused upload whose stream is merely unlocked is an upload
    // the peer is still sending, into a daemon that has already answered 413 and will never read
    // another byte of it — the sender has to be told to stop.
    // Arrange
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      // A sender that keeps going: one piece per read, forever, until it is cancelled.
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('a'.repeat(32)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const source = new Request('http://127.0.0.1/v1/thing', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    // Act
    const error = await toApiRequest(source, undefined)
      .text(64)
      .catch((reason: unknown) => reason);
    // A cancelled body reports itself finished; an unlocked one would hand over the next piece.
    const remainder = await source.body?.getReader().read();

    // Assert: the transport's own cancel ran, AND the refusal the client is told about survived it.
    // Cancelling from inside the read — while the reader still holds the body — fails quietly instead,
    // which looks identical from the status code alone.
    should(cancelled).be.true();
    should(remainder?.done).be.true();
    should(error).be.instanceof(BodyTooLargeError);
    should((error as BodyTooLargeError).limitBytes).equal(64);
    should((error as Error).message).equal('the request body is over the 64-byte limit');
  });

  it('should cancel a declared oversize it refused before reading, keeping the refusal', async () => {
    // The pre-check path never enters the reader at all, so the cancellation it owes the sender cannot
    // come from the reader's cleanup — and a cancel that rejects must not become the client's answer.
    // Arrange
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('a'.repeat(32)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const source = new Request('http://127.0.0.1/v1/thing', {
      method: 'POST',
      body: stream,
      headers: { 'content-length': '96' },
      duplex: 'half',
    } as RequestInit);
    // The runtime primes the stream on its own; anything past this point would be the daemon reading.
    await Bun.sleep(5);
    const primed = pulls;

    // Act
    const error = await toApiRequest(source, undefined)
      .text(64)
      .catch((reason: unknown) => reason);

    // Assert
    should(cancelled).be.true();
    should(pulls).equal(primed);
    should(error).be.instanceof(BodyTooLargeError);
    should((error as Error).message).equal('the request body is over the 64-byte limit');
  });

  it('should not cancel a body it read to the end', async () => {
    // Cancellation belongs to the refusal path alone: a body that arrived complete has nothing left to
    // stop, and cancelling it anyway would report a fault on a request that succeeded.
    // Arrange
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"hello"}'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const source = new Request('http://127.0.0.1/v1/thing', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    // Act
    const text = await toApiRequest(source, undefined).text(64);

    // Assert
    should(text).equal('{"text":"hello"}');
    should(cancelled).be.false();
  });

  it('should read a chunked body that fits', async () => {
    // Arrange
    const source = chunked(['{"text":', '"hello"}']);

    // Act / Assert
    should(await toApiRequest(source, undefined).text(64)).equal('{"text":"hello"}');
  });

  it('should read a request with no body at all as the empty string', async () => {
    // Arrange
    const source = new Request('http://127.0.0.1/healthz');

    // Act / Assert
    should(await toApiRequest(source, undefined).text(64)).equal('');
    should(await toApiRequest(source, undefined).text()).equal('');
  });

  it('should let a stream that fails through as a read failure, not an oversize', async () => {
    // Arrange
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        controller.error(new Error('the connection dropped'));
      },
    });
    const source = new Request('http://127.0.0.1/v1/thing', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    // Act
    const error = await toApiRequest(source, undefined)
      .text(64)
      .catch((reason: unknown) => reason);

    // Assert: the reason the read stopped survives the cleanup. Cancelling a failed stream rejects
    // with that same failure, so a cleanup that reported its own outcome would replace the caller's
    // error with a duplicate — or, worse, an unhandled rejection.
    should(error).be.instanceof(Error);
    should(error).not.be.instanceof(BodyTooLargeError);
    should((error as Error).message).containEql('the connection dropped');
  });

  it('should leave the body untouched when the protocol switches instead', async () => {
    // Arrange
    let served: ((request: Request) => Promise<Response | undefined>) | undefined;
    const host = {
      serve: (options: { readonly fetch: (request: Request) => Promise<Response | undefined> }) => {
        served = options.fetch;
        return { requestIp: () => '127.0.0.1', upgrade: () => true, stop: () => undefined };
      },
    };
    // The verb is `POST` only because a `GET` cannot be constructed with a body at all; the switch is
    // what is under test.
    await new BunApiServer(host).listen(surfaceOf([], [{ ...recordingSocket(), method: 'POST' }]), BIND);
    const upgrading = new Request('http://127.0.0.1/v1/stream', {
      method: 'POST',
      body: 'a body an upgrade has no use for',
      headers: { upgrade: 'websocket', authorization: `Bearer ${CREDENTIALS.admin}` },
    });

    // Act
    const response = await served?.(upgrading);

    // Assert: switched, and the body was never read on the way there.
    should(response).be.undefined();
    should(upgrading.bodyUsed).be.false();
  });
});
