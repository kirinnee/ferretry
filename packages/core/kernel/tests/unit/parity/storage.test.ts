/**
 * The kernel-owned F rows of docs/design/rebuild-parity.tsv, each named by its id in the title that proves it: the
 * home's folders and files (§9.2), the home lock, the daemon's identity key, the accepted record, and the
 * configuration folder with its generated JSON Schemas. A row names a place under today's `FY_HOME`; each test says
 * where 5.0 keeps it and proves the file is really there, on a temporary home (or the memory file system the config
 * service tests run on).
 *
 * Not proved here, and why (see the report): the `fy daemon` lifecycle claim files, the restart marker and the
 * syscall trace folder live in the `fy` shell, which a kernel test may not import (context-imports); `health.jsonl` /
 * `self-restart.json` are Ferrets' own files and not ported yet; `auth.json` belongs to Runtimes; the one-time conversion report
 * (F-0384) is an artefact that a clean slate does not keep. F-0033 (the identity key's pin) is proved in the identity
 * key's describe below on the real fence; every door that reaches the pinned name is in host/fence-rows.test.ts, and the
 * one owner of the path is host/identity-pin-single-source.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { instantFromEpochMs, ok } from '@ferretry/std';
import { z } from 'zod';
import type { FencedPath } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/index.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { FerretIndexFile } from '../../../../ferrets/contract/state.ts';
import { acceptedName } from '../../../contract/accepted.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { fencedByName, fencedReal, fenceOf, internalRootPins, PINNED_KEY_PATHS } from '../../../host/fence-guard.ts';
import { identityKey } from '../../../host/fence-index.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { openHome } from '../../../host/home.ts';
import { IDENTITY_FILE, loadIdentity } from '../../../host/identity.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { configJsonSchemaText, schemaFileName } from '../../../host/config/schemas.ts';
import { acquireHomeLock, homeLockPath, StateHomeLockedError } from '../../../host/state/home-lock.ts';
import { configHarness, HOME, loginsDef, manualClock, captureLog, updatesDef } from '../host-config/support.ts';
import { declaredKinds } from '../host-config/real-schemas.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const fs = nodeFs(() => 'r');

/** A temporary FY_HOME that does not exist yet, as a first start finds it. */
async function freshHome(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fy-parity-storage-'));
  homes.push(parent);
  return join(parent, 'home');
}
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const kindOf = async (path: string): Promise<'directory' | 'file'> =>
  (await stat(path)).isDirectory() ? 'directory' : 'file';

describe('the home tree (§9.2): one home, FY_HOME, with the folders today keeps', () => {
  async function firstStartMakes(folder: string) {
    const home = await freshHome();
    const outcome = await openHome(fs, home, 'fyd 5.0.0', instantFromEpochMs(Date.UTC(2026, 10, 8)));
    expect(outcome).toEqual({ kind: 'ready', created: true });
    expect(await kindOf(join(home, folder))).toBe('directory');
    expect(await modeOf(join(home, folder))).toBe(0o700);
  }

  test('F-0047 F-0212 FY_HOME/state is made on a first start, a private folder', () => firstStartMakes('state'));
  test('F-0131 F-0424 FY_HOME/config is made on a first start, a private folder', () => firstStartMakes('config'));
  test('F-0204 FY_HOME/logs is made on a first start, a private folder', () => firstStartMakes('logs'));

  test('F-0212 F-0252 the session index is state/ferrets/index.sqlite, a cache the state port opens in the state folder', async () => {
    expect(FerretIndexFile.store).toBe('sqlite-cache');
    const home = await freshHome();
    const port = createStatePort({ home, pluginId: 'ferrets', files: [FerretIndexFile], fs: createNodeHostFs() });
    expect(port.sqliteGrant(FerretIndexFile).path).toBe(join(home, 'state', 'ferrets', 'index.sqlite'));
    // Opened for real: the file is made where the grant says, so moving the state root moves the file and fails this.
    port.sqlite(FerretIndexFile).close();
    expect(await kindOf(join(home, 'state', 'ferrets', 'index.sqlite'))).toBe('file');
  });
});

