/** K1: the `sessions` root — Ferrets' internal root under `state/ferrets/sessions/<ferret>`; the plaintext session credential lives there. */
import { afterEach, describe, expect, test } from 'bun:test';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ok } from '@ferretry/std';
import { z } from 'zod';
import type { FencedPath } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/index.ts';
import type { RootHandle, RootName, RootsPort } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { INTERNAL_ROOT_FOLDERS } from '../../../host/internal-roots.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';
import { realAdapters, stateOpener } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { silentLog } from './fixtures.ts';

const parents: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function fresh() {
  const parent = await mkdtemp(`${tmpdir()}/sessions-root-k1-`);
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  const fs = nodeFs(() => crypto.randomUUID());
  const port = (plugin: string, declared: readonly RootName[] = ['sessions']): RootsPort =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => undefined);
  return { parent, home, fs, port };
}

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};
const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('K1 the sessions root: base, mode, owner', () => {
  test('K1 the base is <home>/state/ferrets/sessions/<subfolder>, made 0700 at boot', async () => {
    const parent = await mkdtemp(`${tmpdir()}/sessions-root-k1-boot-`);
    parents.push(parent);
    const home = `${parent}/home`;
    const clock = fixedClock();
    const ports = new Map<string, RootsPort>();
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock,
      homeLock: async () => ({ release: async () => {} }),
      state: stateOpener(home, createMemoryHostFs(), clock, silentLog),
    };
    const implementations = [
      implementDaemon(
        definePlugin({
          id: 'ferrets',
          title: 'ferrets',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { roots: ['sessions'] },
        }),
        {
          build: ctx => {
            ports.set('ferrets', ctx.kernel.roots);
            return {};
          },
        },
      ),
    ];
    const result = await bootHost({ home, version: '5.0.0', implementations, adapters });
    if (result.kind !== 'running') throw new Error(result.sentence);
    hosts.push(result.host);

    expect((await lstat(`${home}/state/ferrets/sessions`)).isDirectory()).toBe(true);
    expect(await modeOf(`${home}/state/ferrets/sessions`)).toBe(0o700);
    expect(await modeOf(`${home}/state/ferrets`)).toBe(0o700);

    const root = ports.get('ferrets')?.root('sessions', { subfolder: 'mw7bp88g-50e00159' });
    if (root === undefined) throw new Error('ferrets was not built');
    expect(String(resolved(root, 'environment.json'))).toBe(
      `${home}/state/ferrets/sessions/mw7bp88g-50e00159/environment.json`,
    );
    await root.writeText(resolved(root, 'environment.json'), '{"fixture":true}');
    expect(await readFile(`${home}/state/ferrets/sessions/mw7bp88g-50e00159/environment.json`, 'utf8')).toBe(
      '{"fixture":true}',
    );
    expect(await modeOf(`${home}/state/ferrets/sessions/mw7bp88g-50e00159`)).toBe(0o700);
    expect(await modeOf(`${home}/state/ferrets/sessions/mw7bp88g-50e00159/environment.json`)).toBe(0o600);
  });

  test('K1 the folder is made without a subfolder and again when it is already there', async () => {
    const f = await fresh();
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions'])).toEqual([]);
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions'])).toEqual([]);
    expect(await modeOf(`${f.home}/state/ferrets/sessions`)).toBe(0o700);
  });

  for (const other of ['claude-code', 'codex', 'logins', 'terminals', 'intruder']) {
    test(`K1 the ${other} plugin cannot declare the sessions root: the owner check refuses it`, async () => {
      const f = await fresh();
      expect(() => f.port(other).root('sessions', { subfolder: 'f1' })).toThrow(new RootError('not_declared'));
      expect(() => f.port(other).root('sessions')).toThrow(new RootError('not_declared'));
      // and the kernel makes no folder for it
      expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: other }, ['sessions'])).toEqual([]);
      expect(await readdir(`${f.home}/state`)).toEqual([]);
    });
  }

  test('K1 a plugin that did not declare sessions is refused even when it is Ferrets', async () => {
    const f = await fresh();
    expect(() => f.port('ferrets', ['work']).root('sessions', { subfolder: 'f1' })).toThrow(
      new RootError('not_declared'),
    );
  });
});

