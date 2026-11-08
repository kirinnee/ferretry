import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHost } from '../../../host/check.ts';
import { nodeTempDirs, type TempDirs } from '../../../host/adapters/temp-dir.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { runPluginChecks, type PluginCheckDeps } from '../../../host/check-plugins.ts';
import { bootHost, type HostOptions } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import type { WorkerHandle, WorkersPort } from '../../../contract/ports.ts';
import {
  definePlugin,
  implementDaemon,
  type DaemonImplementation,
  type PreflightFacts,
  type PreflightRun,
  type SelftestProbe,
} from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { systemClock } from '../../../host/adapters/clock.ts';

/**
 * `fyd --check`'s plugin seams (DECISIONS-2 #22, R689): pure preflight lines, bounded selftests that only `--check`
 * runs, and the kernel's own start-and-stop of every embedded worker.
 */
const facts: PreflightFacts = { home: '/h', host: '127.0.0.1', port: 9123, version: '5.0.0', platform: 'linux', arch: 'x64' };
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const plugin = (id: string, seams: { preflight?: string[]; selftest?: string[]; workers?: string[] }) =>
  definePlugin({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: [], ...seams });

function implementation(
  id: string,
  seams: {
    preflight?: Record<string, PreflightRun>;
    selftest?: Record<string, SelftestProbe>;
    workers?: Record<string, URL>;
  },
): DaemonImplementation {
  const manifest = plugin(id, {
    ...(seams.preflight === undefined ? {} : { preflight: Object.keys(seams.preflight) }),
    ...(seams.selftest === undefined ? {} : { selftest: Object.keys(seams.selftest) }),
    ...(seams.workers === undefined ? {} : { workers: Object.keys(seams.workers) }),
  });
  return { half: 'daemon', manifest, build: () => ({}) as never, ...seams } as unknown as DaemonImplementation;
}

const noWorkers: WorkersPort = {
  start: () => {
    throw new Error('no worker expected');
  },
};

function deps(implementations: DaemonImplementation[], extra: Partial<PluginCheckDeps> = {}): PluginCheckDeps {
  return {
    implementations,
    facts,
    workers: noWorkers,
    tempDirs: nodeTempDirs(),
    clock: systemClock(),
    selftestTimeoutMs: 2_000,
    workerTimeoutMs: 2_000,
    ...extra,
  };
}

async function lines(d: PluginCheckDeps): Promise<string[]> {
  const out: string[] = [];
  await runPluginChecks(d, line => out.push(line));
  return out;
}

