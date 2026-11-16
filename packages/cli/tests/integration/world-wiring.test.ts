import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { createWorld } from '../../src/adapters/world.ts';
import type { DaemonControlReads } from '../../src/lib/daemon/controller.ts';
import { capturedIo, registryOf } from '../unit/fakes.ts';
import { HEALTH, standInDaemon } from './support/stand-in-daemon.ts';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('the production world wires this verb');
  return value;
}

const PLUGINS = { protocol: 1, plugins: [{ id: 'board', on: true, contract: 'h-board' }] };
const SERVING = { ...HEALTH, pid: 4242 };

/** A temp user home laid out the way a person's is, with every XDG location inside it. */
interface Home {
  readonly home: string;
  readonly environment: Record<string, string>;
  readonly bin: string;
}
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});
async function aHome(extra: Record<string, string> = {}): Promise<Home> {
  const home = await mkdtemp(join(tmpdir(), 'fy-wiring-'));
  homes.push(home);
  await mkdir(join(home, '.ferretry', 'state', 'gate'), { recursive: true });
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, '.ferretry', 'state', 'gate', 'admin-token'), 'admin-secret\n', { mode: 0o600 });
  const environment = {
    XDG_RUNTIME_DIR: join(home, 'runtime'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'xdg-state'),
    ...extra,
  };
  return { home, environment, bin: join(home, 'bin') };
}

async function recordRun(home: string, port: number, pid = 4242): Promise<void> {
  const run = join(home, '.ferretry', 'run');
  await mkdir(run, { recursive: true });
  const record = { format: 1, socket: join(run, 'fyd.sock'), host: '127.0.0.1', port, pid, version: '5.0.0' };
  await writeFile(join(run, 'daemon.json'), JSON.stringify(record));
}

async function stand(bin: string, name: string, script: string): Promise<string> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

const NOT_ASKED: DaemonControlReads = {
  resetInventory: { count: async () => await Promise.resolve(undefined) },
  turns: { midTurn: async () => await Promise.resolve(0) },
};

function worldIn(h: Home, extra: { process?: Parameters<typeof createWorld>[0]['process'] } = {}) {
  const io = capturedIo();
  const world = createWorld({
    io,
    environment: h.environment,
    userHome: h.home,
    identity: { binary: 'fy', version: '5.0.0' },
    product: 'ferretry',
    registry: registryOf(),
    selfPath: join(h.bin, 'fy'),
    ...extra,
  });
  return { io, world };
}

const serving = () =>
  standInDaemon((_request, path) =>
    path === '/v1/plugins'
      ? Response.json(PLUGINS)
      : path === '/v1/health'
        ? Response.json(HEALTH)
        : path === '/healthz'
          ? Response.json(SERVING)
          : Response.json({ error: 'no' }, { status: 404 }),
  );

describe('a person’s shell following a daemon that restarts onto another process', () => {
  it('should keep the plugin list while the recorded daemon is the same and read it again when the pid changes', async () => {
    const h = await aHome();
    const daemon = serving();
    await recordRun(h.home, daemon.port);
    const { world } = worldIn(h, { process: { exists: () => false, which: () => null } });
    const connection = await world.connect({ asOwner: false });
    await connection.inventory.current();
    await connection.inventory.current();
    const asked = () => daemon.seen.filter(request => request.path === '/v1/plugins').length;
    should(asked()).equal(1);
    await recordRun(h.home, daemon.port, 4243);
    await connection.inventory.current();
    should(asked()).equal(2);
  });
});

describe('a ferret waiting out a daemon restart', () => {
  it('should say once that the daemon is restarting, and land the call when it serves', async () => {
    const h = await aHome();
    const starting = { error: 'the daemon is starting; ask again shortly', code: 'daemon_starting' };
    const answers = [
      Response.json(starting, { status: 503 }),
      Response.json(starting, { status: 503 }),
      Response.json(PLUGINS),
    ];
    const daemon = standInDaemon((_request, path) =>
      path === '/v1/health' ? Response.json(HEALTH) : (answers.shift() as Response),
    );
    const { world, io } = worldIn(
      { ...h, environment: { ...h.environment, FY_URL: daemon.url, FY_SESSION_TOKEN: 'fys_pane-credential' } },
      { process: { exists: () => false, which: () => null } },
    );
    const connection = await world.connect({ asOwner: false });
    const plugins = await connection.inventory.current();
    should(plugins.plugins.map(plugin => plugin.id)).eql(['board']);
    should(io.stderr().match(/daemon restarting, retrying for up to 60s/gu)).have.length(1);
  });
});

