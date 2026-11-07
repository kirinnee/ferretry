import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { implementCli } from '@ferretry/kernel/manifest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { createWorld } from '../../src/adapters/world.ts';
import { surfacesOf } from '../../src/lib/client.ts';
import { runFy } from '../../src/lib/run.ts';
import { boardEntry, boardManifest, capturedIo, entry, registryOf } from '../unit/fakes.ts';
import { HEALTH, standInDaemon } from './support/stand-in-daemon.ts';

/** No test may start a real daemon: the launcher finds nothing and spawns nothing unless a test hands it a fake. */
const NO_PROCESS = {
  exists: () => false,
  which: () => null,
  spawnDetached: () => {
    throw new Error('a test must not start a real process');
  },
};

const PLUGINS = { protocol: 1, plugins: [{ id: 'board', on: true, contract: 'h-board' }] };

/** A temp user home with `<home>/.ferretry/state/gate/admin-token`; the environment is built, never inherited. */
async function withHome<T>(use: (home: string, adminTokenPath: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'fy-world-'));
  const gate = join(home, '.ferretry', 'state', 'gate');
  await mkdir(gate, { recursive: true });
  try {
    return await use(home, join(gate, 'admin-token'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Writes the kernel's run record (`run/daemon.json`, format 1) as a daemon does on listen. */
async function recordRun(home: string, port: number, host = '127.0.0.1'): Promise<void> {
  const run = join(home, '.ferretry', 'run');
  await mkdir(run, { recursive: true });
  const record = { format: 1, socket: join(run, 'fyd.sock'), host, port, pid: 4242, version: '5.0.0' };
  await writeFile(join(run, 'daemon.json'), JSON.stringify(record));
}

const worldFor = (home: string, environment: Record<string, string>) =>
  createWorld({
    io: capturedIo(),
    environment,
    userHome: home,
    identity: { binary: 'fy', version: '5.0.0' },
    product: 'ferretry',
    registry: registryOf(boardEntry()),
    selfPath: join(home, 'bin', 'fy'),
    process: NO_PROCESS,
  });

const daemon = () =>
  standInDaemon((_request, path) =>
    path === '/v1/health'
      ? Response.json(HEALTH)
      : path === '/v1/plugins'
        ? Response.json(PLUGINS)
        : Response.json({ error: 'no' }, { status: 404 }),
  );

describe('connecting to the daemon', () => {
  it('P90 FY_URL wins outright and FY_TOKEN is the credential, with no token file read', async () => {
    await withHome(async home => {
      const { url, seen } = daemon();
      const world = worldFor(home, { FY_URL: url, FY_TOKEN: 'owner-token' });
      const connection = await world.connect({ asOwner: false });
      await connection.inventory.current();
      should(connection.baseUrl).equal(url);
      should(seen[0]?.headers).have.property('authorization', 'Bearer owner-token');
    });
  });

  it('P90 a genuinely remote daemon still requires its own FY_TOKEN', async () => {
    await withHome(async home => {
      const world = worldFor(home, { FY_URL: 'https://daemon.example:7431' });
      await should(world.connect({ asOwner: false })).be.rejectedWith(
        /FY_TOKEN is required when the daemon is not on this machine/u,
      );
      const remote = await worldFor(home, { FY_URL: 'https://daemon.example:7431', FY_TOKEN: 'remote-token' }).connect({
        asOwner: false,
      });
      should(remote.baseUrl).equal('https://daemon.example:7431');
    });
  });

  it('S52 a person’s shell presents the admin token read from the home', async () => {
    await withHome(async (home, adminTokenPath) => {
      await writeFile(adminTokenPath, 'admin-secret\n', { mode: 0o600 });
      const { url, seen } = daemon();
      const world = worldFor(home, { FY_URL: url });
      await (await world.connect({ asOwner: false })).inventory.current();
      should(seen[0]?.headers).have.property('authorization', 'Bearer admin-secret');
      should(seen[0]?.headers).have.property('x-ferretry-client', 'cli');
    });
  });

  it('S53 a ferret presents its own fys_ bearer and never opens the admin token file, even without FY_SESSION_ID', async () => {
    await withHome(async home => {
      // No token file exists: if the ferret path opened it, connecting would fail.
      const { url, seen } = daemon();
      const world = worldFor(home, { FY_URL: url, FY_SESSION_TOKEN: 'fys_pane-credential' });
      await (await world.connect({ asOwner: false })).inventory.current();
      should(seen[0]?.headers).have.property('authorization', 'Bearer fys_pane-credential');
      should(seen[0]?.headers).not.have.property('x-ferretry-session-id');
    });
  });

  it('S58 inside a pane the session id travels with every request, so its acts stay the ferret’s', async () => {
    await withHome(async home => {
      const { url, seen } = daemon();
      const world = worldFor(home, { FY_URL: url, FY_SESSION_TOKEN: 'fys_pane-credential', FY_SESSION_ID: 'pane-3' });
      await (await world.connect({ asOwner: false })).inventory.current();
      should(seen[0]?.headers).have.property('x-ferretry-session-id', 'pane-3');
    });
  });

  it('S58 --as-owner prints its stderr line and presents the admin token, while the session id still travels', async () => {
    await withHome(async (home, adminTokenPath) => {
      await writeFile(adminTokenPath, 'admin-secret', { mode: 0o600 });
      const { url, seen } = daemon();
      const io = capturedIo();
      const world = createWorld({
        io,
        environment: { FY_URL: url, FY_SESSION_TOKEN: 'fys_pane-credential', FY_SESSION_ID: 'pane-3' },
        userHome: home,
        identity: { binary: 'fy', version: '5.0.0' },
        product: 'ferretry',
        registry: registryOf(),
        selfPath: join(home, 'bin', 'fy'),
        process: NO_PROCESS,
      });
      await (await world.connect({ asOwner: true })).inventory.current();
      should(io.stderr()).containEql('--as-owner: acting with the host admin token');
      should(seen[0]?.headers).have.property('authorization', 'Bearer admin-secret');
      should(seen[0]?.headers).have.property('x-ferretry-session-id', 'pane-3');
    });
  });

  it('S57 a ferret’s credential is never sent to a non-loopback FY_URL', async () => {
    await withHome(async home => {
      const world = worldFor(home, { FY_URL: 'https://daemon.example:7431', FY_SESSION_TOKEN: 'fys_pane-credential' });
      await should(world.connect({ asOwner: false })).be.rejectedWith(/FY_TOKEN is required/u);
    });
  });

  it('should follow the address the daemon recorded in run/daemon.json when FY_URL is unset', async () => {
    await withHome(async home => {
      const { port, seen } = daemon();
      await recordRun(home, port);
      const world = worldFor(home, { FY_TOKEN: 'owner-token' });
      const probe = await world.probe();
      should(probe.state).equal('up');
      should(seen[0]?.path).equal('/v1/health');
    });
  });

  it('should say it cannot start a daemon it cannot find, instead of hanging, when a person’s shell finds none running', async () => {
    await withHome(async home => {
      const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
      const port = dead.port as number;
      await dead.stop(true);
      await recordRun(home, port);
      const world = worldFor(home, {});
      await should(world.connect({ asOwner: false })).be.rejectedWith(/cannot find fyd/u);
    });
  });

  it('should start the daemon by itself on a person’s first command, then talk to it', async () => {
    await withHome(async home => {
      const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
      const port = dead.port as number;
      await dead.stop(true);
      await recordRun(home, port);
      const spawned: string[][] = [];
      let started: ReturnType<typeof Bun.serve> | undefined;
      const world = createWorld({
        io: capturedIo(),
        environment: {},
        userHome: home,
        identity: { binary: 'fy', version: '5.0.0' },
        product: 'ferretry',
        registry: registryOf(),
        selfPath: join(home, 'bin', 'fy'),
        process: {
          exists: path => path === join(home, 'bin', 'fyd'),
          which: () => null,
          spawnDetached: command => {
            spawned.push([...command]);
            started = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json(HEALTH) });
          },
        },
      });
      try {
        const connection = await world.connect({ asOwner: false });
        should(spawned).deepEqual([[join(home, 'bin', 'fyd')]]);
        should(connection.baseUrl).equal(`http://127.0.0.1:${String(port)}`);
      } finally {
        await started?.stop(true);
      }
    });
  });

  it('should never start a daemon for a ferret: it exists because one ran', async () => {
    await withHome(async home => {
      const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
      const port = dead.port as number;
      await dead.stop(true);
      await recordRun(home, port);
      const world = worldFor(home, { FY_SESSION_TOKEN: 'fys_pane-credential' });
      const connection = await world.connect({ asOwner: false });
      should(connection.baseUrl).equal(`http://127.0.0.1:${String(port)}`);
    });
  });

  it('should refuse to read a plugin list in a shape it does not know, or a refusal, with a sentence', async () => {
    await withHome(async home => {
      const odd = standInDaemon(() => Response.json({ nope: true }));
      const refusing = standInDaemon(() => Response.json({ error: 'unlock first' }, { status: 401 }));
      const read = async (url: string) =>
        (await worldFor(home, { FY_URL: url, FY_TOKEN: 't' }).connect({ asOwner: false })).inventory.current();
      await should(read(odd.url)).be.rejectedWith(/not in a shape this fy reads/u);
      await should(read(refusing.url)).be.rejectedWith('unlock first');
    });
  });

  it('should run a plugin verb end to end through the real transport and the guard', async () => {
    await withHome(async home => {
      const { url, seen } = daemon();
      const calls: { args?: readonly string[] } = {};
      const io = capturedIo();
      const world = createWorld({
        io,
        environment: { FY_URL: url, FY_TOKEN: 't' },
        userHome: home,
        identity: { binary: 'fy', version: '5.0.0' },
        product: 'ferretry',
        registry: registryOf(boardEntry(calls)),
        selfPath: join(home, 'bin', 'fy'),
        process: NO_PROCESS,
      });
      should(await runFy(['plugin', 'list'], world)).equal(0);
      should(io.stdout()).containEql('board');
      should(seen.map(request => request.path)).deepEqual(['/v1/plugins']);
      should(surfacesOf(world.registry).compiled).have.properties({ kernel: 'h-kernel', board: 'h-board' });
    });
  });
});

/** A fake network: records every URL asked for and answers like a daemon. No socket is opened. */
function fakeNetwork(
  answer: (url: URL) => Response = url =>
    url.pathname === '/v1/health'
      ? Response.json(HEALTH)
      : url.pathname === '/v1/plugins'
        ? Response.json(PLUGINS)
        : Response.json({}),
) {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    return answer(new URL(url));
  };
  return { asked, fetcher };
}

