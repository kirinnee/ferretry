import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { type FeedSocket, HttpTransport } from '../../../src/adapters/daemon/http-transport.ts';
import { buildRequest } from '../../../src/lib/request.ts';
import { DAEMON_STARTING_CODE } from '../../../src/lib/restart.ts';
import { standInDaemon } from '../support/stand-in-daemon.ts';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const transport = (url: string, extra: Partial<ConstructorParameters<typeof HttpTransport>[0]> = {}) =>
  new HttpTransport({ baseUrl: async () => url, authorization: async () => 'Bearer test-credential', ...extra });

describe('sending a request to the daemon over HTTP', () => {
  it('should send the method, path, JSON body and fixed headers, with only the credential function setting authorization', async () => {
    const daemon = standInDaemon(() => Response.json({ ok: true }));
    const http = transport(daemon.url, { headers: { 'x-client': 'fy', Authorization: 'Bearer smuggled' } });

    const reply = await http.send({ method: 'POST', path: '/v1/x?y=1', body: { a: 1 } }, { repeatable: false });

    should(reply).eql({ status: 200, body: { ok: true } });
    should(daemon.seen[0]).match({ method: 'POST', path: '/v1/x?y=1', body: '{"a":1}' });
    should(daemon.seen[0]?.headers).match({
      authorization: 'Bearer test-credential',
      'x-client': 'fy',
      'content-type': 'application/json',
    });
  });

  it('should put a half’s allow-listed headers on the wire, and never let them set the credential', async () => {
    const daemon = standInDaemon(() => Response.json({ ok: true }));
    const http = transport(daemon.url);

    await http.send(
      {
        method: 'POST',
        path: '/v1/ferrets',
        body: {},
        headers: { 'x-fy-request-id': 'req-1', authorization: 'Bearer smuggled' },
      },
      { repeatable: false },
    );

    should(daemon.seen[0]?.headers).match({ authorization: 'Bearer test-credential', 'x-fy-request-id': 'req-1' });
  });

  it('should put no request id on the wire when a half hands over one that is not a non-empty string', async () => {
    const daemon = standInDaemon(() => Response.json({ ok: true }));
    const http = transport(daemon.url);

    for (const bad of [123, true, ['req-1'], { id: 'req-1' }, '']) {
      await http.send(buildRequest('POST /v1/ferrets', { headers: { 'x-fy-request-id': bad as never } }), {
        repeatable: false,
      });
    }

    should(daemon.seen).have.length(5);
    for (const request of daemon.seen) should(request.headers).not.have.property('x-fy-request-id');
  });

  it('should send no credential when there is none, and no body or content type for a bare GET', async () => {
    const daemon = standInDaemon(() => new Response(''));
    const http = transport(daemon.url, { authorization: async () => undefined });

    const reply = await http.send({ method: 'GET', path: '/v1/y' }, { repeatable: true });

    should(reply).eql({ status: 200, body: undefined });
    should(daemon.seen[0]?.headers).not.have.property('authorization');
    should(daemon.seen[0]?.headers).not.have.property('content-type');
  });

  it('should hand a status and a body that is not JSON back as they came, never throwing for an HTTP status', async () => {
    const daemon = standInDaemon(() => new Response('plain words', { status: 418 }));

    should(await transport(daemon.url).send({ method: 'GET', path: '/' }, { repeatable: true })).eql({
      status: 418,
      body: 'plain words',
    });
  });

  it('should stop at an address the guard refuses, before the credential is read or anything is sent', async () => {
    const daemon = standInDaemon(() => Response.json({}));
    let credentialRead = false;
    const http = transport(daemon.url, {
      beforeSend: async () => {
        throw new Error('foreign listener');
      },
      authorization: async () => {
        credentialRead = true;
        return 'Bearer x';
      },
    });

    await should(http.send({ method: 'GET', path: '/' }, { repeatable: true })).be.rejectedWith('foreign listener');

    should(credentialRead).be.false();
    should(daemon.seen).be.empty();
  });

  it('should throw what the network threw when the daemon is not there and nobody waits for it', async () => {
    const daemon = standInDaemon(() => Response.json({}));
    const url = daemon.url;
    daemon.server.stop(true);

    await should(transport(url).send({ method: 'GET', path: '/' }, { repeatable: true })).be.rejected();
  });

  it('should honour the caller’s own abort as well as its timeout', async () => {
    const daemon = standInDaemon(async () => await new Promise<Response>(() => undefined));
    const abort = new AbortController();
    const sending = transport(daemon.url).send(
      { method: 'GET', path: '/' },
      { repeatable: false, signal: abort.signal },
    );
    abort.abort(new Error('left'));

    await should(sending).be.rejected();
  });
});