describe('starting the daemon on a person’s first command', () => {
  it('should run the daemon found beside fy as a detached child with the world’s environment, then talk to it', async () => {
    const h = await aHome();
    const mark = join(h.home, 'started');
    await stand(h.bin, 'fyd', ': > "$FY_MARK"');
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = dead.port as number;
    await dead.stop(true);
    await recordRun(h.home, port);
    const { world } = worldIn(
      { ...h, environment: { ...h.environment, FY_MARK: mark } },
      { process: { which: () => null } },
    );
    let up: ReturnType<typeof Bun.serve> | undefined;
    const watcher = (async () => {
      for (let waited = 0; waited < 200 && !(await Bun.file(mark).exists()); waited += 1) await Bun.sleep(25);
      up = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json(HEALTH) });
    })();
    try {
      const connection = await world.connect({ asOwner: false });
      should(connection.baseUrl).equal(`http://127.0.0.1:${String(port)}`);
      should(await Bun.file(mark).exists()).be.true();
    } finally {
      await watcher;
      await up?.stop(true);
    }
  });
});

describe('the daemon verbs a person’s shell wires up', () => {
  it('should report the installed daemon beside fy and the running one the run record names', async () => {
    const h = await aHome();
    await stand(h.bin, 'fyd', 'echo 5.0.0');
    const daemon = serving();
    await recordRun(h.home, daemon.port);
    const { world, io } = worldIn(h);
    const { controller } = must(world.daemon)(NOT_ASKED);
    await controller.which({});
    should(io.stdout())
      .containEql(`installed: ${join(h.bin, 'fyd')} (`)
      .and.containEql('version 5.0.0');
    should(io.stdout()).containEql('running: pid 4242 version 5.0.0');
    should(io.stdout()).containEql('the running daemon is the installed one');
  });

  it('should print the machine shape of which and say when nothing is running', async () => {
    const h = await aHome();
    await stand(h.bin, 'fyd', 'echo 5.0.0');
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = dead.port as number;
    await dead.stop(true);
    await recordRun(h.home, port);
    const { world, io } = worldIn(h);
    await must(world.daemon)(NOT_ASKED).controller.which({ json: true });
    const shape = JSON.parse(io.stdout()) as {
      installed: { state: string; version: string };
      running: { state: string };
    };
    should(shape.installed).containEql({ state: 'found', version: '5.0.0' });
    should(shape.running).eql({ state: 'not-running' });
  });

  it('should say where the log would be when there is none yet, show it when there is, and carry a failing reader’s code', async () => {
    const h = await aHome();
    const { world, io } = worldIn(h);
    const wired = must(world.daemon)(NOT_ASKED);
    await wired.controller.logs({});
    const warning = /no .* log at (.*) yet/u.exec(io.stderr());
    const logFile = warning?.[1] ?? '';
    should(logFile).startWith(h.home);
    should(wired.exitCode()).equal(0);

    await mkdir(join(logFile, '..'), { recursive: true });
    await writeFile(logFile, 'daemon says hello\n');
    const original = process.stdout.write.bind(process.stdout);
    const chunks: Uint8Array[] = [];
    process.stdout.write = ((chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean => {
      chunks.push(chunk);
      callback?.(null);
      return true;
    }) as typeof process.stdout.write;
    try {
      await wired.controller.logs({});
    } finally {
      process.stdout.write = original;
    }
    should(Buffer.concat(chunks).toString('utf8')).equal('daemon says hello\n');
    should(wired.exitCode()).equal(0);

    await chmod(logFile, 0o000);
    try {
      await wired.controller.logs({});
    } finally {
      await chmod(logFile, 0o600);
    }
    should(wired.exitCode()).not.equal(0);
  });
});

describe('fy update, checking only', () => {
  it('should report what is installed against a version it is told, reading nothing but the running daemon', async () => {
    const h = await aHome();
    await stand(h.bin, 'fyd', 'echo 5.0.0');
    const daemon = serving();
    await recordRun(h.home, daemon.port);
    const { world, io } = worldIn(h);
    const code = await must(world.update)(
      { check: true, to: '5.1.0', json: true },
      { view: async () => await Promise.resolve(undefined) },
    );
    should(code).equal(0);
    const report = JSON.parse(io.stdout()) as { daemon: string; current: string };
    should(report.daemon).equal(join(h.bin, 'fyd'));
    should(report.current).equal('5.0.0');
    should(daemon.seen.map(request => request.path)).eql(['/healthz']);
  });
});
