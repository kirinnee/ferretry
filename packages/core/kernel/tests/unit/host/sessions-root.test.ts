/** K1: the `sessions` root — Ferrets' internal root under `state/ferrets/sessions/<ferret>`; the plaintext session credential lives there. */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ok } from '@ferretry/std';
import { z } from 'zod';
import type { FencedPath } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/index.ts';
import type { RootHandle, RootName, RootsPort } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { INTERNAL_ROOT_FOLDERS } from '../../../host/internal-roots.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { UndeclaredStateFileError } from '../../../host/state/errors.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';
import { realAdapters, stateOpener } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/host.ts';
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

describe('K1 the sessions root: a subfolder is exactly one plain ferret-id segment', () => {
  for (const bad of [
    '',
    '.',
    '..',
    'a/b',
    './a',
    'a/',
    '../x',
    'a/../../x',
    '/etc',
    '/',
    'a\0b',
    'a\\b',
    'f1/../..',
    '.hidden',
    'a b',
    // r2-m1: upper case is another spelling of the same folder on a case-insensitive disk, so only the minted shape passes
    'ABC-1',
    'F1',
    'Mw7bp88g-50e00159',
  ]) {
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

  test('K1 a handle with no subfolder at all (the whole base) is refused', async () => {
    const f = await fresh();
    const root = f.port('ferrets').root('sessions');
    expect(root.resolve('f1/environment.json')).toEqual({ ok: false, error: 'outside' });
    await expect(root.writeText('/anywhere/x.json' as FencedPath, 'must-not-land')).rejects.toEqual(
      new RootError('outside'),
    );
    expect(await readdir(`${f.home}/state`)).toEqual([]);
  });

  test('K1 a ferret id of the real shape (base36 time, hex) is accepted', async () => {
    const f = await fresh();
    for (const id of ['mw7bp88g-50e00159', 'f1', 'ferret_1'])
      expect(f.port('ferrets').root('sessions', { subfolder: id }).resolve('x.json').ok).toBe(true);
  });

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
      fleet: true,
      'harness-history': false,
      'harness-home': false,
      worktrees: false,
      work: false,
      imports: false,
      'project-files': false,
    };
    for (const name of Object.keys(expected) as RootName[]) {
      // credentials, sessions, fleet and harness-home have an owner; every other plugin gets its own name
      const plugin =
        name === 'credentials'
          ? 'logins'
          : name === 'sessions'
            ? 'ferrets'
            : name === 'fleet' || name === 'harness-home'
              ? 'runtimes'
              : 'codex';
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

  test('K1 no clash: the state port refuses a name equal to a kernel-made folder, on write and on read', async () => {
    const fs = createMemoryHostFs();
    const port = createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [ferretFile], fs });
    for (const reserved of INTERNAL_ROOT_FOLDERS) {
      await expect(port.write(ferretFile, { id: reserved }, reserved)).rejects.toBeInstanceOf(UndeclaredStateFileError);
      await expect(port.read(ferretFile, reserved)).rejects.toBeInstanceOf(UndeclaredStateFileError);
    }
    await expect(port.write(ferretFile, { id: 'sessions' }, 'sessions')).rejects.toThrow(
      'state ferret: "sessions" is not a valid name',
    );
    // nothing landed inside the credential root's base, and a generated id is still fine
    expect(await fs.list('/home/fy/state/ferrets')).toEqual([]);
    await port.write(ferretFile, { id: 'mw7bp88g-50e00159' }, 'mw7bp88g-50e00159');
    expect(await port.list(ferretFile)).toEqual(['mw7bp88g-50e00159']);
  });

  test('K1 r2-m1 the reserved names are refused in any case: Sessions, SESSIONS, Agent-Homes on write and on read', async () => {
    const fs = createMemoryHostFs();
    const port = createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [ferretFile], fs });
    for (const reserved of [
      'Sessions',
      'SESSIONS',
      'sEsSiOnS',
      'Agent-Homes',
      'AGENT-HOMES',
      'Credentials',
      'DOWNLOADS',
    ]) {
      await expect(port.write(ferretFile, { id: reserved }, reserved)).rejects.toBeInstanceOf(UndeclaredStateFileError);
      await expect(port.read(ferretFile, reserved)).rejects.toBeInstanceOf(UndeclaredStateFileError);
    }
    expect(await fs.list('/home/fy/state/ferrets')).toEqual([]);
  });

  test('K1 r2-m1 the list skips a kernel-made folder in any case (what a case-insensitive disk hands back)', async () => {
    const fs = createMemoryHostFs();
    const port = createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [ferretFile], fs });
    await port.write(ferretFile, { id: 'mw7bp88g-50e00159' }, 'mw7bp88g-50e00159');
    for (const folder of ['Sessions', 'SESSIONS', 'Agent-Homes'])
      await fs.writeAtomic(`/home/fy/state/ferrets/${folder}/x/ferret.json`, new Uint8Array(), 0o600);
    expect(await port.list(ferretFile)).toEqual(['mw7bp88g-50e00159']);
  });

  test('K1 r2-m2 a fixed state file under a kernel-made folder is refused at declaration, in any case', () => {
    const fs = createMemoryHostFs();
    for (const path of [
      'sessions/index.json',
      'sessions/x/y.json',
      'Sessions/index.json',
      'credentials/index.json',
      'downloads/index.json',
      'agent-homes/index.json',
      'SESSIONS',
    ]) {
      const fixed = defineState({
        name: 'fixed',
        path,
        store: 'json',
        format: 1,
        schema: z.strictObject({ id: z.string() }),
      });
      expect(() => createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [fixed], fs })).toThrow(
        UndeclaredStateFileError,
      );
    }
    // a fixed file whose folder only starts like one, and an ordinary fixed file, are fine
    for (const path of ['sessions-1/index.json', 'index.json', 'a/sessions/index.json']) {
      const fixed = defineState({
        name: 'fixed',
        path,
        store: 'json',
        format: 1,
        schema: z.strictObject({ id: z.string() }),
      });
      expect(() => createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [fixed], fs })).not.toThrow();
    }
  });

  test('K1 a name that only starts like a kernel-made folder is still a name', async () => {
    const fs = createMemoryHostFs();
    const port = createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [ferretFile], fs });
    await port.write(ferretFile, { id: 'sessions-1' }, 'sessions-1');
    expect(await port.list(ferretFile)).toEqual(['sessions-1']);
  });
});