describe('waiting out a daemon restart', () => {
  const patience = (windowMs = 60_000) => {
    let told = 0;
    return {
      told: () => told,
      restart: {
        patience: {
          expected: async () => true,
          waiting: () => {
            told += 1;
          },
          windowMs,
        },
        nowMs: (() => {
          let now = 0;
          return () => {
            now += 1_000;
            return now;
          };
        })(),
        sleep: async () => undefined,
      },
    };
  };

  it('should resend a repeatable request until the daemon has mounted its routes', async () => {
    let calls = 0;
    const daemon = standInDaemon(() => {
      calls += 1;
      return calls < 3
        ? Response.json({ code: DAEMON_STARTING_CODE, error: 'booting' }, { status: 503 })
        : Response.json({ ready: true });
    });
    const rechecked: string[] = [];
    const { restart, told } = patience();

    const reply = await transport(daemon.url, { restart }).send(
      { method: 'GET', path: '/v1/z' },
      {
        repeatable: true,
        recheck: async () => void rechecked.push('guard'),
      },
    );

    should(reply).eql({ status: 200, body: { ready: true } });
    should(calls).equal(3);
    should(told()).equal(1);
    should(rechecked).eql(['guard', 'guard']);
  });

  it('should end the wait when the guard refuses the daemon that came back', async () => {
    const daemon = standInDaemon(() =>
      Response.json({ code: DAEMON_STARTING_CODE, error: 'booting' }, { status: 503 }),
    );
    const { restart } = patience();

    const sending = transport(daemon.url, { restart }).send(
      { method: 'GET', path: '/v1/z' },
      {
        repeatable: true,
        recheck: async () => {
          throw new Error('another build now');
        },
      },
    );

    await should(sending).be.rejectedWith('another build now');
  });
});

/** A socket the test drives by hand: no connection is made. */
class HandSocket implements FeedSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly reason?: string; readonly code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  readonly closed: [number | undefined, string | undefined][] = [];
  send(frame: string | Uint8Array): void {
    this.sent.push(frame);
  }
  close(code?: number, reason?: string): void {
    this.closed.push([code, reason]);
  }
}
const settle = async () => await Bun.sleep(20);

describe('the event feed', () => {
  it('should hand each named frame to the listener, dropping binary, unparsable, nameless and over-long ones', async () => {
    const socket = new HandSocket();
    const opened: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const http = transport('http://127.0.0.1:7431', {
      headers: { 'x-client': 'fy', authorization: 'smuggled' },
      feedSocket: (url, headers) => {
        opened.push({ url, headers });
        return socket;
      },
    });
    const events: unknown[] = [];

    const cancel = http.events(
      event => events.push(event),
      () => undefined,
    );
    await settle();
    for (const data of [
      JSON.stringify({ name: 'asks.answered', payload: { id: 1 } }),
      new Uint8Array([1]),
      '{nope',
      '7',
      JSON.stringify({ payload: 1 }),
      JSON.stringify({ name: 'x'.repeat(129) }),
    ])
      socket.onmessage?.({ data });
    cancel();

    should(events).eql([{ name: 'asks.answered', payload: { id: 1 } }]);
    should(opened).eql([
      { url: 'ws://127.0.0.1:7431/v1/bus', headers: { 'x-client': 'fy', authorization: 'Bearer test-credential' } },
    ]);
    should(socket.closed).eql([[1000, 'cancelled']]);
  });

  it('should say once why the feed ended, in the daemon’s words or ours, and nothing after a cancel', async () => {
    const reasons: string[] = [];
    const sockets: HandSocket[] = [];
    const http = transport('https://daemon.test', {
      feedSocket: () => {
        const socket = new HandSocket();
        sockets.push(socket);
        return socket;
      },
    });

    http.events(
      () => undefined,
      reason => reasons.push(reason),
    );
    http.events(
      () => undefined,
      reason => reasons.push(reason),
    );
    http.events(
      () => undefined,
      reason => reasons.push(reason),
    );
    const cancelled = http.events(
      () => undefined,
      reason => reasons.push(reason),
    );
    await settle();
    sockets[0]?.onclose?.({ reason: 'going away' });
    sockets[0]?.onclose?.({ reason: 'again' });
    sockets[1]?.onclose?.({});
    sockets[2]?.onerror?.();
    cancelled();
    sockets[3]?.onclose?.({ reason: 'late' });

    should(reasons).eql(['going away', 'the daemon closed the event feed', 'the event feed failed']);
  });

  it('should end unopened when the guard refuses the address, or the feed is cancelled before it opens', async () => {
    const reasons: string[] = [];
    let opened = 0;
    const refused = transport('http://127.0.0.1:7431', {
      beforeSend: async () => {
        throw new Error('foreign listener');
      },
      feedSocket: () => {
        opened += 1;
        return new HandSocket();
      },
    });
    const early = transport('http://127.0.0.1:7431', {
      feedSocket: () => {
        opened += 1;
        return new HandSocket();
      },
    });

    refused.events(
      () => undefined,
      reason => reasons.push(reason),
    );
    early.events(
      () => undefined,
      reason => reasons.push(reason),
    )();
    await settle();

    should(reasons).eql(['foreign listener']);
    should(opened).equal(0);
  });
});

