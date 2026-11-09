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
 * (F-0384) is an artefact that a clean slate does not keep. F-0033 (the identity key's pin) is not proved here: the fence
 * pins no 5.0 key path yet, and the unit that fixes it ticks the row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instantFromEpochMs } from '@ferretry/std';
import { FerretIndexFile } from '../../../../ferrets/contract/state.ts';
import { acceptedName } from '../../../contract/accepted.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
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
 * folder, named by its claim (`logins/` is `logins.json`, `claude-code/hooks/` is `claude-code--hooks.json`), from the
 * same zod schema the daemon checks the file with. `witness` is a property of today's kind that the schema still has.
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
    ).toBe('claude-code--hooks.json');
  });

  test('F-0151 (open, GAP schema file name collision) pins the one name two declared files share: .schema/runtimes.json (runtimes.yaml and the runtimes/ folder)', () => {
    const owners = new Map<string, string[]>();
    for (const kind of declaredKinds()) {
      const name = schemaFileName(kind.def);
      owners.set(name, [...(owners.get(name) ?? []), `${kind.plugin}:${kind.path}`]);
    }
    const shared = [...owners].filter(([, paths]) => paths.length > 1);
    // Pinned as it stands (ports-pending `[kernel: schema file name collision]`): it goes red the day the collision is
    // fixed, or when a second one appears, and whoever does either updates this and the row.
    expect(shared.map(([name]) => name)).toEqual(['runtimes.json']);
    expect(shared[0]?.[1].length).toBe(2);
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
  test('F-0133 today .schema/component-hooks.json is now .schema/claude-code--hooks.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('claude-code--hooks.json', 'hooks'));
  test('F-0135 today .schema/component-mcp.json is now .schema/mcp.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('mcp.json', 'command'));
  test('F-0136 today .schema/component-modelSets.json is now .schema/model-sets.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('model-sets.json', 'models'));
  test('F-0137 today .schema/component-settings.json is now .schema/claude-code--settings.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('claude-code--settings.json', 'settings'));
  test('F-0138 today .schema/component-skills.json is now .schema/skills.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('skills.json', 'items'));
  test('F-0139 today .schema/learning.json is now .schema/lessons.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('lessons.json', 'passiveDefault'));
  test('F-0140 today .schema/limits.json is now .schema/limits.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('limits.json', 'perFerret'));
  test('F-0141 today .schema/login.json is now .schema/logins.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('logins.json', 'store'));
  test('F-0143 today .schema/models.json is now .schema/models.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('models.json', 'detect'));
  test('F-0144 today .schema/modelsGuide.json is now .schema/packs.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('packs.json', 'routing'));
  test('F-0145 today .schema/pack.json is now .schema/packs.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('packs.json', 'enabled'));
  test('F-0146 today .schema/preset.json is now .schema/endpoints.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('endpoints.json', 'verified'));
  test('F-0147 today .schema/profile.json is now .schema/profiles.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('profiles.json', 'contents'));
  test('F-0148 today .schema/runtime.json is now .schema/runtimes.json, written from the schema the daemon checks with', () =>
    schemaIsWrittenFromItsKind('runtimes.json', 'login'));
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
