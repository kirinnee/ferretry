/**
 * `SelftestProbe.enabledBy` (kernel batch #14, R689's `--check` parity): the KERNEL reads the plugin's own config as
 * in effect, calls the pure `on`, and on an exact `false` prints today's `<label> switched off in <path>` line without
 * running the probe. It fails toward checking: a broken file, a throwing or non-boolean `on`, or no reader runs it.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type ConfigDef, defineConfig } from '../../../contract/define.ts';
import type { SpawnPort, WorkersPort } from '../../../contract/ports.ts';
import { inEffectConfigReader, type SelftestConfigReader } from '../../../host/check-config.ts';
import { runPluginChecks, type PluginCheckDeps } from '../../../host/check-plugins.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { nodeTempDirs } from '../../../host/adapters/temp-dir.ts';
import { systemClock } from '../../../host/adapters/clock.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { definePlugin, type DaemonImplementation, type SelftestProbe } from '../../../manifest/index.ts';
import { captureLog, manualClock } from '../host-config/support.ts';

const HOME = '/home/fy';

/** Connections' shape, cut down: switching WebRTC back on loosens. */
const switchDef = defineConfig({
  file: 'connections.yaml',
  schema: z.strictObject({
    webrtc: z.strictObject({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  }),
  axis: 'configure',
  loosens: (before, after) =>
    after.webrtc.enabled && before?.webrtc.enabled === false ? ['switches peer-to-peer connections back on'] : [],
});
const otherDef = defineConfig({
  file: 'connections.yaml',
  schema: z.strictObject({ webrtc: z.strictObject({ enabled: z.boolean() }) }),
  axis: 'configure',
  loosens: () => [],
});
const collectionDef = defineConfig({
  collection: 'carriers',
  name: /^[a-z]+$/,
  schema: z.strictObject({ enabled: z.boolean() }),
  axis: 'configure',
  loosens: () => [],
});

const on = (value: unknown): boolean => (value as { webrtc: { enabled: boolean } }).webrtc.enabled;
const CONSEQUENCE = 'devices reach this daemon directly or through the relay instead';

function connections(probe: SelftestProbe, config: readonly ConfigDef[] = [switchDef as ConfigDef]) {
  const manifest = definePlugin({
    id: 'connections',
    title: 'Connections',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    selftest: ['engine'],
    data: { config },
  });
  return {
    half: 'daemon',
    manifest,
    build: () => ({}),
    selftest: { engine: probe },
  } as unknown as DaemonImplementation;
}

const noWorkers: WorkersPort = {
  start: () => {
    throw new Error('no worker expected');
  },
};

function deps(implementation: DaemonImplementation, extra: Partial<PluginCheckDeps> = {}): PluginCheckDeps {
  return {
    implementations: [implementation],
    facts: { home: HOME, host: '127.0.0.1', port: 9123, version: '5.0.0', platform: 'linux', arch: 'x64' },
    workers: noWorkers,
    tempDirs: nodeTempDirs('/not-the-state-home'),
    clock: systemClock(),
    selftestTimeoutMs: 2_000,
    ...extra,
  };
}

const reading = (value: unknown): SelftestConfigReader => ({ inEffect: async () => value });

/** A probe that counts its runs and sees what it was handed. */
function probe(enabledBy?: SelftestProbe['enabledBy']) {
  const runs: string[][] = [];
  const spec: SelftestProbe = {
    label: 'engine',
    ...(enabledBy === undefined ? {} : { enabledBy }),
    run: async environment => {
      runs.push(Object.keys(environment).sort());
      return 'engine ready';
    },
  };
  return { spec, runs };
}

async function lines(d: PluginCheckDeps): Promise<string[]> {
  const out: string[] = [];
  await runPluginChecks(d, line => out.push(line));
  return out;
}

describe('R689 enabledBy: the kernel decides whether the probe runs', () => {
  test('R689 off: the switched-off line names the file, and the probe never runs', async () => {
    const p = probe({ def: switchDef, on, consequence: CONSEQUENCE });
    const out = await lines(deps(connections(p.spec), { config: reading({ webrtc: { enabled: false } }) }));
    expect(out).toEqual([`engine       switched off in ${HOME}/config/connections.yaml — ${CONSEQUENCE}`]);
    expect(p.runs).toEqual([]);
  });

  test('R689 off with no consequence: the line ends at the path', async () => {
    const p = probe({ def: switchDef, on });
    const out = await lines(deps(connections(p.spec), { config: reading({ webrtc: { enabled: false } }) }));
    expect(out).toEqual([`engine       switched off in ${HOME}/config/connections.yaml`]);
  });

  test('R689 on: the probe runs, handed only what it is handed without enabledBy', async () => {
    const p = probe({ def: switchDef, on });
    const plain = probe();
    const out = await lines(deps(connections(p.spec), { config: reading({ webrtc: { enabled: true } }) }));
    await lines(deps(connections(plain.spec), { config: reading({ webrtc: { enabled: true } }) }));
    expect(out).toEqual(['engine       engine ready']);
    expect(p.runs).toEqual([['clock', 'signal', 'tempDir']]);
    expect(p.runs).toEqual(plain.runs);
  });

  test('R689 a broken file with nothing in effect runs the probe, and on is never asked', async () => {
    let asked = 0;
    const p = probe({
      def: switchDef,
      on: value => {
        asked += 1;
        return on(value);
      },
    });
    const out = await lines(deps(connections(p.spec), { config: reading(undefined) }));
    expect(out).toEqual(['engine       engine ready']);
    expect(asked).toBe(0);
  });

  test('R689 on throwing, or answering anything but a boolean, runs the probe', async () => {
    for (const judge of [
      () => {
        throw new Error('boom');
      },
      () => 'no' as unknown as boolean,
      () => 0 as unknown as boolean,
      () => undefined as unknown as boolean,
    ]) {
      const p = probe({ def: switchDef, on: judge });
      expect(await lines(deps(connections(p.spec), { config: reading({ webrtc: { enabled: false } }) }))).toEqual([
        'engine       engine ready',
      ]);
      expect(p.runs).toHaveLength(1);
    }
  });

  test('R689 a reader that throws, or no reader at all, runs the probe', async () => {
    const failing: SelftestConfigReader = {
      inEffect: async () => {
        throw new Error('disk');
      },
    };
    for (const extra of [{ config: failing }, {}]) {
      const p = probe({ def: switchDef, on: () => false });
      expect(await lines(deps(connections(p.spec), extra))).toEqual(['engine       engine ready']);
    }
  });

  test("R689 another plugin's def, even one at the same path, is a failed line and the probe does not run", async () => {
    const p = probe({ def: otherDef, on: () => false });
    const out = await lines(deps(connections(p.spec), { config: reading({ webrtc: { enabled: false } }) }));
    expect(out).toEqual([
      'plugin       ! connections selftest engine is switched by a config file that is not one of its own declared files',
    ]);
    expect(p.runs).toEqual([]);
  });

  test('R689 a collection def, even one the plugin declares, is a failed line', async () => {
    const p = probe({ def: collectionDef as never, on: () => false });
    const out = await lines(
      deps(connections(p.spec, [switchDef as ConfigDef, collectionDef as ConfigDef]), { config: reading({}) }),
    );
    expect(out[0]).toContain('is switched by a config file that is not one of its own declared files');
    expect(p.runs).toEqual([]);
  });

  test('R689 the reader is asked for the plugin by its manifest id and its own def', async () => {
    const asked: [string, unknown][] = [];
    const p = probe({ def: switchDef, on });
    await lines(
      deps(connections(p.spec), {
        config: {
          inEffect: async (plugin, def) => {
            asked.push([plugin, def]);
            return { webrtc: { enabled: true } };
          },
        },
      }),
    );
    expect(asked).toEqual([['connections', switchDef]]);
  });

  test('R689 a host selftest cannot start a detached child: its spawn refuses detached', async () => {
    const base: SpawnPort = {
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      runBytes: async () => {
        throw new Error('unused');
      },
      start: () => {
        throw new Error('the adapter was reached');
      },
    };
    const manifest = definePlugin({
      id: 'b',
      title: 'b',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      selftest: ['s'],
      permissions: { spawn: ['xdg-open'], detached: ['xdg-open'] },
    });
    const implementation = {
      half: 'daemon',
      manifest,
      build: () => ({}),
      selftest: {
        s: {
          label: 'opener',
          host: true,
          run: async ({ spawn }: { spawn?: SpawnPort }) => {
            spawn?.start('xdg-open', [], { detached: true });
            return 'started';
          },
        },
      },
    } as unknown as DaemonImplementation;
    expect(await lines(deps(implementation, { spawn: base }))).toEqual([
      'opener       ! b may not start xdg-open detached through this port.',
    ]);
  });
});

describe('R689 the read-only in-effect reader (boot’s rule, nothing written)', () => {
  function home() {
    const fs = createMemoryHostFs();
    const reader = inEffectConfigReader({ home: HOME, fs, binary: 'fy' });
    const service = () =>
      createConfigFiles({
        home: HOME,
        fs,
        clock: manualClock(),
        log: captureLog(),
        binary: 'fy',
        defs: [{ plugin: 'connections', def: switchDef }],
      });
    const write = (text: string) => fs.seed(`${HOME}/config/connections.yaml`, text);
    return { fs, reader, service, write };
  }

  test('no file: the schema defaults', async () => {
    const h = home();
    expect(await h.reader.inEffect('connections', switchDef)).toEqual({ webrtc: { enabled: true } });
  });

  test('a valid file never loaded before: its value', async () => {
    const h = home();
    h.write('webrtc:\n  enabled: false\n');
    expect(await h.reader.inEffect('connections', switchDef)).toEqual({ webrtc: { enabled: false } });
  });

  test('a broken file with no last good version: nothing in effect', async () => {
    const h = home();
    h.write('webrtc: [unclosed\n');
    expect(await h.reader.inEffect('connections', switchDef)).toBeUndefined();
    h.write('webrtc:\n  enabled: maybe\n');
    expect(await h.reader.inEffect('connections', switchDef)).toBeUndefined();
  });

  test('a broken file keeps its last good version, as boot does', async () => {
    const h = home();
    h.write('webrtc:\n  enabled: false\n');
    await h.service().reload();
    h.write('webrtc: [unclosed\n');
    expect(await h.reader.inEffect('connections', switchDef)).toEqual({ webrtc: { enabled: false } });
  });

  test('a loosening edit nobody confirmed is held: the tighter version is the answer', async () => {
    const h = home();
    h.write('webrtc:\n  enabled: false\n');
    await h.service().reload();
    h.write('webrtc:\n  enabled: true\n');
    expect(await h.reader.inEffect('connections', switchDef)).toEqual({ webrtc: { enabled: false } });
  });

  test("a record accepted for another plugin at that path is not this plugin's last good version", async () => {
    const h = home();
    h.write('webrtc:\n  enabled: false\n');
    await h.service().reload();
    h.write('webrtc: [unclosed\n');
    expect(await h.reader.inEffect('stranger', switchDef)).toBeUndefined();
  });

  test('reading writes nothing: no file, no record, no folder', async () => {
    const h = home();
    h.write('webrtc:\n  enabled: false\n');
    const before = [...h.fs.snapshot()];
    const folders = [...h.fs.directoryModes()];
    await h.reader.inEffect('connections', switchDef);
    h.write('webrtc: [unclosed\n');
    await h.reader.inEffect('connections', switchDef);
    h.write('webrtc:\n  enabled: false\n');
    expect([...h.fs.snapshot()]).toEqual(before);
    expect([...h.fs.directoryModes()]).toEqual(folders);
  });
});
