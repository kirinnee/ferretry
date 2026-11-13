import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import should from 'should';
import { buildDaemonController } from '../../../src/adapters/daemon/control.ts';
import { buildUpdateMachine, executable, versionOf } from '../../../src/adapters/update/machine.ts';
import { StandaloneRelease } from '../../../src/adapters/update/standalone-release.ts';
import type { DaemonControlReads } from '../../../src/lib/daemon/controller.ts';
import { capturedIo } from '../../unit/fakes.ts';
import { HEALTH, standInDaemon } from '../support/stand-in-daemon.ts';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-machine-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

async function script(dir: string, name: string, body: string, mode = 0o755): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode });
  await chmod(path, mode);
  return path;
}

/** A user home with every XDG location inside it, a `bin` for stand-in executables, and a run record. */
async function aHome(port?: number): Promise<{
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly environment: Record<string, string>;
}> {
  const root = await temp();
  const home = join(root, '.ferretry');
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, 'run'), { recursive: true });
  if (port !== undefined) {
    const record = {
      format: 1,
      socket: join(home, 'run', 'fyd.sock'),
      host: '127.0.0.1',
      port,
      pid: 4242,
      version: '5.0.0',
    };
    await writeFile(join(home, 'run', 'daemon.json'), JSON.stringify(record));
  }
  return {
    root,
    home,
    bin,
    environment: {
      XDG_RUNTIME_DIR: join(root, 'runtime'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'xdg-state'),
    },
  };
}

async function deadPort(): Promise<number> {
  const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = dead.port as number;
  await dead.stop(true);
  return port;
}

describe('telling an executable from anything else, and asking it its version', () => {
  it('should call only an existing file with an execute bit executable', async () => {
    const dir = await temp();
    const runnable = await script(dir, 'runs', 'exit 0');
    const plain = await script(dir, 'plain', 'exit 0', 0o644);
    should(executable(runnable)).be.true();
    should(executable(plain)).be.false();
    should(executable(dir)).be.false();
    should(executable(join(dir, 'missing'))).be.false();
  });

  it('should read the version a command prints, and nothing when it fails or prints nothing', async () => {
    const dir = await temp();
    should(versionOf(await script(dir, 'says', 'echo " 5.0.0 "'))).equal('5.0.0');
    should(versionOf(await script(dir, 'fails', 'echo 5.0.0; exit 3'))).be.undefined();
    should(versionOf(await script(dir, 'silent', 'exit 0'))).be.undefined();
  });
});

describe('the update machine a person’s fy builds', () => {
  const view = { view: async () => await Promise.resolve(undefined) };

  async function machineIn(
    h: Awaited<ReturnType<typeof aHome>>,
    extra: { platform?: string; PATH?: string; FY_DAEMON_BIN?: string; isTty?: boolean } = {},
  ) {
    const io = capturedIo();
    const environment: Record<string, string> = { ...h.environment };
    if (extra.PATH !== undefined) environment.PATH = extra.PATH;
    if (extra.FY_DAEMON_BIN !== undefined) environment.FY_DAEMON_BIN = extra.FY_DAEMON_BIN;
    const machine = buildUpdateMachine(
      {
        environment,
        io: { ...io, isTty: extra.isTty === true },
        home: h.home,
        userHome: h.root,
        product: 'ferretry',
        clientName: 'fy',
        daemonName: 'fyd',
        binaries: ['fy', 'fyd'],
        selfPath: join(h.bin, 'fy'),
        ...(extra.platform === undefined ? {} : { platform: extra.platform }),
      },
      view,
    );
    return { io, machine };
  }

  it('should say its lines on the terminal streams and carry the exit code it is told', async () => {
    const h = await aHome();
    const { io, machine } = await machineIn(h);
    machine.deps.out.success('done');
    machine.deps.out.warn('careful');
    machine.deps.out.error('broken');
    should(io.stdout()).equal('done\n');
    should(io.stderr()).equal('careful\nbroken\n');
    should(machine.exitCode()).equal(0);
    machine.deps.out.setExitCode(3);
    should(machine.exitCode()).equal(3);
  });

  it('should be interactive only on a terminal', async () => {
    const h = await aHome();
    should((await machineIn(h)).machine.deps.interactive()).be.false();
    should((await machineIn(h, { isTty: true })).machine.deps.interactive()).be.true();
  });

  it('should ask on stderr and return the line typed', async () => {
    const h = await aHome();
    const { machine } = await machineIn(h);
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const written: string[] = [];
    stderr.on('data', chunk => written.push(String(chunk)));
    const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
    const realErr = Object.getOwnPropertyDescriptor(process, 'stderr');
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true });
    try {
      const asking = machine.deps.prompt.ask('Update now?');
      stdin.write('yes\n');
      should(await asking).equal('yes');
    } finally {
      if (realIn !== undefined) Object.defineProperty(process, 'stdin', realIn);
      if (realErr !== undefined) Object.defineProperty(process, 'stderr', realErr);
    }
    should(written.join('')).containEql('Update now? ');
  });

  it('should find the daemon beside fy first, then on PATH, and say when there is none', async () => {
    const h = await aHome();
    const beside = await script(h.bin, 'fyd', 'echo 5.0.0');
    const elsewhere = await temp();
    const onPath = await script(elsewhere, 'fyd', 'echo 4.9.0');
    const first = await machineIn(h, { PATH: elsewhere });
    should(first.machine.deps.lifecycle.installed()).containEql({ path: beside, version: '5.0.0' });
    await rm(beside);
    const second = await machineIn(h, { PATH: elsewhere });
    should(second.machine.deps.lifecycle.installed()).containEql({ path: onPath, version: '4.9.0' });
    const third = await machineIn(h, { PATH: await temp() });
    should(() => third.machine.deps.lifecycle.installed()).throw(/cannot find fyd on PATH/u);
  });

  it('should read the running daemon from the address its run record names, and nothing when it is down, unwell or unrecorded', async () => {
    const serving = standInDaemon(() => Response.json({ ...HEALTH, pid: 4242 }));
    const up = await machineIn(await aHome(serving.port));
    should(await up.machine.deps.lifecycle.probe()).containEql({ version: '5.0.0' });
    should(serving.seen.map(request => request.path)).eql(['/healthz']);

    const unwell = standInDaemon(() => new Response('', { status: 503 }));
    should(await (await machineIn(await aHome(unwell.port))).machine.deps.lifecycle.probe()).be.undefined();

    const garbled = standInDaemon(() => Response.json({ nope: true }));
    should(await (await machineIn(await aHome(garbled.port))).machine.deps.lifecycle.probe()).be.undefined();

    should(await (await machineIn(await aHome(await deadPort()))).machine.deps.lifecycle.probe()).be.undefined();
  });

  it('should write an update report privately, creating the folder it goes in', async () => {
    const h = await aHome();
    const { machine } = await machineIn(h);
    const path = join(h.root, 'reports', 'deep', 'update.json');
    await machine.deps.reports.writePrivate(path, '{"outcome":"failed"}\n');
    should(await readFile(path, 'utf8')).equal('{"outcome":"failed"}\n');
    should(((await stat(path)).mode & 0o777).toString(8)).equal('600');
  });

  it('should drive the service manager of whichever platform it is told it is on', async () => {
    const h = await aHome();
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      const { machine } = await machineIn(h, { platform });
      should(machine.deps.facts).be.ok();
    }
  });

  it('should pick the release asset of the platform it is told it is on, not the host’s own', async () => {
    const h = await aHome();
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      const { machine } = await machineIn(h, { platform });
      should(machine.deps.standalone).be.instanceOf(StandaloneRelease);
      // The options are private to the adapter and no signing key is compiled in yet, so a refusal cannot show them.
      const options = (machine.deps.standalone as unknown as { options: { platform: string } }).options;
      should(options.platform).equal(platform);
    }
  });
});

