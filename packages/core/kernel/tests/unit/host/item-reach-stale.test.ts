/**
 * K1 revocation is not delayed and never fails open (fix round 1, HIGH-1): the kernel reads the owner's collection
 * when a call is made, so an item the in-effect version no longer holds is refused on the very next check — while the
 * reload that dropped it is still running, and when that reload then fails. The union with the installed data plugins'
 * items is proven on the real wiring beside a config item.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { defineConfig, neverLoosens } from '../../../contract/index.ts';
import type { FetchPort, KernelPorts, SpawnPort } from '../../../contract/ports.ts';
import { createNodeHostFs } from '../../../host/state/index.ts';
import { bootHost } from '../../../host/host.ts';
import { scopedLog } from '../../../host/log.ts';
import { configService, realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const ITEMS = defineConfig({
  collection: 'mcp',
  itemKind: 'mcp',
  name: /^[a-z][a-z0-9-]*$/,
  schema: z.object({ command: z.string().optional(), url: z.string().optional() }),
  axis: 'configure',
  loosens: neverLoosens,
});

const stubSpawn = (): SpawnPort => ({
  run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
  runBytes: async () => {
    throw new Error('not run here');
  },
  start: () => {
    throw new Error('not started here');
  },
});
const stubFetch: FetchPort = { request: async () => new Response('') };

/** What the test does to the scan of the config folder (the one `await` between the edit and the change notice). */
interface Control {
  failRootList: boolean;
  gate?: Promise<void>;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Boots the owner over `home`. While `evil.yaml` is gone, a listing of `config/` waits on `gate` and/or throws. */
async function bootOwner(home: string, control: Control) {
  const base = createNodeHostFs();
  const wrapped = new Proxy(base, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'list') return typeof value === 'function' ? value.bind(target) : value;
      return async (path: string, ...rest: unknown[]) => {
        if (path === `${home}/config` && !(await exists(`${home}/config/mcp/evil.yaml`))) {
          if (control.gate !== undefined) await control.gate;
          if (control.failRootList) throw new Error('EMFILE: too many open files');
        }
        return await (value as (...a: unknown[]) => Promise<unknown>).call(target, path, ...rest);
      };
    },
  });
  const seen: { ports?: KernelPorts } = {};
  const adapters = realAdapters(home, () => undefined, { binary: 'fy' });
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...adapters,
      config: configService(
        home,
        wrapped,
        fixedClock(),
        scopedLog(() => undefined, 'kernel'),
        'fy',
      ),
      spawn: stubSpawn(),
      fetch: stubFetch,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(
        definePlugin({
          id: 'mcp',
          title: 'MCP',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: ['item'],
          data: { config: [ITEMS] },
          permissions: { spawn: [{ items: 'mcp' }], network: [{ items: 'mcp' }] },
        }),
        {
          build: ({ kernel }) => {
            seen.ports = kernel;
            return {};
          },
        },
      ),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  return { ports: seen.ports as KernelPorts, stop: () => outcome.host.stop() };
}

async function freshHome(): Promise<string> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-item-stale-`));
  parents.push(parent);
  return `${parent}/home`;
}

const runs = async (ports: KernelPorts, program: string): Promise<'ok' | 'refused'> =>
  await ports.spawn.run(program, []).then(
    () => 'ok' as const,
    () => 'refused' as const,
  );

const fetches = async (ports: KernelPorts, host: string): Promise<'ok' | 'refused'> =>
  await ports.fetch.request(`https://${host}/`).then(
    () => 'ok' as const,
    () => 'refused' as const,
  );

