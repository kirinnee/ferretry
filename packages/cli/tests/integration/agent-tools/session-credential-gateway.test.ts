import { describe, it } from 'bun:test';
import should from 'should';
import { SessionCredentialGateway } from '../../../src/adapters/agent-tools/session-credential-gateway.ts';
import type { ListenerGuardPorts } from '../../../src/adapters/daemon/listener-guard.ts';
import { standInDaemon } from '../support/stand-in-daemon.ts';

const ferret = (base: string, extra: Partial<ConstructorParameters<typeof SessionCredentialGateway>[0]> = {}) =>
  new SessionCredentialGateway({ baseUrl: async () => base, bearer: 'fys_ferret-1', ...extra });

describe('the ferret’s way to the daemon', () => {
  it('S52 should present the ferret’s own bearer, and no other authorization', async () => {
    // Arrange
    const { seen, url } = standInDaemon(() => Response.json({ summary: 'ok' }));

    // Act
    const reply = await ferret(url).send(
      { method: 'POST', path: '/v1/tools/terminals/terminal_list', body: {} },
      { repeatable: false },
    );

    // Assert
    should(reply).deepEqual({ status: 200, body: { summary: 'ok' } });
    should(seen[0]?.headers).have.property('authorization', 'Bearer fys_ferret-1');
    should(seen[0]?.headers).have.property('content-type', 'application/json');
  });

  it('S58 should identify the pane it runs in, so a person-only route can refuse a ferret that names itself', async () => {
    const { seen, url } = standInDaemon(() => Response.json({}));
    await ferret(url, { ferretId: 'pane-7' }).send({ method: 'GET', path: '/v1/x' }, { repeatable: true });
    should(seen[0]?.headers).have.property('x-ferretry-session-id', 'pane-7');
    should(seen[0]?.headers).have.property('x-ferretry-client', 'cli');
  });

  it('S54 a refusal is the answer: 401, 403 and 5xx come back as they are, with no second request', async () => {
    for (const status of [401, 403, 404, 500]) {
      const { seen, url } = standInDaemon(() => Response.json({ error: 'no', code: 'owner_only' }, { status }));
      const reply = await ferret(url).send({ method: 'GET', path: '/v1/x' }, { repeatable: true });
      should(reply.status).equal(status);
      should(seen.length).equal(1);
    }
  });

  it('S57 should refuse to send the credential to a daemon that is not on this machine, sending nothing', async () => {
    let sent = false;
    const gateway = ferret('https://elsewhere.example:7431', {
      fetcher: async () => {
        sent = true;
        return Response.json({});
      },
    });
    await should(gateway.send({ method: 'GET', path: '/v1/x' }, { repeatable: true })).be.rejectedWith(
      /only to the daemon on this machine/u,
    );
    should(sent).be.false();
  });

  it('S57 should refuse to send it to a loopback port another user holds', async () => {
    const { url, seen } = standInDaemon(() => Response.json({}));
    const port = Number(new URL(url).port);
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    const table = `  sl  local_address rem_address   st\n   0: 0100007F:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1234        0 99 1 0\n`;
    const listeners: ListenerGuardPorts = { tables: async () => [table], uid: () => 1000 };
    await should(
      ferret(url, { listeners }).send({ method: 'GET', path: '/v1/x' }, { repeatable: true }),
    ).be.rejectedWith(/held by another user \(uid 1234\)/u);
    should(seen).deepEqual([]);
  });

  it('should refuse a credential that is not a ferret’s', () => {
    should(
      () => new SessionCredentialGateway({ baseUrl: async () => 'http://127.0.0.1:1', bearer: 'admin-token' }),
    ).throw(/starts with fys_/u);
  });

  it('should return a non-JSON answer as its text, and an empty one as undefined', async () => {
    const text = standInDaemon(() => new Response('not json', { status: 502 }));
    should(await ferret(text.url).send({ method: 'GET', path: '/x' }, { repeatable: true })).deepEqual({
      status: 502,
      body: 'not json',
    });
    const empty = standInDaemon(() => new Response(null, { status: 204 }));
    should(await ferret(empty.url).send({ method: 'GET', path: '/x' }, { repeatable: true })).deepEqual({
      status: 204,
      body: undefined,
    });
  });
});

describe('the ferret’s way to the daemon, through a restart', () => {
  const restart = (told: { count: number }, onWaiting: () => void = () => undefined) => ({
    patience: {
      expected: () => true,
      waiting: () => {
        told.count += 1;
        onWaiting();
      },
      windowMs: 60_000,
    },
    nowMs: () => Date.now(),
    sleep: (milliseconds: number) => Bun.sleep(milliseconds),
  });

  it('should wait for a daemon that is down and answer once it serves again, saying so once', async () => {
    // Arrange: the daemon is up and then goes down; the address it held is the one the restart comes back on.
    const before = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ summary: 'before' }) });
    const port = before.port as number;
    await before.stop(true);
    const told = { count: 0 };
    let after: ReturnType<typeof Bun.serve> | undefined;
    const gateway = ferret(`http://127.0.0.1:${String(port)}`, {
      restart: restart(told, () => {
        after = Bun.serve({
          hostname: '127.0.0.1',
          port,
          fetch: () => Response.json({ summary: 'back after the restart' }),
        });
      }),
    });

    // Act
    const reply = await gateway.send(
      { method: 'POST', path: '/v1/tools/terminals/terminal_send', body: { text: 'ls\n' } },
      { repeatable: false },
    );
    await after?.stop(true);

    // Assert
    should(reply).deepEqual({ status: 200, body: { summary: 'back after the restart' } });
    should(told.count).equal(1);
  });

  it('should wait out a daemon that answers it is still starting, and land the call once it serves', async () => {
    // Arrange
    const starting = {
      error: 'the daemon is starting (reading capability grants); ask again shortly',
      code: 'daemon_starting',
    };
    const answers = [
      Response.json(starting, { status: 503 }),
      Response.json(starting, { status: 503 }),
      Response.json({ summary: 'listed' }),
    ];
    const { seen, url } = standInDaemon(() => answers.shift() as Response);
    const told = { count: 0 };

    // Act
    const reply = await ferret(url, { restart: restart(told) }).send(
      { method: 'GET', path: '/v1/x' },
      { repeatable: true },
    );

    // Assert
    should(reply.body).deepEqual({ summary: 'listed' });
    should(seen.length).equal(3);
    should(told.count).equal(1);
  });

  it('should not wait when no restart patience is given: a refused connection fails at once', async () => {
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({}) });
    const base = `http://127.0.0.1:${String(dead.port)}`;
    await dead.stop(true);
    await should(ferret(base).send({ method: 'GET', path: '/x' }, { repeatable: true })).be.rejected();
  });
});