describe('the daemon controller a person’s fy builds', () => {
  const reads: DaemonControlReads = {
    resetInventory: { count: async () => await Promise.resolve(undefined) },
    turns: { midTurn: async () => await Promise.resolve(0) },
  };

  async function controllerIn(h: Awaited<ReturnType<typeof aHome>>, extra: { platform?: string; PATH?: string } = {}) {
    const io = capturedIo();
    const environment: Record<string, string> = { ...h.environment };
    if (extra.PATH !== undefined) environment.PATH = extra.PATH;
    const built = buildDaemonController(
      {
        environment,
        io,
        home: h.home,
        userHome: h.root,
        product: 'ferretry',
        clientName: 'fy',
        daemonName: 'fyd',
        selfPath: join(h.bin, 'fy'),
        launch: async () => await Promise.resolve({ started: false, why: 'a test starts no daemon' }),
        ...(extra.platform === undefined ? {} : { platform: extra.platform }),
      },
      reads,
    );
    return { io, ...built };
  }

  it('should refuse a restart into a folder that is not a Ferretry home, before any daemon is started', async () => {
    const h = await aHome(await deadPort());
    await script(h.bin, 'fyd', 'echo 5.0.0');
    await writeFile(join(h.home, 'stray.txt'), 'somebody else’s files');
    const { controller } = await controllerIn(h);
    await should(controller.restart({ midTurnSaid: true })).rejectedWith(
      /is not empty and has no home\.json.*reinstall 4.291.10 or later/s,
    );
  });

  it('should find the daemon on PATH when none sits beside fy', async () => {
    const h = await aHome(await deadPort());
    const elsewhere = await temp();
    const onPath = await script(elsewhere, 'fyd', 'echo 4.9.0');
    const { controller, io } = await controllerIn(h, { PATH: elsewhere });
    await controller.which({});
    should(io.stdout()).containEql(`installed: ${onPath} (`).and.containEql('version 4.9.0');
  });

  it('should build for each platform’s service manager, and for one that has none', async () => {
    const h = await aHome();
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      const { controller } = await controllerIn(h, { platform });
      should(controller).be.ok();
    }
  });
});

describe('restarting the daemon from an update, into a folder that is not a format-1 home', () => {
  it('should refuse before any daemon is started, because the home carries no home.json', async () => {
    const root = await temp();
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    await script(bin, 'fyd', 'echo 5.0.0');
    const home = join(root, '.ferretry');
    await mkdir(join(home, 'run'), { recursive: true });
    const record = {
      format: 1,
      socket: join(home, 'run', 'fyd.sock'),
      host: '127.0.0.1',
      port: await deadPort(),
      pid: 4242,
      version: '5.0.0',
    };
    await writeFile(join(home, 'run', 'daemon.json'), JSON.stringify(record));
    const io = capturedIo();
    const machine = buildUpdateMachine(
      {
        environment: {
          XDG_RUNTIME_DIR: join(root, 'runtime'),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_STATE_HOME: join(root, 'xdg-state'),
        },
        io,
        home,
        userHome: root,
        product: 'ferretry',
        clientName: 'fy',
        daemonName: 'fyd',
        binaries: ['fy', 'fyd'],
        selfPath: join(bin, 'fy'),
      },
      { view: async () => await Promise.resolve(undefined) },
    );
    await should(machine.deps.lifecycle.restart()).rejectedWith(/has no home.json.*reinstall 4.291.10 or later/s);
    should(io.stderr()).containEql('fyd was not running; starting it');
  });
});
