import { describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { HttpTransport } from '../../../src/adapters/daemon/http-transport.ts';
import { readDaemonRunDocument } from '../../../src/adapters/daemon/run-file.ts';
import { findDaemonBinary, launchDaemon, type LaunchPorts } from '../../../src/adapters/daemon/launcher.ts';
import { probeHealth } from '../../../src/adapters/daemon/probe.ts';
import { DaemonTokenFileError, readAdminToken } from '../../../src/adapters/daemon/token-file.ts';
import { HEALTH, standInDaemon } from '../support/stand-in-daemon.ts';
import { waitFor } from '../support/wait-for.ts';

async function temp<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-shell-'));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the admin token file', () => {
  it('should read an owner-only file and trim it', async () => {
    await temp(async dir => {
      const path = join(dir, 'admin-token');
      await writeFile(path, 'secret-value\n', { mode: 0o600 });
      should(await readAdminToken(path)).equal('secret-value');
    });
  });

  it('should refuse a file that group or other can read, without printing its contents', async () => {
    await temp(async dir => {
      const path = join(dir, 'admin-token');
      await writeFile(path, 'secret-value', { mode: 0o644 });
      await chmod(path, 0o644);
      const error = await readAdminToken(path).catch((failure: unknown) => failure);
      should(error).be.instanceOf(DaemonTokenFileError);
      should((error as Error).message).containEql('owner-only (current mode 644)');
      should((error as Error).message).not.containEql('secret-value');
    });
  });

  it('should tell missing, empty and not-a-file apart', async () => {
    await temp(async dir => {
      await should(readAdminToken(join(dir, 'nope'))).be.rejectedWith(/token is missing/u);
      const empty = join(dir, 'empty');
      await writeFile(empty, '  \n', { mode: 0o600 });
      await should(readAdminToken(empty)).be.rejectedWith(/is empty/u);
      const folder = join(dir, 'folder');
      await mkdir(folder);
      await should(readAdminToken(folder)).be.rejectedWith(/not a regular file/u);
    });
  });
});

describe('the daemon run record', () => {
  it('should read it, and answer undefined for a missing one', async () => {
    await temp(async dir => {
      const path = join(dir, 'daemon.json');
      await writeFile(path, '{"port":1}');
      should(await readDaemonRunDocument(path)).equal('{"port":1}');
      should(await readDaemonRunDocument(join(dir, 'absent.json'))).be.undefined();
    });
  });
});

describe('probeHealth', () => {
  it('should say up for a daemon, with its protocol and version, sending no credential', async () => {
    const { url, seen } = standInDaemon(() => Response.json(HEALTH));
    const probe = await probeHealth(url);
    should(probe).deepEqual({ state: 'up', baseUrl: url, health: HEALTH });
    should(seen[0]?.headers).not.have.property('authorization');
  });

  it('should say down for something that is not a daemon, and for an HTTP error', async () => {
    const other = standInDaemon(() => Response.json({ hello: 'world' }));
    should((await probeHealth(other.url)).state).equal('down');
    const broken = standInDaemon(() => new Response('x', { status: 500 }));
    const probe = await probeHealth(broken.url);
    should(probe).match({ state: 'down', why: 'HTTP 500' });
  });

  it('should say down, with the reason, when nothing listens', async () => {
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const base = `http://127.0.0.1:${String(gone.port)}`;
    await gone.stop(true);
    const probe = await probeHealth(base);
    should(probe.state).equal('down');
  });
});

