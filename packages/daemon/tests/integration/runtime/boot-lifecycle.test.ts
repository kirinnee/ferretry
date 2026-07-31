import { afterEach, describe, it } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { buildWorld, start, type DaemonWorld } from '../../../bin/fyd.ts';
import { EXIT_ALREADY_RUNNING } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The daemon's boot lifecycle, driven through the real composition root.
 *
 * Everything here runs against a throwaway `FY_HOME` and an ephemeral loopback port: no real state
 * home is resolved, no known port is bound, and no daemon is left running — `untilShutdown` resolves
 * when the test says so, so `start` returns instead of serving forever.
 */

/** Bun declares `port` optional for the unix-socket case; a loopback `serve` always reports one. */
function boundPort(server: { readonly port?: number }): number {
  if (server.port === undefined) throw new Error('the fixture server reported no port');
  return server.port;
}

/** A port nothing is listening on, learned by letting the kernel pick one and then releasing it. */
async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = boundPort(server);
  await server.stop(true);
  return port;
}

/**
 * A state home that already has its layout, holding a configuration that binds the given port.
 *
 * The layout is established through the daemon's own storage rather than by hand, because a home
 * with hand-made directories and no version marker is exactly the foreign state the layout gate
 * exists to refuse. Configuration is written afterwards for the same reason.
 */
async function seedHome(home: string, port: number): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildWorld().storage.open();
  await opened.storage.close();
  await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port }), { mode: 0o600 });
}

/** Boots the production world against a seeded temp home, with shutdown driven by the test. */
async function worldAt(home: string, port: number, untilShutdown: () => Promise<void>): Promise<DaemonWorld> {
  await seedHome(home, port);
  return { ...buildWorld(), untilShutdown };
}

async function runCleanups(cleanups: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
  for (const cleanup of cleanups) await cleanup();
}

describe('daemon boot lifecycle', () => {
  const previousHome = process.env.FY_HOME;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    await cleanupTempDirectories();
  });

  it('should serve health and usage over the configured address, then release everything', async () => {
    // Arrange
    const home = await tempDirectory('fyd-boot');
    const port = await freeLoopbackPort();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, port, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });

    // Act
    const exit = start(world, cleanups);
    // The server is listening once /healthz answers; the poll bounds how long boot may take.
    let health: Response | undefined;
    for (let attempt = 0; attempt < 100 && health === undefined; attempt += 1) {
      health = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
      if (health === undefined) await Bun.sleep(50);
    }
    const usage = await fetch(`http://127.0.0.1:${port}/usage`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/usage`);
    // A mounted subsystem, reached with the token the boot minted. The session does not exist, so a
    // MOUNTED pin board answers `not-found`; an unmounted one would answer `unknown_route`.
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const pins = await fetch(`http://127.0.0.1:${port}/v1/sessions/absent/pins`, {
      headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);
    const afterStop = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);

    // Assert
    should(code).equal(0);
    should(health?.status).equal(200);
    should((await health!.json()) as { status: string }).have.property('status', 'ok');
    should(usage.status).equal(200);
    should((await usage.json()) as { ready: boolean }).have.property('ready', false);
    should(unauthorized.status).equal(401);
    should(pins.status).equal(404);
    should((await pins.json()) as { code: string }).have.property('code', 'not-found');
    should(afterStop).be.undefined();
    // The API tokens were minted into the home, which only a boot that reached the server does.
    should(await readdir(home)).containEql('api-token');
  });

  it('should release the home lock so a second boot of the same home succeeds', async () => {
    // Arrange
    const home = await tempDirectory('fyd-relock');
    const port = await freeLoopbackPort();
    const boot = async (): Promise<number> => {
      const cleanups: Array<() => void | Promise<void>> = [];
      process.env.FY_HOME = home;
      const code = await start({ ...buildWorld(), untilShutdown: async () => {} }, cleanups);
      await runCleanups(cleanups);
      return code;
    };
    await seedHome(home, port);

    // Act
    const first = await boot();
    const second = await boot();

    // Assert
    should(first).equal(0);
    should(second).equal(0);
  });

  it('should report already-running when another owner holds the home lock', async () => {
    // Arrange
    const home = await tempDirectory('fyd-locked');
    const port = await freeLoopbackPort();
    await seedHome(home, port);
    const incumbent = await buildWorld().storage.open();
    const cleanups: Array<() => void | Promise<void>> = [];

    // Act
    const code = await start({ ...buildWorld(), untilShutdown: async () => {} }, cleanups);
    await incumbent.storage.close();

    // Assert
    should(code).equal(EXIT_ALREADY_RUNNING);
    // The open failed, so nothing was acquired and there is nothing to release.
    should(cleanups).be.empty();
  });

  it('should refuse to boot when the configured address already has a responder', async () => {
    // Arrange
    const home = await tempDirectory('fyd-incumbent');
    const incumbent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ status: 'ok' }) });
    const cleanups: Array<() => void | Promise<void>> = [];
    const world = await worldAt(home, boundPort(incumbent), async () => {});

    // Act
    const code = await start(world, cleanups);
    await runCleanups(cleanups);
    await incumbent.stop(true);

    // Assert
    should(code).equal(EXIT_ALREADY_RUNNING);
    // The home was opened before the address was probed, so its release is the one registered step.
    should(cleanups).have.length(1);
  });
});