describe('the home lock', () => {
  test('F-0091 F-0178 the lock is FY_HOME/run/daemon.lock, 0600, and a second daemon on the home is refused', async () => {
    const home = await freshHome();
    expect(homeLockPath(home)).toBe(join(home, 'run', 'daemon.lock'));
    const lease = await acquireHomeLock({ home, binary: 'fy' });
    expect(await kindOf(homeLockPath(home))).toBe('file');
    expect(await modeOf(homeLockPath(home))).toBe(0o600);
    const refused = await acquireHomeLock({ home, binary: 'fy' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(StateHomeLockedError);
    expect((refused as StateHomeLockedError).lockFile).toBe(homeLockPath(home));
    await lease.release();
    await (await acquireHomeLock({ home, binary: 'fy' })).release();
  });
});

describe('the daemon identity key', () => {
  test('F-0248 the signing key is made at state/kernel/identity.json, 0600, and read back unchanged', async () => {
    const home = await freshHome();
    await openHome(fs, home, 'fyd 5.0.0', instantFromEpochMs(Date.UTC(2026, 10, 8)));
    const made = await loadIdentity(fs, home);
    expect(made.kind === 'ready' && made.created).toBe(true);
    expect(IDENTITY_FILE).toBe('state/kernel/identity.json');
    expect(await modeOf(join(home, IDENTITY_FILE))).toBe(0o600);
    const text = await readFile(join(home, IDENTITY_FILE), 'utf8');
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['schemaVersion', 'privateKeyPem']);
    const again = await loadIdentity(fs, home);
    expect(again.kind === 'ready' && again.created).toBe(false);
    expect(again.kind === 'ready' && made.kind === 'ready' && again.identity.daemonId === made.identity.daemonId).toBe(
      true,
    );
  });

  test('F-0033 the key the kernel really writes is pinned by identity: a hard link to it under an innocent name is fenced', async () => {
    const home = await freshHome();
    await openHome(fs, home, 'fyd 5.0.0', instantFromEpochMs(Date.UTC(2026, 10, 8)));
    await loadIdentity(fs, home);
    const work = join(dirname(home), 'work');
    await mkdir(work, { recursive: true });
    await link(join(home, IDENTITY_FILE), join(work, 'innocent.txt'));
    await writeFile(join(work, 'plain.txt'), 'not the key');

    expect(PINNED_KEY_PATHS).toContain(IDENTITY_FILE);
    const fence = await fenceOf(fs, home);
    // The name outside the home means nothing; the identity (device and inode) is what is held.
    expect(await fencedReal(fs, fence, join(work, 'innocent.txt'))).toBe(true);
    expect(await fencedReal(fs, fence, join(work, 'plain.txt'))).toBe(false);
  });
});

describe('the accepted record: today config-accepted.json is one document per file in state/kernel/accepted-config/', () => {
  test('F-0085 F-0426 F-0431 the last good text of a file is kept in state/kernel/accepted-config/<name>, with its etag', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const record = [...h.fs.snapshot()].filter(([path]) => path.startsWith(`${HOME}/state/kernel/accepted-config/`));
    expect(record.map(([path]) => path)).toEqual([
      `${HOME}/state/kernel/accepted-config/${acceptedName('updates.yaml')}.json`,
    ]);
    const document = JSON.parse(record[0]?.[1] ?? '{}') as Record<string, unknown>;
    expect(document).toMatchObject({ format: 1, text: 'limit: 5\n', plugin: 'updates' });
    expect(typeof document.etag).toBe('string');
    // It is the record a restart judges against: a broken file falls back to it.
    h.fs.seed(h.path('updates.yaml'), '{ broken');
    const restarted = h.restart();
    await restarted.reload();
    expect((restarted.port('updates').file(updatesDef) as { limit: number }).limit).toBe(5);
  });
});

describe('the configuration folder: FY_HOME/config, one YAML file per building block', () => {
  test('F-0153 a file is written to and read from FY_HOME/config/<path>, a folder of files likewise', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    await h.files.write('logins', loginsDef, 'alpha', 'model: m\n');
    expect(h.fs.snapshot().get(h.path('updates.yaml'))).toBe('limit: 5\n');
    expect(h.fs.snapshot().get(h.path('logins/alpha.yaml'))).toBe('model: m\n');
    expect(h.fs.modeOf(h.path('updates.yaml'))).toBe(0o600);
    const read = await h.files.read('updates', updatesDef);
    expect(read).toMatchObject({ path: 'updates.yaml', exists: true, text: 'limit: 5\n', state: 'ok' });
    expect(await h.files.read('logins', loginsDef, 'alpha')).toMatchObject({
      path: 'logins/alpha.yaml',
      exists: true,
      text: 'model: m\n',
    });
  });

  test('F-0152 every file is listed with its path, its state and its text, and a file that is not there says so', async () => {
    const h = configHarness();
    await h.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    h.fs.seed(h.path('logins/beta.yaml'), 'model: [\n');
    await h.files.reload();
    expect(h.files.status().files).toEqual(
      expect.arrayContaining([
        { path: 'updates.yaml', plugin: 'updates', state: 'ok' },
        { path: 'logins/beta.yaml', plugin: 'logins', state: 'invalid' },
      ]),
    );
    const missing = await h.files.read('logins', loginsDef, 'nobody');
    expect(missing === undefined || missing.exists === false).toBe(true);
  });

  test('F-0154 the tree is walked folder by folder from FY_HOME/config, a folder of files included', async () => {
    const h = configHarness();
    await h.files.write('logins', loginsDef, 'alpha', 'model: m\n');
    const directories = await h.files.directories();
    expect(directories).toEqual(expect.arrayContaining([`${HOME}/config`, `${HOME}/config/logins`]));
    expect(directories.every(directory => directory.startsWith(`${HOME}/config`))).toBe(true);
  });
});

