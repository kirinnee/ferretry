import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { type FeedSocket, HttpTransport } from '../../src/adapters/daemon/http-transport.ts';
import { isLocalDaemonUrl } from '../../src/lib/address.ts';

// Synthetic fixtures only: a placeholder credential and a WebSocket server on a loopback port the test owns.
const CREDENTIAL = 'Bearer unit-test-only';

interface Seen {
  url: string;
  authorization: string | null;
  readonly closes: { readonly code: number; readonly reason: string }[];
}

const servers: { stop(close?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A local daemon stand-in: records the upgrade request, sends one greeting, answers `bye` with a refusal close. */
function daemon(): { readonly seen: Seen; readonly base: string } {
  const seen: Seen = { url: '', authorization: null, closes: [] };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, upgrader) {
      seen.url = request.url;
      seen.authorization = request.headers.get('authorization');
      return upgrader.upgrade(request) ? undefined : new Response('not a socket', { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send('hello');
      },
      message(ws, message) {
        if (message === 'bye') ws.close(1008, 'invalid input');
        else if (message === 'drop') ws.close(1011);
        else ws.send(`echo:${String(message)}`);
      },
      close(_ws, code, reason) {
        seen.closes.push({ code, reason });
      },
    },
  });
  servers.push(server);
  return { seen, base: `http://127.0.0.1:${String(server.port)}` };
}

const until = async (done: () => boolean): Promise<void> => {
  for (let waited = 0; !done(); waited += 5) {
    if (waited > 3000) throw new Error('timed out waiting');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
};

const transportAt = (base: string, extra: { reads?: { count: number } } = {}): HttpTransport =>
  new HttpTransport({
    baseUrl: async () => base,
    authorization: async () => {
      if (extra.reads !== undefined) extra.reads.count += 1;
      return CREDENTIAL;
    },
    // The shape `world.ts` wires: an address that is not this machine's is refused before the credential is read.
    beforeSend: async address => {
      if (!isLocalDaemonUrl(address)) throw new Error(`refusing to send the daemon admin token to ${address}`);
    },
  });

describe('DaemonTransport.socket', () => {
  it('sends the bearer as a header, never in the URL, and carries the query to the daemon', async () => {
    const { seen, base } = daemon();
    const heard: (string | Uint8Array)[] = [];
    let opened = 0;

    const stream = transportAt(base).socket('/v1/events?after=3&sessionId=a%20b', {
      onOpen: () => {
        opened += 1;
      },
      onFrame: frame => heard.push(frame),
      onClose: () => {},
    });
    await until(() => heard.length > 0);
    stream.close();

    should(seen.authorization).equal(CREDENTIAL);
    should(seen.url.includes('unit-test-only')).equal(false);
    const url = new URL(seen.url);
    should(url.hostname).equal('127.0.0.1');
    should(url.pathname).equal('/v1/events');
    should(url.searchParams.get('after')).equal('3');
    should(url.searchParams.get('sessionId')).equal('a b');
    should(heard).deepEqual(['hello']);
    should(opened).equal(1);
  });

  it('delivers a frame sent after the daemon accepted the stream, and drops one sent before', async () => {
    const { base } = daemon();
    const heard: (string | Uint8Array)[] = [];

    const stream = transportAt(base).socket('/v1/events', { onFrame: frame => heard.push(frame), onClose: () => {} });
    stream.send('too early');
    await until(() => heard.includes('hello'));
    stream.send('ping');
    await until(() => heard.includes('echo:ping'));
    stream.close();

    should(heard).deepEqual(['hello', 'echo:ping']);
  });

  it('an abort (close with no arguments) closes 1000 "event stream cancelled" and the listener hears no close', async () => {
    const { seen, base } = daemon();
    const heard: string[] = [];
    const closed: string[] = [];

    const stream = transportAt(base).socket('/v1/events', {
      onFrame: frame => heard.push(String(frame)),
      onClose: reason => closed.push(reason),
    });
    await until(() => heard.length > 0);
    stream.close();
    await until(() => seen.closes.length > 0);
    await new Promise<void>(resolve => setTimeout(resolve, 30));

    should(seen.closes).deepEqual([{ code: 1000, reason: 'event stream cancelled' }]);
    should(closed).deepEqual([]);
  });

  it('an early close is an error sentence with the reason and the code', async () => {
    const { base } = daemon();
    const closed: { reason: string; code?: number }[] = [];

    const stream = transportAt(base).socket('/v1/events', {
      onOpen: () => stream.send('bye'),
      onFrame: () => {},
      onClose: (reason, code) => closed.push({ reason, ...(code === undefined ? {} : { code }) }),
    });
    await until(() => closed.length > 0);

    should(closed).deepEqual([
      { reason: 'WebSocket stream closed unexpectedly: invalid input (code 1008)', code: 1008 },
    ]);
  });

  it('an early close with no reason names only the code', async () => {
    const { base } = daemon();
    const closed: string[] = [];

    const stream = transportAt(base).socket('/v1/events', {
      onOpen: () => stream.send('drop'),
      onFrame: () => {},
      onClose: reason => closed.push(reason),
    });
    await until(() => closed.length > 0);

    should(closed).deepEqual(['WebSocket stream closed unexpectedly: code 1011']);
  });

  it('follows send’s rules: an address that is not this machine is refused before the credential is read or a socket opened', async () => {
    const reads = { count: 0 };
    let opens = 0;
    const closed: string[] = [];
    const transport = new HttpTransport({
      baseUrl: async () => 'https://daemon.example',
      authorization: async () => {
        reads.count += 1;
        return CREDENTIAL;
      },
      beforeSend: async address => {
        if (!isLocalDaemonUrl(address)) throw new Error(`refusing to send the daemon admin token to ${address}`);
      },
      feedSocket: (): FeedSocket => {
        opens += 1;
        throw new Error('must not open');
      },
    });

    transport.socket('/v1/events', { onFrame: () => {}, onClose: reason => closed.push(reason) });
    await until(() => closed.length > 0);

    should(closed).deepEqual(['refusing to send the daemon admin token to https://daemon.example']);
    should(reads.count).equal(0);
    should(opens).equal(0);
  });

  it('refuses a path that names another host, before the credential is read', async () => {
    const reads = { count: 0 };
    let opens = 0;
    const closed: string[] = [];
    const transport = new HttpTransport({
      baseUrl: async () => 'http://127.0.0.1:7457',
      authorization: async () => {
        reads.count += 1;
        return CREDENTIAL;
      },
      feedSocket: (): FeedSocket => {
        opens += 1;
        throw new Error('must not open');
      },
    });

    transport.socket('//elsewhere.example/v1/events', { onFrame: () => {}, onClose: reason => closed.push(reason) });
    await until(() => closed.length > 0);

    should(closed).deepEqual(['a stream path must stay on the daemon address']);
    should(reads.count).equal(0);
    should(opens).equal(0);
  });

  it('never opens a stream closed before the address was judged', async () => {
    const reads = { count: 0 };
    let opens = 0;
    const transport = new HttpTransport({
      baseUrl: async () => 'http://127.0.0.1:7457',
      authorization: async () => {
        reads.count += 1;
        return CREDENTIAL;
      },
      feedSocket: (): FeedSocket => {
        opens += 1;
        throw new Error('must not open');
      },
    });

    transport.socket('/v1/events', { onFrame: () => {}, onClose: () => {} }).close();
    await new Promise<void>(resolve => setTimeout(resolve, 30));

    should(opens).equal(0);
  });
});