describe('K1 HIGH-1: an item the collection dropped is refused on the very next check', () => {
  test('a reload whose stray-file scan throws still revokes the removed item, now and after later edits', async () => {
    const control: Control = { failRootList: false };
    const { ports, stop } = await bootOwner(await freshHome(), control);
    try {
      expect((await ports.config.write(ITEMS, 'evil', { patch: { command: '/opt/evil/server' } })).kind).toBe(
        'written',
      );
      expect(await runs(ports, '/opt/evil/server')).toBe('ok');
      control.failRootList = true;
      await ports.config.remove(ITEMS, 'evil').catch(() => undefined);
      control.failRootList = false;
      expect([...ports.config.collection(ITEMS).keys()]).toEqual([]);
      expect(await runs(ports, '/opt/evil/server')).toBe('refused');
      // a later, unrelated edit does not bring it back, and does not need to repair anything
      expect((await ports.config.write(ITEMS, 'other', { patch: { command: 'ok-prog' } })).kind).toBe('written');
      expect(await runs(ports, '/opt/evil/server')).toBe('refused');
      expect(await runs(ports, 'ok-prog')).toBe('ok');
    } finally {
      await stop();
    }
  });

  test('while the reload that dropped the item is still running, the item is already refused', async () => {
    const control: Control = { failRootList: false };
    const { ports, stop } = await bootOwner(await freshHome(), control);
    let open!: () => void;
    try {
      await ports.config.write(ITEMS, 'evil', {
        patch: { command: '/opt/evil/server', url: 'https://evil.example.test/' },
      });
      expect(await runs(ports, '/opt/evil/server')).toBe('ok');
      expect(await fetches(ports, 'evil.example.test')).toBe('ok');
      control.gate = new Promise<void>(resolve => {
        open = resolve;
      });
      const removing = ports.config.remove(ITEMS, 'evil');
      // the in-effect version drops the item before the reload finishes announcing it
      for (let i = 0; i < 400 && ports.config.collection(ITEMS).has('evil'); i++) await Bun.sleep(5);
      expect(ports.config.collection(ITEMS).has('evil')).toBe(false);
      expect(await runs(ports, '/opt/evil/server')).toBe('refused');
      expect(await fetches(ports, 'evil.example.test')).toBe('refused');
      control.gate = undefined;
      open();
      await removing;
      expect(await runs(ports, '/opt/evil/server')).toBe('refused');
    } finally {
      control.gate = undefined;
      open?.();
      await stop();
    }
  });
});

describe('K1 on the real wiring: installed items and the owner’s config items are one union', () => {
  test('an installed data plugin’s item and a config item both count, and dropping the config item leaves the installed one', async () => {
    const home = await freshHome();
    const control: Control = { failRootList: false };
    // a first boot makes the home; the data plugin is installed into it; the second boot reads it
    await (await bootOwner(home, control)).stop();
    const folder = `${home}/state/kernel/plugins/pasted`;
    await mkdir(folder, { recursive: true });
    await writeFile(
      `${folder}/plugin.json`,
      JSON.stringify({
        format: 1,
        id: 'pasted',
        title: 'Pasted',
        version: '1.0.0',
        api: 5,
        kinds: ['item'],
        items: [{ kind: 'mcp', id: 'pinned', file: 'pinned.yaml' }],
      }),
    );
    await writeFile(`${folder}/pinned.yaml`, 'command: pinned-prog\nurl: https://pinned.example.test/\n');
    const { ports, stop } = await bootOwner(home, control);
    try {
      expect(await runs(ports, 'pinned-prog')).toBe('ok');
      expect(await fetches(ports, 'pinned.example.test')).toBe('ok');
      expect(await runs(ports, 'cfg-prog')).toBe('refused');
      expect(
        (await ports.config.write(ITEMS, 'cfg', { patch: { command: 'cfg-prog', url: 'https://cfg.example.test/' } }))
          .kind,
      ).toBe('written');
      expect(await runs(ports, 'pinned-prog')).toBe('ok');
      expect(await runs(ports, 'cfg-prog')).toBe('ok');
      expect(await fetches(ports, 'pinned.example.test')).toBe('ok');
      expect(await fetches(ports, 'cfg.example.test')).toBe('ok');
      expect((await ports.config.remove(ITEMS, 'cfg')).kind).toBe('written');
      expect(await runs(ports, 'cfg-prog')).toBe('refused');
      expect(await fetches(ports, 'cfg.example.test')).toBe('refused');
      expect(await runs(ports, 'pinned-prog')).toBe('ok');
      expect(await fetches(ports, 'pinned.example.test')).toBe('ok');
    } finally {
      await stop();
    }
  });
});
