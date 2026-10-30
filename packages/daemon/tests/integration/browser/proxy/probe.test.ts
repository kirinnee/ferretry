import { afterEach, describe, it } from 'bun:test';
import { connect, createServer, type Server, type Socket } from 'node:net';
import should from 'should';
import { TunnelProxyProbe } from '../../../../src/adapters/browser/proxy/probe.ts';
import { proxyEndpoint } from '../../../../src/lib/browser/proxy/index.ts';

/** Every peer is a loopback fake. The probe's TLS step is swapped for a pass-through: a fake has no certificate. */
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  return await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

const plain = new TunnelProxyProbe({ secure: socket => socket, timeoutMs: 1_500 });

async function origin(reply: string): Promise<number> {
  return await listen(createServer(socket => socket.once('data', () => socket.end(reply))));
}

const OK = (ip: string): string => `HTTP/1.0 200 OK\r\nContent-Length: ${ip.length}\r\n\r\n${ip}`;
const BASIC = `Proxy-Authorization: Basic ${Buffer.from('amy:hunter2').toString('base64')}`;

async function httpProxy(originPort: number, seen: string[] = []): Promise<number> {
  return await listen(
    createServer(client =>
      client.once('data', data => {
        const text = data.toString();
        seen.push(text);
        if (!text.includes(BASIC)) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        const upstream = connect(originPort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          client.pipe(upstream);
          upstream.pipe(client);
        });
      }),
    ),
  );
}

const through = (port: number, scheme = 'http') => proxyEndpoint(`${scheme}://127.0.0.1:${port}`);
const CREDENTIALS = { username: 'amy', password: 'hunter2' };

describe('the proxy probe, against loopback fakes', () => {
  it('learns the egress address through an HTTP proxy that wants a sign-in', async () => {
    const seen: string[] = [];
    const port = await httpProxy(await origin(OK('203.0.113.7')), seen);
    should(await plain.run({ endpoint: through(port), credentials: CREDENTIALS })).eql({
      ok: true,
      egressIp: '203.0.113.7',
    });
    should(seen[0]).startWith('CONNECT api64.ipify.org:443 HTTP/1.1');
  });

  it('reads a chunked reply and an IPv6 address', async () => {
    const reply = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n2001:db8::1\r\n0\r\n\r\n';
    const port = await httpProxy(await origin(reply));
    should(await plain.run({ endpoint: through(port), credentials: CREDENTIALS })).eql({
      ok: true,
      egressIp: '2001:db8::1',
    });
  });

  it('reports auth when the proxy answers 407', async () => {
    const port = await httpProxy(await origin(OK('203.0.113.7')));
    should(await plain.run({ endpoint: through(port), credentials: { username: 'amy', password: 'wrong' } })).eql({
      ok: false,
      errorClass: 'auth',
    });
    should(await plain.run({ endpoint: through(port) })).eql({ ok: false, errorClass: 'auth' });
  });

  it('reports connect when nothing listens at the proxy address', async () => {
    const port = await listen(createServer());
    servers.pop()?.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    should(await plain.run({ endpoint: through(port) })).eql({ ok: false, errorClass: 'connect' });
  });

  it('reports timeout when the proxy accepts and says nothing', async () => {
    const port = await listen(createServer());
    should(await plain.run({ endpoint: through(port) })).eql({ ok: false, errorClass: 'timeout' });
  });

  it('reports dns when the proxy host does not resolve', async () => {
    const result = await plain.run({ endpoint: proxyEndpoint('http://nowhere.invalid:8080') });
    should(result.ok).equal(false);
    should(['dns', 'timeout']).containEql((result as { errorClass: string }).errorClass);
  });

  it('reports proxy when the proxy refuses the CONNECT with another status', async () => {
    const port = await listen(
      createServer(client => client.once('data', () => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'))),
    );
    should(await plain.run({ endpoint: through(port) })).eql({ ok: false, errorClass: 'proxy' });
  });

  it('reports other when the endpoint answers with something that is not an address', async () => {
    const port = await httpProxy(await origin('HTTP/1.0 200 OK\r\n\r\nhello'));
    should(await plain.run({ endpoint: through(port), credentials: CREDENTIALS })).eql({
      ok: false,
      errorClass: 'other',
    });
  });

  it('reports tls when the secure step fails', async () => {
    const port = await httpProxy(await origin(OK('203.0.113.7')));
    const failing = new TunnelProxyProbe({
      timeoutMs: 1_500,
      secure: (socket: Socket) => {
        queueMicrotask(() =>
          socket.destroy(Object.assign(new Error('bad cert'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })),
        );
        return socket;
      },
    });
    should(await failing.run({ endpoint: through(port), credentials: CREDENTIALS })).eql({
      ok: false,
      errorClass: 'tls',
    });
  });

  it('learns the egress address through a SOCKS5 proxy that signs in with a user name and password', async () => {
    const originPort = await origin(OK('198.51.100.9'));
    const port = await listen(
      createServer(client => {
        client.once('data', () => {
          client.write(Buffer.from([5, 2]));
          client.once('data', auth => {
            const accepted = Buffer.from(auth).subarray(2, 5).toString() === 'amy';
            client.write(Buffer.from([1, accepted ? 0 : 1]));
            if (!accepted) return void client.end();
            client.once('data', () => {
              const upstream = connect(originPort, '127.0.0.1', () => {
                client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                client.pipe(upstream);
                upstream.pipe(client);
              });
            });
          });
        });
      }),
    );
    should(await plain.run({ endpoint: through(port, 'socks5'), credentials: CREDENTIALS })).eql({
      ok: true,
      egressIp: '198.51.100.9',
    });
    should(await plain.run({ endpoint: through(port, 'socks5'), credentials: { username: 'bob', password: 'x' } })).eql(
      {
        ok: false,
        errorClass: 'auth',
      },
    );
  });
});