describe('a daemon stream', () => {
  it('should open on the daemon address with the credential in a header, drop frames sent before it was accepted, and close on request', async () => {
    const socket = new HandSocket();
    const urls: string[] = [];
    const http = transport('http://127.0.0.1:7431', {
      feedSocket: url => {
        urls.push(url);
        return socket;
      },
    });
    const heard: (string | Uint8Array)[] = [];
    let open = 0;
    const closes: [string, number | undefined][] = [];

    const stream = http.socket('/v1/stream?x=1', {
      onOpen: () => {
        open += 1;
      },
      onFrame: frame => heard.push(frame),
      onClose: (reason, code) => closes.push([reason, code]),
    });
    await settle();
    stream.send('too early');
    socket.onopen?.();
    stream.send('hello');
    socket.onmessage?.({ data: 'text' });
    socket.onmessage?.({ data: new Uint8Array([2]) });
    socket.onmessage?.({ data: new Uint8Array([3]).buffer });
    socket.onmessage?.({ data: { not: 'a frame' } });
    stream.close();
    stream.close();
    socket.onmessage?.({ data: 'after close' });
    socket.onclose?.({ code: 1006 });

    should(urls).eql(['ws://127.0.0.1:7431/v1/stream?x=1']);
    should(socket.sent).eql(['hello']);
    should(open).equal(1);
    should(heard).eql(['text', new Uint8Array([2]), new Uint8Array([3])]);
    should(socket.closed).eql([[1000, 'event stream cancelled']]);
    should(closes).eql([]);
  });

  it('should report a close it did not ask for with its code, and a failure once', async () => {
    const sockets: HandSocket[] = [];
    const http = transport('http://127.0.0.1:7431', {
      feedSocket: () => {
        const socket = new HandSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const closes: [string, number | undefined][] = [];
    const listeners = {
      onFrame: () => undefined,
      onClose: (reason: string, code?: number) => closes.push([reason, code]),
    };

    http.socket('/a', listeners);
    http.socket('/b', listeners);
    http.socket('/c', listeners);
    await settle();
    sockets[0]?.onclose?.({ code: 4001, reason: 'denied' });
    sockets[1]?.onclose?.({ code: 1006 });
    sockets[2]?.onerror?.();
    sockets[2]?.onerror?.();
    sockets[2]?.onopen?.();

    should(closes).eql([
      ['WebSocket stream closed unexpectedly: denied (code 4001)', 4001],
      ['WebSocket stream closed unexpectedly: code 1006', 1006],
      ['WebSocket stream failed', undefined],
    ]);
  });

  it('should refuse a path that names another host before the credential is read, and honour the guard', async () => {
    let credentialRead = false;
    const closes: string[] = [];
    const base = {
      authorization: async () => {
        credentialRead = true;
        return 'Bearer x';
      },
      feedSocket: () => new HandSocket(),
    };
    const foreign = transport('http://127.0.0.1:7431', base);
    const guarded = transport('http://127.0.0.1:7431', {
      ...base,
      beforeSend: async () => {
        throw new Error('foreign listener');
      },
    });
    const early = transport('http://127.0.0.1:7431', { feedSocket: () => new HandSocket() });

    foreign.socket('http://evil.test/steal', { onFrame: () => undefined, onClose: reason => closes.push(reason) });
    guarded.socket('/ok', { onFrame: () => undefined, onClose: reason => closes.push(reason) });
    early.socket('/ok', { onFrame: () => undefined, onClose: reason => closes.push(reason) }).close();
    await settle();

    should(closes).eql(['a stream path must stay on the daemon address', 'foreign listener']);
    should(credentialRead).be.false();
  });
});

describe('the default event feed socket', () => {
  it('should reach a real WebSocket on a loopback server the test owns, carrying the credential as a header', async () => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, bun) => {
        seen.push(request.headers.get('authorization'));
        return bun.upgrade(request) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open: socket => {
          socket.send(JSON.stringify({ name: 'hello', payload: 1 }));
        },
        message: () => undefined,
      },
    });
    closers.push(() => server.stop(true));
    const events: unknown[] = [];
    const http = transport(`http://127.0.0.1:${String(server.port)}`);

    const cancel = http.events(
      event => events.push(event),
      () => undefined,
    );
    for (let waited = 0; waited < 100 && events.length === 0; waited += 1) await Bun.sleep(20);
    cancel();

    should(events).eql([{ name: 'hello', payload: 1 }]);
    should(seen).eql(['Bearer test-credential']);
  });
});