describe('preflight: a pure half', () => {
  test('R689 a preflight line is printed under its label, in the column the kernel lines use', async () => {
    const out = await lines(deps([implementation('p', { preflight: { one: () => [{ label: 'harnesses', text: 'claude found' }] } })]));
    expect(out).toEqual(['harnesses    claude found']);
  });

  test('R689 a preflight receives only the facts the kernel passes in: no port, no function, no clock', async () => {
    let seen: unknown;
    await lines(
      deps([
        implementation('p', {
          preflight: {
            one: given => {
              seen = given;
              return [];
            },
          },
        }),
      ]),
    );
    expect(Object.keys(seen as object).sort()).toEqual(['arch', 'home', 'host', 'platform', 'port', 'version']);
    expect(Object.values(seen as object).every(value => typeof value !== 'function' && typeof value !== 'object')).toBe(true);
  });

  test('R689 a preflight that throws becomes a failed line, never a crash, and the next one still runs', async () => {
    const out = await lines(
      deps([
        implementation('p', {
          preflight: {
            bad: () => {
              throw new Error('boom');
            },
            good: () => [{ label: 'fine', text: 'ok' }],
          },
        }),
      ]),
    );
    expect(out).toEqual(['p            ! preflight bad failed — boom', 'fine         ok']);
  });

  test('R689 a preflight that returns a promise is a failed line (it must be synchronous)', async () => {
    const out = await lines(deps([implementation('p', { preflight: { late: (async () => []) as unknown as PreflightRun } })]));
    expect(out[0]).toContain('! preflight late failed — a preflight is synchronous and returned a promise');
  });

  test('R689 a preflight cannot forge a second line with a newline, nor borrow a kernel label or repeat one', async () => {
    const out = await lines(
      deps([
        implementation('p', {
          preflight: {
            forge: () => [
              { label: 'a', text: 'x\nworkers      ready' },
              { label: 'workers', text: 'housekeeping ready' },
              { label: 'a', text: 'again' },
              { label: 'address', text: 'free' },
            ],
          },
        }),
      ]),
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toBe('a            x workers      ready');
    expect(out.slice(1).every(line => line.startsWith('p            ! preflight forge returned a line'))).toBe(true);
    expect(out.every(line => !line.includes('\n'))).toBe(true);
  });
});

describe('selftest: bounded, in its own temp directory, only under --check', () => {
  test('R689 a selftest line is its label and the text the probe answered', async () => {
    const out = await lines(deps([implementation('s', { selftest: { one: { label: 'engine', run: async () => 'engine ready' } } })]));
    expect(out).toEqual(['engine       engine ready']);
  });

  test('R689 a selftest that outlives the kernel timeout is a failed line, its signal aborts and its temp dir is removed', async () => {
    let dir = '';
    let signal: AbortSignal | undefined;
    const out = await lines(
      deps(
        [
          implementation('s', {
            selftest: {
              slow: {
                label: 'slowpoke',
                run: async env => {
                  dir = env.tempDir;
                  signal = env.signal;
                  return await new Promise<string>(() => {});
                },
              },
            },
          }),
        ],
        { selftestTimeoutMs: 30 },
      ),
    );
    expect(out).toEqual(['slowpoke     ! it did not finish within 30 ms']);
    expect(signal?.aborted).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test('R689 a selftest that throws is a failed line and the temp dir is removed', async () => {
    let dir = '';
    const out = await lines(
      deps([
        implementation('s', {
          selftest: {
            bad: {
              label: 'bad',
              run: async env => {
                dir = env.tempDir;
                throw new Error('it broke');
              },
            },
          },
        }),
      ]),
    );
    expect(out).toEqual(['bad          ! it broke']);
    expect(existsSync(dir)).toBe(false);
  });

  test('R689 the temp dir is its own, exists during the run and is gone after; the probe gets only dir, signal and clock', async () => {
    let dir = '';
    let during = false;
    let keys: string[] = [];
    await lines(
      deps([
        implementation('s', {
          selftest: {
            one: {
              label: 'one',
              run: async env => {
                dir = env.tempDir;
                during = existsSync(env.tempDir) && readdirSync(env.tempDir).length === 0;
                keys = Object.keys(env).sort();
                return 'ok';
              },
            },
          },
        }),
      ]),
    );
    expect(during).toBe(true);
    expect(dir.startsWith(join(tmpdir(), 'fyd-selftest-'))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(keys).toEqual(['clock', 'signal', 'tempDir']);
  });

  test('R689 a selftest cannot repeat a label another line already took (the smoke judges `webrtc`)', async () => {
    const out = await lines(
      deps([
        implementation('a', { selftest: { one: { label: 'webrtc', run: async () => 'engine ready' } } }),
        implementation('b', { selftest: { one: { label: 'webrtc', run: async () => 'engine ready' } } }),
      ]),
    );
    expect(out[0]).toBe('webrtc       engine ready');
    expect(out[1]).toContain('! selftest one has a missing, repeated or reserved label');
  });

  test('R689 a temp dir that cannot be made is a failed line, not a crash', async () => {
    const tempDirs: TempDirs = {
      make: async () => {
        throw new Error('disk full');
      },
      remove: async () => {},
    };
    const out = await lines(deps([implementation('s', { selftest: { one: { label: 'one', run: async () => 'ok' } } })], { tempDirs }));
    expect(out).toEqual(['one          ! disk full']);
  });

  test('R689 preflights are printed before selftests, which come before the workers line', async () => {
    const worker: WorkersPort = {
      start: (): WorkerHandle => {
        let listener: ((message: unknown) => void) | undefined;
        return {
          post: () => queueMicrotask(() => listener?.({ ok: true, probe: true })),
          onMessage: given => ((listener = given), () => {}),
          onExit: () => () => {},
          terminate: async () => {},
        };
      },
    };
    const out = await lines(
      deps(
        [
          implementation('p', {
            preflight: { one: () => [{ label: 'pre', text: 'x' }] },
            selftest: { one: { label: 'self', run: async () => 'y' } },
            workers: { housekeeping: new URL('file:///w.ts') },
          }),
        ],
        { workers: worker },
      ),
    );
    expect(out.map(line => line.split(' ')[0])).toEqual(['pre', 'self', 'workers']);
  });
});

describe('workers: the kernel starts and stops each embedded worker', () => {
  function fakeWorkers(answer: (post: () => void, handle: { message: (m: unknown) => void; exit: (e: { code: number; reason?: string }) => void }) => void) {
    const started: Array<{ url: string; options: unknown }> = [];
    const terminated: string[] = [];
    const port: WorkersPort = {
      start: (url, options): WorkerHandle => {
        started.push({ url: url.href, options });
        let message: ((m: unknown) => void) | undefined;
        let exit: ((e: { code: number; reason?: string }) => void) | undefined;
        return {
          post: () => answer(() => {}, { message: m => message?.(m), exit: e => exit?.(e) }),
          onMessage: given => ((message = given), () => {}),
          onExit: given => ((exit = given), () => {}),
          terminate: async () => void terminated.push(url.href),
        };
      },
    };
    return { port, started, terminated };
  }
  const withWorkers = (workers: Record<string, URL>) => [implementation('w', { workers })];

  test('R689 every embedded worker is started with no state grant and no data, probed, and terminated: `workers … ready`', async () => {
    const { port, started, terminated } = fakeWorkers((_, h) => h.message({ ok: true, probe: true }));
    const out = await lines(
      deps(withWorkers({ housekeeping: new URL('file:///h.ts'), 'pdf-decrypt': new URL('file:///p.ts') }), { workers: port }),
    );
    expect(out).toEqual(['workers      housekeeping, pdf-decrypt ready']);
    expect(started.map(entry => entry.options)).toEqual([{ name: 'housekeeping-probe' }, { name: 'pdf-decrypt-probe' }]);
    expect(terminated).toEqual(['file:///h.ts', 'file:///p.ts']);
  });

  test('R689 a worker that never answers is `did not start`, named, within the kernel timeout, and still terminated', async () => {
    const { port, terminated } = fakeWorkers(() => {});
    const out = await lines(deps(withWorkers({ housekeeping: new URL('file:///h.ts') }), { workers: port, workerTimeoutMs: 30 }));
    expect(out).toEqual(['workers      ! housekeeping did not start — no answer within 30 ms']);
    expect(terminated).toEqual(['file:///h.ts']);
  });

  test('R689 a worker that crashes, answers wrongly or cannot be created is named with the reason', async () => {
    const crash = fakeWorkers((_, h) => h.exit({ code: 1, reason: 'ModuleNotFound\nresolving x' }));
    expect(await lines(deps(withWorkers({ a: new URL('file:///a.ts') }), { workers: crash.port }))).toEqual([
      'workers      ! a did not start — it failed: ModuleNotFound resolving x',
    ]);
    const wrong = fakeWorkers((_, h) => h.message({ nothing: true }));
    expect(await lines(deps(withWorkers({ a: new URL('file:///a.ts') }), { workers: wrong.port }))).toEqual([
      'workers      ! a did not start — it started but did not answer the probe',
    ]);
    const refused: WorkersPort = {
      start: () => {
        throw new Error('no such module');
      },
    };
    expect(await lines(deps(withWorkers({ a: new URL('file:///a.ts') }), { workers: refused }))).toEqual([
      'workers      ! a did not start — it could not be created: no such module',
    ]);
  });

  test('R689 no embedded worker means no workers line at all, so a binary that carries none is seen', async () => {
    expect(await lines(deps([implementation('none', {})]))).toEqual([]);
  });
});

describe('nothing here runs at boot, and the check changes no exit code', () => {
  test('R689 a selftest, a preflight and a worker are never run by bootHost', async () => {
    const calls: string[] = [];
    const manifest = plugin('quiet', { preflight: ['p'], selftest: ['s'], workers: ['w'] });
    const root = mkdtempSync(join(tmpdir(), 'check-plugins-boot-'));
    scratch.push(root);
    const home = join(root, 'home');
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
      workers: {
        start: () => {
          calls.push('worker');
          throw new Error('no');
        },
      },
    };
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters,
      implementations: [
        implementDaemon(manifest, {
          build: () => ({}),
          preflight: { p: () => (calls.push('preflight'), []) },
          selftest: { s: { label: 's', run: async () => (calls.push('selftest'), 'x') } },
          workers: { w: new URL('file:///w.ts') },
        }),
      ],
    });
    try {
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      await outcome.host.doctor();
    } finally {
      if (outcome.kind === 'running') await outcome.host.stop();
    }
    expect(calls).toEqual([]);
  });

  test('R689 checkHost prints the home line, then the plugin lines, and a failed plugin line leaves the exit code alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'check-plugins-host-'));
    scratch.push(root);
    const out: string[] = [];
    const code = await checkHost({
      fs: nodeFs(() => crypto.randomUUID()),
      home: join(root, 'home'),
      host: '127.0.0.1',
      port: 0,
      daemonName: 'fyd',
      probe: async () => 'free',
      alive: () => false,
      say: line => void out.push(line),
      plugins: async say => await runPluginChecks(
        deps([implementation('s', { selftest: { one: { label: 'webrtc', run: async () => { throw new Error('down'); } } } })]),
        say,
      ),
    });
    expect(code).toBe(0);
    expect(out[0]).toStartWith('state home');
    expect(out.at(-1)).toBe('webrtc       ! down');
    expect(existsSync(join(root, 'home'))).toBe(false);
  });
});