describe('K1 the sessions root: leftover adoption is for internal roots only', () => {
  test('K1 a worktrees root does not adopt a leftover temp name: both names stay and the read is refused', async () => {
    const f = await fresh();
    const worktrees = `${f.home}-worktrees`;
    await mkdir(`${worktrees}/d`, { recursive: true, mode: 0o700 });
    await writeFile(`${worktrees}/d/s.jsonl`, 'theirs');
    await link(`${worktrees}/d/s.jsonl`, `${worktrees}/d/.s.jsonl.abc.tmp`);
    const root = f.port('ferrets', ['worktrees']).root('worktrees');

    await expect(root.readDurable(resolved(root, 'd/s.jsonl'))).rejects.toEqual(new RootError('hard_link'));
    expect((await readdir(`${worktrees}/d`)).toSorted()).toEqual(['.s.jsonl.abc.tmp', 's.jsonl']);
  });
});

describe('K1 the sessions root stays private: nothing widens past the owner', () => {
  test('K1 a sessions folder that already exists as 0755 is tightened to 0700 at boot', async () => {
    const f = await fresh();
    await mkdir(`${f.home}/state/ferrets/sessions`, { recursive: true, mode: 0o755 });
    await chmod(`${f.home}/state/ferrets/sessions`, 0o755);
    await chmod(`${f.home}/state/ferrets`, 0o755);
    expect(await modeOf(`${f.home}/state/ferrets/sessions`)).toBe(0o755);

    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions'])).toEqual([]);

    expect(await modeOf(`${f.home}/state/ferrets/sessions`)).toBe(0o700);
    // n-b: only the base is clamped; the plugin's own state folder is left as it was (the 0700 base is the gate)
    expect(await modeOf(`${f.home}/state/ferrets`)).toBe(0o755);
  });

  test('K1 a file written with a wider mode, or replaced over a wider one, comes out 0600', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    const name = resolved(root, 'environment.json');
    const on = `${f.home}/state/ferrets/sessions/f1/environment.json`;

    await root.writeText(name, 'one', { mode: 0o644 });
    expect(await modeOf(on)).toBe(0o600);

    // a carried-over file at 0644, replaced in place with no mode named
    await chmod(on, 0o644);
    await root.writeText(name, 'two', { replaceExisting: true });
    expect(await readFile(on, 'utf8')).toBe('two');
    expect(await modeOf(on)).toBe(0o600);

    await chmod(on, 0o644);
    await root.writeText(name, 'three', { replaceExisting: true, mode: 0o666 });
    expect(await modeOf(on)).toBe(0o600);

    await root.publish(resolved(root, 'effects/e.json'), encoder.encode('p'), { mode: 0o644 });
    expect(await modeOf(`${f.home}/state/ferrets/sessions/f1/effects/e.json`)).toBe(0o600);
  });

  test('K1 u2 a handle holds ITS OWN ferret folder private: an existing 0755 folder is narrowed to 0700', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    await mkdir(`${f.home}/state/ferrets/sessions/f1`, { mode: 0o755 });
    await chmod(`${f.home}/state/ferrets/sessions/f1`, 0o755);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });

    await root.ensurePrivateDirectory(resolved(root, '.'));

    expect(await modeOf(`${f.home}/state/ferrets/sessions/f1`)).toBe(0o700);
    // and only that folder: a sibling ferret's folder is not this handle's to touch
    await mkdir(`${f.home}/state/ferrets/sessions/f2`, { mode: 0o755 });
    await chmod(`${f.home}/state/ferrets/sessions/f2`, 0o755);
    await root.ensurePrivateDirectory(resolved(root, '.'));
    expect(await modeOf(`${f.home}/state/ferrets/sessions/f2`)).toBe(0o755);
  });

  test('K1 u2 a handle makes its own missing ferret folder 0700, and a read below one that is not there is refused first', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    // nothing there yet: the kernel refuses the read rather than answering "absent" (why the stores make the folder first)
    await expect(root.readBytes(resolved(root, 'environment.json'))).rejects.toEqual(new RootError('outside'));

    await root.ensurePrivateDirectory(resolved(root, '.'));

    expect(await modeOf(`${f.home}/state/ferrets/sessions/f1`)).toBe(0o700);
    await expect(root.readBytes(resolved(root, 'environment.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('K1 u2 a handle that makes its own ferret folder syncs the sessions folder that names it, before anything below it is written', () => {
    /**
     * Wraps the real adapter (the IO still happens) and records, in order, each folder made (by its leaf), each file
     * written (by its leaf) and each folder synced (by the real path its proven descriptor resolves to).
     */
    const recording = (disk: HostFs, events: string[]): HostFs => ({
      ...disk,
      mkdir: async (path, mode) => {
        await disk.mkdir(path, mode);
        events.push(`mkdir ${path.split('/').at(-1)}`);
      },
      writeNew: async (path, data, mode) => {
        const made = await disk.writeNew(path, data, mode);
        events.push(`write ${path.split('/').at(-1)}`);
        return made;
      },
      openDirectory: async path => {
        const opened = await disk.openDirectory(path);
        return {
          ...opened,
          sync: async () => {
            await opened.sync();
            events.push(`sync ${await realpath(opened.entryPath('') ?? path)}`);
          },
        };
      },
    });

    const setUp = async () => {
      const f = await fresh();
      await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
      const sessions = await realpath(`${f.home}/state/ferrets/sessions`);
      const events: string[] = [];
      const disk = recording(f.fs, events);
      const roots = rootsPortFor(
        disk,
        { home: f.home, plugin: 'ferrets', worktrees: `${f.home}-worktrees` },
        ['sessions'],
        () => undefined,
      );
      return { root: roots.root('sessions', { subfolder: 'f1' }), sessions, events };
    };

    test("K1 u2 holding the folder private (the stores' first step) syncs sessions/ right after making <ferret>/", async () => {
      const { root, sessions, events } = await setUp();

      await root.ensurePrivateDirectory(resolved(root, '.'));

      expect(events).toEqual(['mkdir f1', `sync ${sessions}`]);

      // a later publish below the folder: sessions/ was made durable first, then the folder, then the new effects/
      await root.publish(resolved(root, 'effects/e.json'), encoder.encode('p'), { exclusive: true });
      expect(events.filter(event => event.startsWith('sync '))).toEqual([
        `sync ${sessions}`,
        `sync ${sessions}/f1`,
        `sync ${sessions}/f1/effects`,
      ]);
      expect(events.indexOf(`sync ${sessions}`)).toBeLessThan(events.indexOf('mkdir effects'));
    });

    test('K1 u2 a publish straight into a fresh handle syncs sessions/ before <ferret>/ holds anything', async () => {
      const { root, sessions, events } = await setUp();

      await root.publish(resolved(root, 'environment.json'), encoder.encode('{}'));

      expect(events[0]).toBe('mkdir f1');
      expect(events[1]).toBe(`sync ${sessions}`);
      expect(events.indexOf(`sync ${sessions}`)).toBeLessThan(events.findIndex(event => event.startsWith('write ')));
      expect(events.filter(event => event.startsWith('sync '))).toEqual([`sync ${sessions}`, `sync ${sessions}/f1`]);
    });

    test('K1 u2 a folder already there is not synced again by the handle (nothing new to persist)', async () => {
      const { root, events } = await setUp();
      await root.ensurePrivateDirectory(resolved(root, '.'));
      events.splice(0);

      await root.ensurePrivateDirectory(resolved(root, '.'));

      expect(events).toEqual([]);
    });
  });

  test('K1 u2 a link at the ferret folder is refused when the handle holds it private, never followed', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const elsewhere = `${f.parent}/elsewhere`;
    await mkdir(elsewhere, { mode: 0o755 });
    await symlink(elsewhere, `${f.home}/state/ferrets/sessions/f1`);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });

    await expect(root.ensurePrivateDirectory(resolved(root, '.'))).rejects.toBeInstanceOf(RootError);
    expect(await modeOf(elsewhere)).toBe(0o755);
  });

  test('K1 n-a copyTree into a sessions handle: a 0644 file and a 0755 folder land 0600 and 0700', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const worktrees = `${f.home}-worktrees`;
    await mkdir(`${worktrees}/d/sub`, { recursive: true, mode: 0o755 });
    await chmod(`${worktrees}/d`, 0o755);
    await chmod(`${worktrees}/d/sub`, 0o755);
    await writeFile(`${worktrees}/d/a.txt`, 'a', { mode: 0o644 });
    await writeFile(`${worktrees}/d/sub/b.txt`, 'b', { mode: 0o644 });
    await chmod(`${worktrees}/d/a.txt`, 0o644);
    await chmod(`${worktrees}/d/sub/b.txt`, 0o644);
    const roots = f.port('ferrets', ['sessions', 'worktrees']);
    const source = roots.root('worktrees');
    const target = roots.root('sessions', { subfolder: 'f1' });

    await target.copyTree(source, resolved(source, 'd'), resolved(target, 'copy'));

    const into = `${f.home}/state/ferrets/sessions/f1/copy`;
    expect(await readFile(`${into}/sub/b.txt`, 'utf8')).toBe('b');
    expect(await modeOf(into)).toBe(0o700);
    expect(await modeOf(`${into}/sub`)).toBe(0o700);
    expect(await modeOf(`${into}/a.txt`)).toBe(0o600);
    expect(await modeOf(`${into}/sub/b.txt`)).toBe(0o600);
  });

  test('K1 a folder made through the sessions handle is 0700 whatever mode is asked', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    await root.makeDirectory(resolved(root, 'turns'), { mode: 0o755 });
    expect(await modeOf(`${f.home}/state/ferrets/sessions/f1/turns`)).toBe(0o700);
  });

  test('K1 a narrower mode a caller asks for is kept (0400 stays 0400)', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'ferrets' }, ['sessions']);
    const root = f.port('ferrets').root('sessions', { subfolder: 'f1' });
    await root.writeText(resolved(root, 'frozen.json'), 'x', { mode: 0o400 });
    expect(await modeOf(`${f.home}/state/ferrets/sessions/f1/frozen.json`)).toBe(0o400);
  });
});

