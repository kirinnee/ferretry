import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import {
  type BrowserSocket,
  createBrowserRelayDial,
  type RelayCarrierSocket,
} from '../../../app/adapters/browser-relay-dial.ts';

/** Resolves when `ready()` first answers true; polled, with a bound, so a missed event fails rather than hangs. */
const until = async (ready: () => boolean, what: string): Promise<void> => {
  for (let tries = 0; tries < 500; tries += 1) {
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** What a dialled carrier socket was told, in order. */
const listen = (socket: RelayCarrierSocket) => {
  const heard = {
    opened: 0,
    text: [] as string[],
    binary: [] as number[][],
    closed: [] as { code: number; reason: string }[],
  };
  socket.onOpen = () => {
    heard.opened += 1;
  };
  socket.onText = text => heard.text.push(text);
  socket.onBinary = bytes => heard.binary.push([...bytes]);
  socket.onClose = (code, reason) => heard.closed.push({ code, reason });
  return heard;
};

/** A browser socket with nothing behind it, for the shapes a real loopback server cannot produce. */
const bareSocket = () => {
  const sent: (string | ArrayBuffer)[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const socket: BrowserSocket = {
    binaryType: 'blob',
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: data => sent.push(data),
    close: (code, reason) => closes.push({ code, reason }),
  };
  return { socket, sent, closes };
};

describe('the browser relay dial, over a loopback WebSocket server', () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  /** A loopback server that records what the dial sent and answers by `onOpen`. */
  const serve = (onOpen: (ws: Bun.ServerWebSocket<undefined>) => void) => {
    const received: (string | number[])[] = [];
    const server = Bun.serve<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response('no', { status: 400 })),
      websocket: {
        open: onOpen,
        message: (_ws, message) => {
          received.push(typeof message === 'string' ? message : [...new Uint8Array(message)]);
        },
      },
    });
    servers.push(server);
    return { url: `ws://127.0.0.1:${String(server.port)}/v1/rendezvous/stand-in/client`, received };
  };

  it('should open, carry text and binary frames both ways in order, and pass on a close the far end sent', async () => {
    // Arrange
    const { url, received } = serve(ws => {
      ws.send('hello');
      ws.send(new Uint8Array([1, 2, 3]));
      ws.send(new Uint8Array([4]));
    });
    const dial = createBrowserRelayDial({
      openSocket: address => new WebSocket(address) as unknown as BrowserSocket,
      after: (ms, run) => void setTimeout(run, ms),
    });

    // Act
    const socket = dial(url);
    const heard = listen(socket);
    await until(() => heard.opened === 1 && heard.binary.length === 2, 'the frames from the server');
    socket.sendText('ping');
    // A view onto the middle of a larger buffer must reach the far end as exactly its own bytes.
    socket.send(new Uint8Array([9, 8, 7, 6]).subarray(1, 3));
    await until(() => received.length === 2, 'the frames from the dial');
    socket.close(4432, 'capacity');
    await until(() => heard.closed.length === 1, 'the close');

    // Assert
    should(heard.text).eql(['hello']);
    should(heard.binary).eql([[1, 2, 3], [4]]);
    should(received).eql(['ping', [8, 7]]);
    should(heard.closed).eql([{ code: 4432, reason: 'capacity' }]);
  });

  it('should describe a connection that ended without a close frame, once it was carrying the session', async () => {
    // Arrange
    const { url } = serve(ws => {
      setTimeout(() => ws.terminate(), 20);
    });
    const dial = createBrowserRelayDial({
      openSocket: address => new WebSocket(address) as unknown as BrowserSocket,
      after: (ms, run) => void setTimeout(run, ms),
    });

    // Act
    const heard = listen(dial(url));
    await until(() => heard.closed.length >= 1, 'the abnormal close');
    await new Promise(resolve => setTimeout(resolve, 400));

    // Assert: reported once, as 1006, naming the origin and never the path.
    should(heard.opened).equal(1);
    should(heard.closed).have.length(1);
    should(heard.closed[0]?.code).equal(1006);
    should(heard.closed[0]?.reason).containEql('was carrying this session and ended without a close frame');
    should(heard.closed[0]?.reason).containEql(new URL(url).origin);
    should(heard.closed[0]?.reason).not.containEql('stand-in');
  });

  it('should describe a connection that never opened, naming only the origin', async () => {
    // Arrange: a port that just stopped listening.
    const { url } = serve(() => undefined);
    servers.pop()?.stop(true);
    const dial = createBrowserRelayDial({
      openSocket: address => new WebSocket(address) as unknown as BrowserSocket,
      after: (ms, run) => void setTimeout(run, ms),
    });

    // Act
    const heard = listen(dial(url));
    await until(() => heard.closed.length >= 1, 'the failed dial');

    // Assert
    should(heard.opened).equal(0);
    should(heard.closed[0]?.code).equal(1006);
    should(heard.closed[0]?.reason).containEql(`the browser could not open a connection to ${new URL(url).origin}`);
    should(heard.closed[0]?.reason).not.containEql('stand-in');
  });
});