describe('launching the daemon', () => {
  const ports = (overrides: Partial<LaunchPorts> = {}): LaunchPorts & { spawned: string[][] } => {
    const spawned: string[][] = [];
    let now = 0;
    return {
      selfPath: '/opt/ferretry/bin/fy',
      exists: path => path === '/opt/ferretry/bin/fyd',
      which: () => null,
      spawnDetached: command => {
        spawned.push([...command]);
      },
      probe: async () => ({ state: 'up', baseUrl: 'http://127.0.0.1:7431', health: HEALTH }),
      sleep: async ms => {
        now += ms;
      },
      nowMs: () => now,
      environment: {},
      spawned,
      ...overrides,
    };
  };

  it('should look for the daemon beside fy first, then on PATH', () => {
    should(findDaemonBinary(ports())).equal('/opt/ferretry/bin/fyd');
    should(findDaemonBinary(ports({ exists: () => false, which: () => '/usr/bin/fyd' }))).equal('/usr/bin/fyd');
    should(findDaemonBinary(ports({ exists: () => false }))).be.undefined();
  });

  it('should start it and report the address it answers on', async () => {
    const launch = ports();
    should(await launchDaemon(launch)).deepEqual({ started: true, baseUrl: 'http://127.0.0.1:7431' });
    should(launch.spawned).deepEqual([['/opt/ferretry/bin/fyd']]);
  });

  it('should say it cannot find the binary, spawning nothing', async () => {
    const launch = ports({ exists: () => false });
    const result = await launchDaemon(launch);
    should(result.started).be.false();
    should(launch.spawned).deepEqual([]);
  });

  it('should wait for the daemon to answer, then give up with the reason', async () => {
    let looks = 0;
    const slow = ports({
      probe: async () =>
        ++looks > 3
          ? { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: HEALTH }
          : { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'refused' },
    });
    should((await launchDaemon(slow)).started).be.true();
    const never = ports({ probe: async () => ({ state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'refused' }) });
    const result = await launchDaemon(never);
    should(result.started).be.false();
    should(result.started === false && result.why).containEql('not answering');
  });

  it('should wait for a real server to come up (the wait helper)', async () => {
    const { url } = standInDaemon(() => Response.json(HEALTH));
    const probe = await waitFor(async () => {
      const result = await probeHealth(url);
      return result.state === 'up' ? result : undefined;
    }, 'the stand-in daemon to answer');
    should(probe.state).equal('up');
  });
});

describe('riding out a restart', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const restart = (slept: number[]) => ({
    patience: { expected: () => true, waiting: () => undefined },
    nowMs: () => slept.reduce((sum, ms) => sum + ms, 0),
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  });

  it('should ask the guard again BEFORE sending a request a second time, and send nothing when it refuses', async () => {
    // Arrange: the first attempt finds the daemon away; the daemon that comes back has the plugin off.
    const asked: string[] = [];
    const order: string[] = [];
    const transport = new HttpTransport({
      baseUrl: async () => 'http://127.0.0.1:7457',
      authorization: async () => undefined,
      fetcher: async url => {
        asked.push(url);
        order.push('send');
        throw refused();
      },
      restart: restart([]),
    });

    // Act
    const error = await transport
      .send(
        { method: 'POST', path: '/v1/cards/a/move' },
        {
          repeatable: false,
          recheck: async () => {
            order.push('recheck');
            throw new Error('Board is turned off');
          },
        },
      )
      .catch((failure: unknown) => failure);

    // Assert
    should((error as Error).message).equal('Board is turned off');
    should(asked).deepEqual(['http://127.0.0.1:7457/v1/cards/a/move']);
    should(order).deepEqual(['send', 'recheck']);
  });

  it('should send again after a recheck that passes, and keep waiting while the recheck finds the daemon away', async () => {
    // Arrange
    const order: string[] = [];
    let rechecks = 0;
    const transport = new HttpTransport({
      baseUrl: async () => 'http://127.0.0.1:7457',
      authorization: async () => undefined,
      fetcher: async () => {
        order.push('send');
        if (order.length === 1) throw refused();
        return Response.json({ ok: true });
      },
      restart: restart([]),
    });

    // Act
    const reply = await transport.send(
      { method: 'GET', path: '/v1/cards/a' },
      {
        repeatable: true,
        recheck: async () => {
          rechecks += 1;
          order.push('recheck');
          if (rechecks === 1) throw refused();
        },
      },
    );

    // Assert
    should(reply).deepEqual({ status: 200, body: { ok: true } });
    should(order).deepEqual(['send', 'recheck', 'recheck', 'send']);
  });
});
