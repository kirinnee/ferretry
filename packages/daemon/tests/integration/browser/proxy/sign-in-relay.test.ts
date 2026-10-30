import { afterEach, describe, it } from 'bun:test';
import { connect, createServer, type Server } from 'node:net';
import should from 'should';
import { ProxySignInRelay } from '../../../../src/adapters/browser/proxy/sign-in-relay.ts';

/** Every peer here is a loopback fake: the relay is exercised against sockets, never against a network. */
const servers: Server[] = [];
const relays: ProxySignInRelay[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  return await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

async function origin(): Promise<number> {
  return await listen(createServer(socket => socket.on('data', data => socket.write(`echo:${data}`))));
}

const AUTH = `Proxy-Authorization: Basic ${Buffer.from('user:pass').toString('base64')}`;

/** An HTTP proxy that wants `user:pass`, tunnels CONNECT to `originPort` and answers plain requests itself. */
async function httpProxy(originPort: number, requests: string[]): Promise<number> {
  return await listen(
    createServer(client =>
      client.once('data', data => {
        const text = data.toString();
        requests.push(text);
        if (!text.includes(AUTH)) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        if (!text.startsWith('CONNECT')) return void client.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
        const upstream = connect(originPort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 OK\r\n\r\n');
          client.pipe(upstream);
          upstream.pipe(client);
        });
      }),
    ),
  );
}

/** A SOCKS5 proxy that accepts username/password authentication and tunnels every connect to `originPort`. */
async function socksProxy(originPort: number): Promise<number> {
  return await listen(
    createServer(client => {
      let stage = 0;
      client.on('data', (data: Buffer) => {
        if (stage === 0) {
          client.write(Buffer.from([5, 2]));
          stage = 1;
        } else if (stage === 1) {
          const user = data.subarray(2, 2 + (data[1] as number)).toString();
          client.write(Buffer.from([1, user === 'user' ? 0 : 1]));
          stage = 2;
        } else {
          client.removeAllListeners('data');
          const upstream = connect(originPort, '127.0.0.1', () =>
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])),
          );
          client.pipe(upstream);
          upstream.pipe(client);
        }
      });
    }),
  );
}

async function exchange(relayPort: number, open: string, then: string | undefined): Promise<string> {
  return await new Promise(resolve => {
    const socket = connect(relayPort, '127.0.0.1', () => socket.write(open));
    let received = '';
    let sent = false;
    socket.on('data', data => {
      received += data;
      if (then !== undefined && !sent && received.includes('200')) {
        sent = true;
        socket.write(then);
      }
      if (then !== undefined && received.includes('echo:')) socket.destroy();
    });
    socket.on('close', () => resolve(received));
  });
}

async function relay(scheme: 'http' | 'socks5', port: number, password = 'pass'): Promise<ProxySignInRelay> {
  const started = await ProxySignInRelay.start({ scheme, host: '127.0.0.1', port }, { username: 'user', password });
  relays.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(relays.splice(0).map(started => started.close()));
  for (const server of servers.splice(0)) server.close();
});

describe('ProxySignInRelay', () => {
  it('should tunnel a CONNECT through an HTTP proxy that wants a sign-in', async () => {
    const proxy = await httpProxy(await origin(), []);
    const started = await relay('http', proxy);
    const reply = await exchange(started.port, 'CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: x\r\n\r\n', 'hello');
    should(reply).startWith('HTTP/1.1 200 Connection Established');
    should(reply).endWith('echo:hello');
  });

  it('should forward a plain request with its own sign-in and without the one Chrome sent', async () => {
    const requests: string[] = [];
    const proxy = await httpProxy(await origin(), requests);
    const started = await relay('http', proxy);
    const reply = await exchange(
      started.port,
      'GET http://example.test/a HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\n\r\n',
      undefined,
    );
    should(reply).endWith('ok');
    should(requests[0]).startWith('GET http://example.test/a HTTP/1.1');
    should(requests[0]).containEql(AUTH);
    should(requests[0]).not.containEql('Zm9vOmJhcg==');
  });

  it('should answer a bad gateway naming the refused sign-in when the proxy says 407', async () => {
    const proxy = await httpProxy(await origin(), []);
    const started = await relay('http', proxy, 'wrong');
    const reply = await exchange(started.port, 'CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: x\r\n\r\n', undefined);
    should(reply).startWith('HTTP/1.1 502');
    should(reply).containEql('refused the username and password');
  });

  it('should tunnel a CONNECT through a SOCKS5 proxy with username and password', async () => {
    const proxy = await socksProxy(await origin());
    const started = await relay('socks5', proxy);
    const reply = await exchange(started.port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: x\r\n\r\n', 'hello');
    should(reply).endWith('echo:hello');
  });

  it('should say the proxy could not be reached, without a credential in the sentence', async () => {
    const started = await relay('http', 1);
    const reply = await exchange(started.port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: x\r\n\r\n', undefined);
    should(reply).startWith('HTTP/1.1 502');
    should(reply).containEql('could not be reached');
    should(reply).not.containEql('pass');
  });

  it('should refuse a request it cannot read', async () => {
    const started = await relay('http', 1);
    const reply = await exchange(started.port, 'NOT A REQUEST\r\n\r\n', undefined);
    should(reply).startWith('HTTP/1.1 400');
  });
});