describe('the browser relay dial, over a socket with nothing behind it', () => {
  it('should ask for array buffers, and copy a frame onto a buffer of its own before sending it', () => {
    // Arrange
    const { socket, sent } = bareSocket();
    const adapted = createBrowserRelayDial({ openSocket: () => socket, after: () => undefined })('wss://relay.test/x');

    // Act
    adapted.send(new Uint8Array([5, 6, 7]).subarray(1));
    adapted.sendText('text');
    adapted.close();

    // Assert
    should(socket.binaryType).equal('arraybuffer');
    should(sent).have.length(2);
    should([...new Uint8Array(sent[0] as ArrayBuffer)]).eql([6, 7]);
    should(sent[1]).equal('text');
  });

  it('should not report an error by itself, but end after the grace period, and end only once', () => {
    // Arrange
    const { socket } = bareSocket();
    const timers: { ms: number; run: () => void }[] = [];
    const adapted = createBrowserRelayDial({
      openSocket: () => socket,
      after: (ms, run) => timers.push({ ms, run }),
    })('wss://relay.test/x');
    const heard = listen(adapted);

    // Act
    socket.onerror?.();
    const early = heard.closed.length;
    timers[0]?.run();
    socket.onclose?.({ code: 1006, reason: '' });

    // Assert
    should(early).equal(0);
    should(timers.map(timer => timer.ms)).eql([250]);
    should(heard.closed).have.length(1);
    should(heard.closed[0]?.code).equal(1006);
  });

  it('should treat close code 0 as abnormal, and name a rendezvous it cannot parse as the configured one', () => {
    // Arrange
    const { socket } = bareSocket();
    const adapted = createBrowserRelayDial({ openSocket: () => socket, after: () => undefined })('not a url');
    const heard = listen(adapted);

    // Act
    socket.onclose?.({ code: 0, reason: '' });

    // Assert
    should(heard.closed).eql([
      {
        code: 1006,
        reason: expectedNeverOpened('the configured rendezvous'),
      },
    ]);
  });

  it('should close, and report, a message that is neither text nor a binary frame', () => {
    // Arrange
    const { socket, closes } = bareSocket();
    const adapted = createBrowserRelayDial({ openSocket: () => socket, after: () => undefined })('wss://relay.test/x');
    const heard = listen(adapted);

    // Act
    socket.onmessage?.({ data: { untrusted: true } });

    // Assert
    should(closes).eql([{ code: 4400, reason: 'unknown message type' }]);
    should(heard.closed).eql([{ code: 4400, reason: 'the relay socket delivered a message of an unknown type' }]);
    should(heard.text).eql([]);
    should(heard.binary).eql([]);
  });

  it('should hand the session nothing, and not throw, while no listener is attached', () => {
    // Arrange
    const { socket } = bareSocket();
    createBrowserRelayDial({ openSocket: () => socket, after: () => undefined })('wss://relay.test/x');

    // Act / Assert
    should(() => {
      socket.onopen?.();
      socket.onmessage?.({ data: 'text' });
      socket.onmessage?.({ data: new ArrayBuffer(1) });
      socket.onclose?.({ code: 1000, reason: 'bye' });
    }).not.throw();
  });
});

function expectedNeverOpened(origin: string): string {
  return (
    `the browser could not open a connection to ${origin}. The address may not resolve, may refuse TLS, ` +
    'may be blocked on this network, or may not be serving this machine'
  );
}
