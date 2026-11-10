import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL } from '@ferretry/kernel/contract';
import { defineState } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { type CliContext, definePlugin, implementCli, type Manifest, route, verb } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import should from 'should';
import { createPluginHost } from '../../src/adapters/plugin-host.ts';
import { registry } from '../../src/generated/commands.ts';
import { runFy } from '../../src/lib/run.ts';
import { entry, fakeWorld, inventoryOf, registryOf } from './fakes.ts';

const SCOPE = { minimum: 'authenticated', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const OWN = defineState({ name: 'notes', path: 'notes/*', store: 'opaque', format: 1 });
const ANOTHER_PLUGINS = defineState({ name: 'theirs', path: 'theirs/*', store: 'opaque', format: 1 });

/** A plugin that declares one opaque tree of its own and one verb that records the whole context it was built with. */
const probeManifest = definePlugin({
  id: 'probe',
  title: 'Probe',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  actions: { routes: [route('GET /v1/probe', { ...SCOPE, caller: 'any' })], cli: [verb('probe')] },
  data: { state: [OWN] },
});

function recordingProbe(): { half: ReturnType<typeof entry>; context: () => CliContext<Manifest> } {
  let seen: CliContext<Manifest> | undefined;
  const half = entry(
    probeManifest,
    'h-probe',
    implementCli(probeManifest, {
      build: ctx => {
        seen = ctx as CliContext<Manifest>;
        return { verbs: { probe: async () => 0 } };
      },
    }),
  );
  return {
    half,
    context: () => {
      if (seen === undefined) throw new Error('the probe half was never built');
      return seen;
    },
  };
}

const binaryFiles: Record<string, Uint8Array> = {
  '/work/shot.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
};

function worldWithProbe(environment: Record<string, string | undefined> = {}) {
  const disk = state.createMemoryHostFs();
  const files: Record<string, string> = { '/work/recipe.txt': 'open the page' };
  const host = createPluginHost({
    home: '/h',
    fs: disk,
    readFile: async path => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file ${path}`);
      return text;
    },
    readBytes: async path => {
      const bytes = binaryFiles[path];
      if (bytes === undefined) throw new Error(`no such file ${path}`);
      return bytes;
    },
    readStdinBytes: async () => new Uint8Array([7, 8, 9]),
    readStdin: async () => 'typed on stdin',
    cwd: () => '/work',
  });
  const probe = recordingProbe();
  const made = fakeWorld({
    registry: registryOf(probe.half),
    inventory: inventoryOf({ id: 'probe', contract: 'h-probe' }),
    environment,
    host,
  });
  return { ...made, disk, probe };
}

/** A working ferret as the daemon answers `GET /v1/ferrets/:id`. */
const sessionView = (overrides: { id?: string; name?: string } = {}) => ({
  id: overrides.id ?? 'lead',
  name: overrides.name ?? 'wren',
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  runtime: 'claude-alpha',
  folder: '/work/repo',
  state: 'working',
  createdAt: '2026-11-06T09:00:00.000Z',
  stateAt: '2026-11-06T09:00:00.000Z',
});

/** Folders a test made under the real temp directory; every one goes in `afterEach`. */
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('the context every plugin cli half is handed', () => {
  it('should hand every half a clock, a sleep, a reader, an environment and its own state', async () => {
    const { world, probe } = worldWithProbe();
    should(await runFy(['probe'], world)).equal(0);
    const ctx = probe.context();
    should(ctx.clock).be.ok();
    should(ctx.sleep).be.a.Function();
    should(ctx.readText).be.a.Function();
    should(ctx.readBytes).be.a.Function();
    should(ctx.env).be.an.Object();
    should(ctx.ownState).be.ok();
  });

  it('should give a clock that reads the time', async () => {
    const { world, probe } = worldWithProbe();
    await runFy(['probe'], world);
    const { clock } = probe.context();
    const before = Date.now();
    should(clock?.nowMs() ?? 0).be.aboveOrEqual(before);
    should(Date.parse(clock?.now() ?? '')).be.aboveOrEqual(before);
  });

  it('should give a sleep that waits and that ends early when its signal aborts', async () => {
    const { world, probe } = worldWithProbe();
    await runFy(['probe'], world);
    const { sleep, clock } = probe.context();
    const started = clock?.nowMs() ?? 0;
    await sleep?.(milliseconds(20));
    should((clock?.nowMs() ?? 0) - started).be.aboveOrEqual(15);

    const stop = new AbortController();
    const waiting = sleep?.(milliseconds(60_000), stop.signal) ?? Promise.resolve();
    stop.abort(new Error('stopped'));
    await waiting.then(
      () => should.fail(undefined, undefined, 'the sleep should have ended with the abort'),
      (reason: unknown) => should((reason as Error).message).equal('stopped'),
    );
    should((clock?.nowMs() ?? 0) - started).be.below(5_000);
  });

  it('should read a file by path and standard input for -, with no size cap', async () => {
    const { world, probe } = worldWithProbe();
    await runFy(['probe'], world);
    const { readText } = probe.context();
    should(await readText?.('/work/recipe.txt')).equal('open the page');
    should(await readText?.('-')).equal('typed on stdin');
    await Promise.resolve(readText?.('/work/missing.txt')).then(
      () => should.fail(undefined, undefined, 'a missing file should be refused'),
      (reason: unknown) => should((reason as Error).message).containEql('no such file'),
    );
  });

  it('should read the raw bytes of a file by path and of standard input for -, undecoded (an attachment is bytes)', async () => {
    const { world, probe } = worldWithProbe();
    await runFy(['probe'], world);
    const { readBytes } = probe.context();
    should([...((await readBytes?.('/work/shot.png')) ?? [])]).eql([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    should([...((await readBytes?.('-')) ?? [])]).eql([7, 8, 9]);
    await Promise.resolve(readBytes?.('/work/missing.png')).then(
      () => should.fail(undefined, undefined, 'a missing file should be refused'),
      (reason: unknown) => should((reason as Error).message).containEql('no such file'),
    );
  });

  it('should read a real file relative to the working directory by default (today’s readRecipe)', async () => {
    const real = createPluginHost({ home: '/h', fs: state.createMemoryHostFs() });
    const dir = await mkdtemp(join(tmpdir(), 'fy-context-'));
    scratch.push(dir);
    await Bun.write(`${dir}/recipe.txt`, 'a'.repeat(10_000));
    should((await real.readText(`${dir}/recipe.txt`)).length).equal(10_000);
  });

  it('should give a half an existence probe resolved against the working directory (today’s existsSync)', async () => {
    const asked: string[] = [];
    const host = createPluginHost({
      home: '/h',
      fs: state.createMemoryHostFs(),
      cwd: () => '/work',
      pathExists: async absolute => {
        asked.push(absolute);
        return absolute === '/work/out' || absolute === '/work/-';
      },
    });
    should(await host.exists('out/')).be.true();
    should(await host.exists('-')).be.true();
    should(await host.exists('/abs/missing')).be.false();
    should(asked).deepEqual(['/work/out', '/work/-', '/abs/missing']);
  });

  it('should count a real directory and a real unreadable-content file as existing, and an absent path as not', async () => {
    const real = createPluginHost({ home: '/h', fs: state.createMemoryHostFs() });
    const dir = await mkdtemp(join(tmpdir(), 'fy-exists-'));
    scratch.push(dir);
    await Bun.write(`${dir}/marker.txt`, 'x');
    await chmod(`${dir}/marker.txt`, 0o000);
    should(await real.exists(dir)).be.true();
    should(await real.exists(`${dir}/marker.txt`)).be.true();
    should(await real.exists(`${dir}/absent`)).be.false();
  });

  it('should hand a half the real working directory as PWD, not a stale inherited one', async () => {
    const { world, probe } = worldWithProbe({ PWD: '/stale/inherited' });
    await runFy(['probe'], world);
    should(probe.context().env?.PWD).equal('/work');
    should(world.host.cwd()).equal('/work');
  });

  it('should default the working directory to the process’s own', () => {
    should(createPluginHost({ home: '/h', fs: state.createMemoryHostFs() }).cwd()).equal(process.cwd());
  });

  it('should give a default fake host that reads neither the real disk nor the real stdin', async () => {
    const { world } = fakeWorld();
    await world.host.readText('/etc/hostname').then(
      () => should.fail(undefined, undefined, 'the default fake must not read the disk'),
      (reason: unknown) => should((reason as Error).message).containEql('reads no real file'),
    );
    await world.host.readBytes('/etc/hostname').then(
      () => should.fail(undefined, undefined, 'the default fake must not read the disk as bytes'),
      (reason: unknown) => should((reason as Error).message).containEql('reads no real file'),
    );
    await world.host.readText('-').then(
      () => should.fail(undefined, undefined, 'the default fake must not read stdin'),
      (reason: unknown) => should((reason as Error).message).containEql('reads no real standard input'),
    );
  });

  it('should hand a half FY_SESSION_ID and the allowed names, and nothing else of the process environment', async () => {
    const { world, probe } = worldWithProbe({
      FY_SESSION_ID: 'ferret-1',
      FY_HYPERMEDIA: '1',
      PWD: '/stale/inherited',
      FY_TOKEN: 'admin-secret',
      FY_SESSION_TOKEN: 'fys_secret',
      FY_SESSION_BOARD_CAPABILITY: 'fys_secret2',
      FY_HOME: '/home/someone/.ferretry',
      HOME: '/home/someone',
      AWS_SECRET_ACCESS_KEY: 'nope',
    });
    await runFy(['probe'], world);
    const { env } = probe.context();
    should({ ...env }).deepEqual({ FY_SESSION_ID: 'ferret-1', FY_HYPERMEDIA: '1', PWD: '/work' });
    should(env?.FY_TOKEN).be.undefined();
    should(env?.FY_SESSION_TOKEN).be.undefined();
  });

  it('should let a half write only its own declared state and refuse another plugin’s', async () => {
    const { world, probe, disk } = worldWithProbe();
    await runFy(['probe'], world);
    const own = probe.context().ownState;
    if (own === undefined) throw new Error('ownState is handed');

    await own.write(OWN, 'mine', 'a.txt');
    should(disk.snapshot().get('/h/state/probe/notes/a.txt')).equal('mine');
    should(own.pathOf(OWN, 'a.txt')).equal('/h/state/probe/notes/a.txt');

    await own.write(ANOTHER_PLUGINS, 'not yours', 'a.txt').then(
      () => should.fail(undefined, undefined, 'another plugin’s file should be refused'),
      (reason: unknown) => should((reason as Error).message).containEql('did not declare'),
    );
    should([...disk.snapshot().keys()].filter(path => path.includes('theirs'))).deepEqual([]);
  });

  it('should scope each plugin’s state to its own folder', async () => {
    const { world, probe, disk } = worldWithProbe();
    await runFy(['probe'], world);
    const other = definePlugin({ ...probeManifest, id: 'other', title: 'Other' });
    const otherState = world.host.ownState(other);
    // `other` declares `notes` too (same def), so it works, but under ITS folder, never the probe's.
    await otherState.write(OWN, 'theirs', 'a.txt');
    should(disk.snapshot().get('/h/state/other/notes/a.txt')).equal('theirs');
    should(disk.snapshot().get('/h/state/probe/notes/a.txt')).be.undefined();
    void probe;
  });
});

describe('verbs that failed in the real binary for want of a context field', () => {
  /** The real ferrets half, through the generated registry, over a fake daemon and a fake clock that sleeps instantly. */
  function ferretsWorld(options: {
    environment?: Record<string, string>;
    ferret?: ReturnType<typeof sessionView>;
    /** The files that exist; any other path is absent (ENOENT), as on a real disk. */
    files?: readonly string[];
  }) {
    let time = 1_000;
    const probed: string[] = [];
    const host = createPluginHost({
      home: '/h',
      fs: state.createMemoryHostFs(),
      cwd: () => '/work',
      readFile: async path => {
        throw new Error(`a marker poll must never read a file (${path})`);
      },
      pathExists: async path => {
        probed.push(path);
        return options.files?.includes(path) === true;
      },
      readStdin: async () => {
        throw new Error('a marker poll must never read standard input');
      },
    });
    const fast = {
      ...host,
      clock: { now: host.clock.now, nowMs: () => time },
      // A deadline (it carries a signal) never fires by itself; a poll's sleep moves the fake time on.
      sleep: async (delay: number, signal?: AbortSignal) => {
        if (signal === undefined) {
          time += Number(delay);
          return;
        }
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    };
    const made = fakeWorld({
      registry,
      inventory: {
        protocol: PROTOCOL,
        plugins: [
          { id: 'kernel', on: true, contract: registry.kernel.contract },
          ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
        ],
      },
      environment: options.environment ?? {},
      host: fast as typeof host,
    });
    if (options.ferret !== undefined) made.transport.replies.push({ status: 200, body: options.ferret });
    return { ...made, probed };
  }

  it('V-0496 fy wait needs the clock and the sleep: it ends 124 on its timeout instead of refusing', async () => {
    const { world, io, transport } = ferretsWorld({ ferret: sessionView({ id: 'lead', name: 'wren' }) });
    transport.replies.push(...Array.from({ length: 20 }, () => ({ status: 200, body: sessionView({ name: 'wren' }) })));
    const code = await runFy(['wait', 'wren', '--timeout', '2'], world);
    should(io.stderr()).equal('fy wait: gave up while the ferret was still working');
    should(code).equal(124);
    should(transport.sent[0]?.path).containEql('/v1/ferrets/');
  });

  it('V-0496 fy wait --until-marker needs the existence check: a present marker settles the wait with 0', async () => {
    const { world, io, transport, probed } = ferretsWorld({
      ferret: sessionView({ id: 'lead', name: 'wren' }),
      files: ['/work/done'],
    });
    transport.replies.push(...Array.from({ length: 3 }, () => ({ status: 200, body: sessionView({ name: 'wren' }) })));
    const code = await runFy(['wait', 'wren', '--until-marker', '/work/done'], world);
    should(io.stderr()).equal('');
    should(code).equal(0);
    should(probed).containEql('/work/done');
  });

  it('V-0496 fy wait --until-marker: an ABSENT marker is not a present one, so the wait keeps going to its timeout', async () => {
    const { world, io, transport, probed } = ferretsWorld({
      ferret: sessionView({ id: 'lead', name: 'wren' }),
      files: [],
    });
    transport.replies.push(...Array.from({ length: 20 }, () => ({ status: 200, body: sessionView({ name: 'wren' }) })));
    const code = await runFy(['wait', 'wren', '--until-marker', '/work/done', '--timeout', '2'], world);
    should(code).equal(124);
    should(io.stderr()).containEql('gave up');
    should(probed).containEql('/work/done');
  });

  it('V-0496 fy wait --until-marker - names a file called -: it is probed in the working directory, stdin is never read', async () => {
    const { world, io, transport, probed } = ferretsWorld({
      ferret: sessionView({ id: 'lead', name: 'wren' }),
      files: ['/work/-'],
    });
    transport.replies.push(...Array.from({ length: 3 }, () => ({ status: 200, body: sessionView({ name: 'wren' }) })));
    const code = await runFy(['wait', 'wren', '--until-marker', '-'], world);
    should(code).equal(0);
    should(io.stderr()).equal('');
    should(probed).deepEqual(['/work/-']);
  });

  it('V-0496 fy wait --until-marker counts a directory as present (today’s existsSync) and never reads it', async () => {
    const { world, transport, probed } = ferretsWorld({
      ferret: sessionView({ id: 'lead', name: 'wren' }),
      files: ['/work/out'],
    });
    transport.replies.push(...Array.from({ length: 3 }, () => ({ status: 200, body: sessionView({ name: 'wren' }) })));
    should(await runFy(['wait', 'wren', '--until-marker', 'out/'], world)).equal(0);
    should(probed).deepEqual(['/work/out']);
  });

  it('V-0290 fy instructions needs the environment: it reports the ferret and the switches it launched with', async () => {
    const { world, io } = ferretsWorld({
      environment: {
        FY_SESSION_ID: 'wren',
        FY_SESSION_MODE: 'auto',
        FY_HYPERMEDIA: '1',
        FY_PACK: '1',
        FY_TOKEN: 'secret',
      },
    });
    const code = await runFy(['instructions', '--json'], world);
    should(code).equal(0);
    const report = JSON.parse(io.stdout()) as {
      inFerret: boolean;
      sessionId: string;
      mode: string;
      sections: { id: string; on: boolean }[];
    };
    should(report.inFerret).equal(true);
    should(report.sessionId).equal('wren');
    should(report.mode).equal('auto');
    should(report.sections.find(section => section.id === 'hypermedia')?.on).equal(true);
    should(report.sections.find(section => section.id === 'agenda')?.on).equal(false);
    should(io.stdout()).not.containEql('secret');
  });
});