describe('K1 the sessions root: subfolder rule is the one agent-homes has', () => {
  for (const bad of ['../x', '..', 'a/../../x', '/etc', '/', 'a\0b', 'f1/../..']) {
    test(`K1 the subfolder ${JSON.stringify(bad)} is refused and nothing is made`, async () => {
      const f = await fresh();
      const root = f.port('ferrets').root('sessions', { subfolder: bad });
      expect(root.resolve('x.json')).toEqual({ ok: false, error: 'outside' });
      await expect(root.writeText('/anywhere/x.json' as FencedPath, 'must-not-land')).rejects.toEqual(
        new RootError('outside'),
      );
      expect(await readdir(`${f.home}/state`)).toEqual([]);
      expect(await readdir(f.parent)).toEqual(['home']);
    });
  }

  test('K1 a ferret id and a relative path inside it resolve beneath the base, a path out of it does not', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    expect(String(resolved(root, 'turns/turn-001.md'))).toBe(`${f.home}/state/ferrets/sessions/f1/turns/turn-001.md`);
    expect(root.resolve('../f2/environment.json').ok).toBe(false);
    expect(root.resolve('/etc/passwd').ok).toBe(false);
  });

  test('K1 a link placed at a ferret folder is refused, not followed', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const outside = `${f.parent}/outside`;
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, `${f.home}/state/ferrets/sessions/f1`);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    await expect(root.writeText(resolved(root, 'environment.json'), 'must-not-land')).rejects.toEqual(
      new RootError('link_escape'),
    );
    expect(await readdir(outside)).toEqual([]);
  });

  test('K1 a base substituted by a link is refused at boot and every later use is refused', async () => {
    const f = await fresh();
    const outside = `${f.parent}/outside`;
    await mkdir(outside, { mode: 0o700 });
    await mkdir(`${f.home}/state/ferrets`, { mode: 0o700 });
    await symlink(outside, `${f.home}/state/ferrets/sessions`);
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions'])).toEqual([
      { name: 'sessions', refusal: 'link_escape' },
    ]);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    await expect(root.writeText(resolved(root, 'environment.json'), 'must-not-land')).rejects.toEqual(
      new RootError('link_escape'),
    );
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('K1 RootHandle.internal', () => {
  test('K1 internal is true for every root the kernel makes under the home, false for an owner root', async () => {
    const f = await fresh();
    const expected: Readonly<Record<RootName, boolean>> = {
      'agent-homes': true,
      downloads: true,
      credentials: true,
      sessions: true,
      'harness-history': false,
      worktrees: false,
      work: false,
      imports: false,
    };
    for (const name of Object.keys(expected) as RootName[]) {
      // credentials and sessions have an owner; every other plugin gets its own name
      const plugin = name === 'credentials' ? 'logins' : name === 'sessions' ? 'ferrets' : 'codex';
      const handle = f.port(plugin, [name]).root(name, { subfolder: '/tmp/fixture' });
      expect({ name, internal: handle.internal }).toEqual({ name, internal: expected[name] });
    }
  });

  test('K1 the internal roots are exactly the folders the state listing skips', () => {
    expect([...INTERNAL_ROOT_FOLDERS].toSorted()).toEqual(['agent-homes', 'credentials', 'downloads', 'sessions']);
  });
});

describe('K1 the sessions root is internal: a leftover durable publish name is adopted there', () => {
  test('K1 a record with its own leftover temp link is readable and the leftover is removed', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    const name = resolved(root, 'effects/e.json');
    await root.publish(name, encoder.encode('one'), { exclusive: true });
    const folder = `${f.home}/state/ferrets/sessions/f1/effects`;
    // what a crash between the link and the unlink leaves behind (the ledger wedge case)
    await link(`${folder}/e.json`, `${folder}/.e.json.0f3a.tmp`);

    const read = await root.readDurable(name);

    expect(decoder.decode(read?.bytes)).toBe('one');
    expect(await readdir(folder)).toEqual(['e.json']);
  });

  test('K1 the same leftover on a work root stays refused, both names kept', async () => {
    const f = await fresh();
    const workFolder = `${f.parent}/work`;
    await mkdir(`${workFolder}/d`, { recursive: true, mode: 0o700 });
    await writeFile(`${workFolder}/d/s.jsonl`, 'theirs');
    await link(`${workFolder}/d/s.jsonl`, `${workFolder}/d/.s.jsonl.abc.tmp`);
    const root = rootsPortFor(
      f.fs,
      { home: f.home, plugin: 'ferrets', worktrees: `${f.home}-worktrees` },
      ['work'],
      () => ({
        folderOf: () => workFolder as FencedPath,
        check: (_ferret, path) => ok(path as FencedPath),
      }),
    ).root('work', { ferret: 'f1' as never });

    await expect(root.readDurable(`${workFolder}/d/s.jsonl` as FencedPath)).rejects.toEqual(new RootError('hard_link'));
    expect((await readdir(`${workFolder}/d`)).toSorted()).toEqual(['.s.jsonl.abc.tmp', 's.jsonl']);
  });
});

describe('K1 kernel.state.list(FerretFiles) skips the sessions folder', () => {
  const ferretFile = defineState({
    name: 'ferret',
    path: '*/ferret.json',
    store: 'json',
    format: 1,
    schema: z.strictObject({ id: z.string() }),
  });

  test('K1 the sessions folder beside the ferret folders is not one of the ferret ids; ids are never named sessions', async () => {
    const fs = createMemoryHostFs();
    const port = createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [ferretFile], fs });
    await port.write(ferretFile, { id: 'mw7bp88g-50e00159' }, 'mw7bp88g-50e00159');
    await port.write(ferretFile, { id: 'mw7bq000-0badc0de' }, 'mw7bq000-0badc0de');
    expect(await port.list(ferretFile)).toEqual(['mw7bp88g-50e00159', 'mw7bq000-0badc0de']);

    // the kernel's folder for the K1 root, with a ferret's own session folder inside it
    await fs.ensureDirectory('/home/fy/state/ferrets/sessions/mw7bp88g-50e00159/effects', 0o700);
    await fs.writeAtomic('/home/fy/state/ferrets/sessions/mw7bp88g-50e00159/environment.json', new Uint8Array(), 0o600);

    expect(await port.list(ferretFile)).toEqual(['mw7bp88g-50e00159', 'mw7bq000-0badc0de']);
  });

  test('K1 no clash: a generated ferret id (base36-hex pair) is never one of the kernel-made folder names', () => {
    for (const id of ['mw7bp88g-50e00159', 'mw5qgajf-0fd90655', 'zzzzzzzz-ffffffff'])
      expect(INTERNAL_ROOT_FOLDERS.includes(id as RootName)).toBe(false);
    expect(/^[0-9a-z]{8}-[0-9a-f]{8}$/u.test('sessions')).toBe(false);
  });
});