describe('K1 the testing host refuses an owned root to a plugin that does not own it, as production does', () => {
  const rootPlugin = (id: string, root: RootName) =>
    implementDaemon(
      definePlugin({
        id,
        title: id,
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        permissions: { roots: [root] },
      }),
      {
        build: ctx => {
          seen.set(id, () => ctx.kernel.roots.root(root, root === 'sessions' ? { subfolder: 'f1' } : undefined));
          return {};
        },
      },
    );
  const seen = new Map<string, () => RootHandle>();
  const scoped = new Map<string, RootHandle>();

  test("K1 r2-m3 testHost: two sessions subfolders do not see each other, and the folder rule is production's", async () => {
    seen.clear();
    const plugin = implementDaemon(
      definePlugin({
        id: 'ferrets',
        title: 'ferrets',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        permissions: { roots: ['sessions', 'agent-homes'] },
      }),
      {
        build: ctx => {
          scoped.set('a', ctx.kernel.roots.root('sessions', { subfolder: 'aaa-1' }));
          scoped.set('b', ctx.kernel.roots.root('sessions', { subfolder: 'bbb-2' }));
          scoped.set('whole', ctx.kernel.roots.root('sessions'));
          scoped.set('nested', ctx.kernel.roots.root('sessions', { subfolder: 'a/b' }));
          scoped.set('upper', ctx.kernel.roots.root('sessions', { subfolder: 'AAA-1' }));
          scoped.set('attach', ctx.kernel.roots.root('sessions', { subfolder: 'aaa-1/attachments' }));
          scoped.set('turns', ctx.kernel.roots.root('sessions', { subfolder: 'aaa-1/turns' }));
          scoped.set('deeper', ctx.kernel.roots.root('sessions', { subfolder: 'aaa-1/attachments/x' }));
          scoped.set('bare', ctx.kernel.roots.root('sessions', { subfolder: '/attachments' }));
          scoped.set('upAttach', ctx.kernel.roots.root('sessions', { subfolder: 'AAA-1/attachments' }));
          scoped.set('homeA', ctx.kernel.roots.root('agent-homes', { subfolder: 'aaa-1' }));
          scoped.set('homeB', ctx.kernel.roots.root('agent-homes', { subfolder: 'bbb-2' }));
          scoped.set('homeUp', ctx.kernel.roots.root('agent-homes', { subfolder: '../x' }));
          return {};
        },
      },
    );
    const host = await testHost({ plugins: [plugin] });
    const handle = (key: string): RootHandle => {
      const found = scoped.get(key);
      if (found === undefined) throw new Error(key);
      return found;
    };
    const a = handle('a');
    const b = handle('b');
    await a.writeText(resolved(a, 'environment.json'), 'secret-of-a');
    expect(await a.readText(resolved(a, 'environment.json'))).toBe('secret-of-a');
    // the other ferret's handle names its own folder: it never reads what a wrote
    await expect(b.readText(resolved(b, 'environment.json'))).rejects.toThrow();
    expect(String(resolved(b, 'environment.json'))).not.toBe(String(resolved(a, 'environment.json')));
    // agent-homes scopes the same way
    const homeA = handle('homeA');
    const homeB = handle('homeB');
    await homeA.writeText(resolved(homeA, 'x.json'), 'a');
    await expect(homeB.readText(resolved(homeB, 'x.json'))).rejects.toThrow();
    // production's refusals: the whole base, a nested path, an upper-case id, a traversing agent-homes scope
    for (const key of ['whole', 'nested', 'upper', 'homeUp', 'turns', 'deeper', 'bare', 'upAttach'])
      expect(handle(key).resolve('environment.json')).toEqual({ ok: false, error: 'outside' });
    // a ferret's own `attachments` folder is the one nested scope, and a file written through it is that folder's alone
    const attach = handle('attach');
    await attach.writeText(resolved(attach, 'shot.txt'), 'in-attachments');
    expect(await attach.readText(resolved(attach, 'shot.txt'))).toBe('in-attachments');
    await expect(a.readText(resolved(a, 'shot.txt'))).rejects.toThrow();
    await host.stop();
  });

  for (const [owned, owner] of [
    ['sessions', 'ferrets'],
    ['credentials', 'logins'],
  ] as const) {
    test(`K1 testHost: only ${owner} gets ${owned}; a terminals plugin that declares it is refused`, async () => {
      seen.clear();
      const host = await testHost({ plugins: [rootPlugin(owner, owned), rootPlugin('terminals', owned)] });
      expect(seen.get(owner)?.().internal).toBe(true);
      expect(() => seen.get('terminals')?.()).toThrow(`terminals: root ${owned} is not declared`);
      await host.stop();
    });
  }
});