describe('where each request goes (S57, S59)', () => {
  it('S57 an address that turns remote after connecting is refused before the admin token is read or anything is sent', async () => {
    await withHome(async home => {
      // Arrange: a person's shell, a loopback daemon recorded in the run record, and no token file (reading it would fail
      // with another sentence).
      await recordRun(home, 7457);
      const network = fakeNetwork();
      const world = createWorld({
        io: capturedIo(),
        environment: {},
        userHome: home,
        identity: { binary: 'fy', version: '5.0.0' },
        product: 'ferretry',
        registry: registryOf(boardEntry()),
        selfPath: join(home, 'bin', 'fy'),
        process: NO_PROCESS,
        fetcher: network.fetcher,
      });
      const connection = await world.connect({ asOwner: false });

      // Act: the run record now names another machine.
      await recordRun(home, 7457, 'daemon.example');
      const error = await connection.transport
        .send({ method: 'GET', path: '/v1/plugins' }, { repeatable: true })
        .catch((failure: unknown) => failure);

      // Assert
      should((error as Error).message).containEql(
        'FY_TOKEN is required when the daemon is not on this machine (http://daemon.example:7457)',
      );
      should(network.asked.some(url => url.includes('daemon.example'))).be.false();
    });
  });

  it('S59 a person-only verb in a pane is refused with a real world before /v1/health is asked', async () => {
    await withHome(async home => {
      // Arrange: a pane with an id and no bearer; nothing recorded, so a connection would probe and try to start one.
      const network = fakeNetwork();
      const half = implementCli(boardManifest, {
        build: ctx => ({
          verbs: {
            'card move': async () => {
              await ctx.client.call('POST /v1/cards/:id/move', { params: { id: 'a' } });
              return 0;
            },
            'card show': async () => 0,
            board: async () => 0,
          },
        }),
      });
      const io = capturedIo();
      const world = createWorld({
        io,
        environment: { FY_SESSION_ID: 'pane-3' },
        userHome: home,
        identity: { binary: 'fy', version: '5.0.0' },
        product: 'ferretry',
        registry: registryOf(entry(boardManifest, 'h-board', half)),
        selfPath: join(home, 'bin', 'fy'),
        process: NO_PROCESS,
        fetcher: network.fetcher,
      });

      // Act
      const code = await runFy(['card', 'move', 'a'], world);

      // Assert
      should(code).equal(1);
      should(io.stderr()).containEql("this is the owner's command; a ferret's pane can't run it");
      should(network.asked).deepEqual([]);
    });
  });
});