/**
 * Today's generated editor schemas, config/.schema/<id>.json, one per file kind. 5.0 generates one per declared file or
 * folder, named by its claim (a file `warden.yaml` is `warden.json`; a folder's schema describes one item, so `logins/`
 * is `logins--item.json` and `claude-code/hooks/` is `claude-code--hooks--item.json`), from the same zod schema the
 * daemon checks the file with. `witness` is a property of today's kind that the schema still has.
 * Each row has its own test, titled with its id, so deleting one leaves its row unproven.
 */
describe('the generated schemas: FY_HOME/config/.schema', () => {
  async function published() {
    const memory = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs: memory,
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: declaredKinds().map(kind => ({ plugin: kind.plugin, def: kind.def })),
    } as never);
    await files.publishSchemas();
    return memory;
  }

  test('a schema is written under config/.schema/<claim>.json for every declared file, once, 0600', async () => {
    const memory = await published();
    for (const kind of declaredKinds()) {
      const path = `${HOME}/config/.schema/${schemaFileName(kind.def)}`;
      expect(memory.snapshot().get(path)).toBeDefined();
      expect(memory.modeOf(path)).toBe(0o600);
    }
    expect(
      schemaFileName(declaredKinds().find(kind => kind.path === 'claude-code/hooks/sweep.yaml')?.def as never),
    ).toBe('claude-code--hooks--item.json');
  });

  test('F-0142 F-0151 no two declared files share a schema name: runtimes.yaml and the runtimes/ folder each keep theirs', async () => {
    const owners = new Map<string, string[]>();
    for (const kind of declaredKinds()) {
      const name = schemaFileName(kind.def);
      owners.set(name, [...(owners.get(name) ?? []), `${kind.plugin}:${kind.path}`]);
    }
    expect([...owners].filter(([, paths]) => paths.length > 1)).toEqual([]);
    const memory = await published();
    const schemaOf = (name: string) =>
      JSON.parse(memory.snapshot().get(`${HOME}/config/.schema/${name}`) ?? '{}') as {
        properties?: Record<string, unknown>;
      };
    expect(Object.keys(schemaOf('runtimes.json').properties ?? {})).toEqual(
      expect.arrayContaining(['defaultRuntime', 'autoResume']),
    );
    expect(Object.keys(schemaOf('runtimes--item.json').properties ?? {})).toContain('login');
  });

  async function schemaIsWrittenFromItsKind(now: string, witness: string) {
    const memory = await published();
    const text = memory.snapshot().get(`${HOME}/config/.schema/${now}`);
    expect(text).toBeDefined();
    const schema = JSON.parse(text ?? '{}') as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toContain(witness);
    // It is generated text, byte for byte what the schema yields, so an editor and the daemon never disagree. Where
    // two declared files share a name the one published last (the later declaration) is what is on disk.
    const own = declaredKinds().filter(kind => schemaFileName(kind.def) === now);
    expect(configJsonSchemaText(own.at(-1)?.def as never)).toBe(text as string);
  }

  test('F-0132 today .schema/accountDefaults.json is now .schema/accounts.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('accounts.json', 'sites'));
  test('F-0133 today .schema/component-hooks.json is now .schema/claude-code--hooks--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('claude-code--hooks--item.json', 'hooks'));
  test('F-0135 today .schema/component-mcp.json is now .schema/mcp--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('mcp--item.json', 'command'));
  test('F-0136 today .schema/component-modelSets.json is now .schema/model-sets--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('model-sets--item.json', 'models'));
  test('F-0137 today .schema/component-settings.json is now .schema/claude-code--settings--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('claude-code--settings--item.json', 'settings'));
  test('F-0138 today .schema/component-skills.json is now .schema/skills--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('skills--item.json', 'items'));
  test('F-0139 today .schema/learning.json is now .schema/lessons.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('lessons.json', 'passiveDefault'));
  test('F-0140 today .schema/limits.json is now .schema/limits.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('limits.json', 'perFerret'));
  test('F-0141 today .schema/login.json is now .schema/logins--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('logins--item.json', 'store'));
  test('F-0143 today .schema/models.json is now .schema/models--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('models--item.json', 'detect'));
  test('F-0144 today .schema/modelsGuide.json is now .schema/packs.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('packs.json', 'routing'));
  test('F-0145 today .schema/pack.json is now .schema/packs.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('packs.json', 'enabled'));
  test('F-0146 today .schema/preset.json is now .schema/endpoints--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('endpoints--item.json', 'verified'));
  test('F-0147 today .schema/profile.json is now .schema/profiles--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('profiles--item.json', 'contents'));
  test('F-0148 today .schema/runtime.json is now .schema/runtimes--item.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('runtimes--item.json', 'login'));
  test('F-0149 today .schema/voice.json is now .schema/voice.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('voice.json', 'defaultEngine'));
  test('F-0150 today .schema/warden.json is now .schema/warden.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('warden.json', 'mayActAlone'));

  test('F-0377 machine.yaml is not a file in 5.0: its settings live in their owners’ files, each with its own schema', () => {
    const schemaOf = (path: string) => {
      const kind = declaredKinds().find(declared => declared.path === path);
      if (kind === undefined) throw new Error(`no declared file ${path}`);
      return JSON.parse(configJsonSchemaText(kind.def)) as { properties?: Record<string, unknown> };
    };
    // today's machine.yaml key -> the declared file that holds it now
    const moved: readonly (readonly [key: string, path: string, property: string])[] = [
      ['agentPermissions', 'harness-claude-code.yaml', 'permissionMode'],
      ['agentPermissions', 'harness-codex.yaml', 'permissionMode'],
      ['defaultRuntime', 'runtimes.yaml', 'defaultRuntime'],
      ['autoResume', 'runtimes.yaml', 'autoResume'],
      ['agentControl', 'limits.yaml', 'agentControl'],
      ['conversations', 'conversation.yaml', 'keepInSync'],
      ['browserMode', 'browsers.yaml', 'mode'],
      ['browserProxy', 'browsers.yaml', 'proxy'],
      ['agendaMode', 'agenda.yaml', 'agendaMode'],
      ['agendaNudge', 'agenda.yaml', 'agendaNudge'],
      ['timeZone', 'usage.yaml', 'timeZone'],
      ['publicUsageFeed', 'usage.yaml', 'publicFeed'],
    ];
    for (const [, path, property] of moved) expect(Object.keys(schemaOf(path).properties ?? {})).toContain(property);
    expect(declaredKinds().some(kind => kind.path === 'machine.yaml')).toBe(false);
  });
});

describe('the places today’s state-home fence names, as 5.0 keeps them (stateHomeFence)', () => {
  const key = (identity: { device: bigint; inode: bigint } | undefined): string =>
    identityKey(identity ?? { device: -1n, inode: -1n });

  /** A set-up home whose Runtimes root is served: the fleet folder with one runtime's home and one asset. */
  async function fleetHome() {
    const home = await freshHome();
    await openHome(fs, home, 'fyd 5.0.0', instantFromEpochMs(Date.UTC(2026, 10, 8)));
    const declared = ['fleet'] as const;
    await ensureInternalRootBases(fs, { home, plugin: 'runtimes' }, declared);
    const roots = rootsPortFor(
      fs,
      { home, plugin: 'runtimes', worktrees: `${home}-worktrees` },
      declared,
      () => undefined,
    );
    const fleet = roots.root('fleet');
    const at = (root: RootHandle, path: string): FencedPath => {
      const resolved = root.resolve(path);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
    await fleet.makeDirectory(at(fleet, 'assets/skills/tidy'));
    const assets = roots.root('fleet', { subfolder: 'assets' });
    await assets.writeText(at(assets, 'skills/tidy/SKILL.md'), '# tidy\n');
    return { home, fleet, assets, at };
  }

  test('F-0027 the config folder is a place of the fence by its real path: one linked out of the home is fenced wherever it lives', async () => {
    const home = await freshHome();
    await openHome(fs, home, 'fyd 5.0.0', instantFromEpochMs(Date.UTC(2026, 10, 8)));
    const elsewhere = join(dirname(home), 'elsewhere-config');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'warden.yaml'), 'mayActAlone: false\n');
    await rm(join(home, 'config'), { recursive: true });
    await symlink(elsewhere, join(home, 'config'));
    const fence = await fenceOf(fs, home);
    const real = await realpath(elsewhere);
    expect(fence.places).toContain(real);
    expect(fencedByName(fence, join(real, 'warden.yaml'))).toBe(true);
    expect(await fencedReal(fs, fence, join(real, 'warden.yaml'))).toBe(true);
    expect(fencedByName(fence, join(dirname(home), 'beside', 'warden.yaml'))).toBe(false);
  });

  test('F-0029 F-0046 the fleet’s assets are FY_HOME/fleet/assets, in the 0700 fleet folder the kernel makes, and open through the fleet root alone', async () => {
    const { home, assets, at } = await fleetHome();
    expect(await modeOf(join(home, 'fleet'))).toBe(0o700);
    expect(await kindOf(join(home, 'fleet', 'assets', 'skills', 'tidy'))).toBe('directory');
    expect(await assets.readText(at(assets, 'skills/tidy/SKILL.md'))).toBe('# tidy\n');
    // Inside the fenced home it is open to no owner's root: a work folder named at the assets reaches nothing.
    const work = rootsPortFor(fs, { home, plugin: 'ferrets', worktrees: `${home}-worktrees` }, ['work'], () => ({
      folderOf: () => join(home, 'fleet', 'assets') as FencedPath,
      check: (_ferret, path) => ok(path as FencedPath),
    })).root('work', { ferret: 'F1' as FerretId });
    const resolved = work.resolve('skills/tidy/SKILL.md');
    const refusal = resolved.ok
      ? await work.readText(resolved.value).then(
          () => 'read',
          (error: unknown) => (error instanceof RootError ? error.refusal : String(error)),
        )
      : resolved.error;
    expect(refusal).toBe('fenced');
  });

  test('F-0030 FY_HOME/fleet/homes is held by identity: a harness home the fleet made is a folder the fence knows by device and inode', async () => {
    const { home } = await fleetHome();
    const fence = await fenceOf(fs, home);
    expect(PINNED_KEY_PATHS).toContain('fleet/homes');
    expect(fence.keys.has(key(await fs.identity(join(home, 'fleet', 'homes'))))).toBe(true);
    expect(fence.keys.has(key(await fs.identity(join(home, 'fleet'))))).toBe(true);
    expect(fence.keys.has(key(await fs.identity(join(home, 'fleet', 'assets'))))).toBe(false);
  });

  test('F-0034 the sessions folder is held by identity at today’s state/sessions and at the place 5.0 keeps it, state/ferrets/sessions', async () => {
    const home = await freshHome();
    await openHome(fs, home, 'fyd 5.0.0', instantFromEpochMs(Date.UTC(2026, 10, 8)));
    for (const folder of ['state/sessions', 'state/ferrets/sessions', 'state/ferrets/other']) {
      await mkdir(join(home, folder), { recursive: true });
    }
    expect(PINNED_KEY_PATHS).toContain('state/sessions');
    expect(internalRootPins(['ferrets'])).toContain('state/ferrets/sessions');
    const fence = await fenceOf(fs, home);
    expect(fence.keys.has(key(await fs.identity(join(home, 'state/sessions'))))).toBe(true);
    expect(fence.keys.has(key(await fs.identity(join(home, 'state/ferrets/sessions'))))).toBe(true);
    expect(fence.keys.has(key(await fs.identity(join(home, 'state/ferrets/other'))))).toBe(false);
  });

  test('F-0096 a component’s folder is FY_HOME/state/<plugin>, made 0700 on the first write, and a link planted at a file there is never followed', async () => {
    const home = await freshHome();
    await openHome(fs, home, 'fyd 5.0.0', instantFromEpochMs(Date.UTC(2026, 10, 8)));
    const counter = defineState({
      name: 'counter',
      path: 'counter.json',
      store: 'json',
      format: 1,
      schema: z.strictObject({ count: z.number().int() }),
    });
    const port = createStatePort({ home, pluginId: 'demo', files: [counter], fs: createNodeHostFs() });
    await port.write(counter, { count: 5 });
    const folder = join(home, 'state', 'demo');
    expect(await kindOf(folder)).toBe('directory');
    expect(await modeOf(folder)).toBe(0o700);
    expect(await modeOf(join(folder, 'counter.json'))).toBe(0o600);
    await rm(join(folder, 'counter.json'));
    await writeFile(join(home, 'elsewhere.json'), '{"format":1,"count":1}');
    await symlink(join(home, 'elsewhere.json'), join(folder, 'counter.json'));
    const read = await port.read(counter);
    expect(read.ok).toBe(false);
  });
});
