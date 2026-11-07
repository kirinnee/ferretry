import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineState } from '../../../contract/index.ts';
import { StoreDamagedError } from '../../../host/state/errors.ts';
import type { FileOperations } from '../../../host/state/file-operations.ts';
import { NodeFileOperations } from '../../../host/state/file-operations.ts';
import { acquireHomeLock, StateHomeLockedError } from '../../../host/state/home-lock.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { moveStateAside, openPluginState } from '../../../host/state/open-plugin-state.ts';
import { createStatePort } from '../../../host/state/state-port.ts';

const homes: string[] = [];
const freshHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'fy-kernel-state-'));
  homes.push(home);
  return home;
};
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const Counter = z.strictObject({ count: z.number().int() });
const counter = defineState({ name: 'counter', path: 'counter.json', store: 'json', format: 1, schema: Counter });
const log = defineState({ name: 'log', path: 'log.jsonl', store: 'jsonl', format: 1, schema: Counter });
const key = defineState({ name: 'key', path: 'k.key', store: 'secret', format: 1 });
const db = defineState({ name: 'db', path: 'index.sqlite', store: 'sqlite', format: 2 });
const cache = defineState({ name: 'cache', path: 'cache.sqlite', store: 'sqlite-cache', format: 2 });
const files = [counter, log, key, db, cache];

/** Fails exactly one named step of the atomic write, leaving every other step honest. */
class CrashingFileOperations extends NodeFileOperations implements FileOperations {
  constructor(private readonly crashOn: 'replace' | 'write') {
    super();
  }
  override async replace(from: string, to: string): Promise<void> {
    if (this.crashOn === 'replace') throw new Error('crash before the rename');
    await super.replace(from, to);
  }
  override async write(path: string, contents: string | Uint8Array, mode: number): Promise<void> {
    if (this.crashOn === 'write') {
      await writeFile(path, 'half a docu');
      throw new Error('crash mid write');
    }
    await super.write(path, contents, mode);
  }
}

describe('the store on a real disk', () => {
  test('a crash between the scratch file and the rename leaves the previous document, readable', async () => {
    const home = await freshHome();
    const good = createStatePort({ home, pluginId: 'demo', files, fs: createNodeHostFs() });
    await good.write(counter, { count: 1 });
    for (const crashOn of ['replace', 'write'] as const) {
      const crashing = createStatePort({
        home,
        pluginId: 'demo',
        files,
        fs: createNodeHostFs({ files: new CrashingFileOperations(crashOn) }),
      });
      await expect(crashing.write(counter, { count: 2 })).rejects.toThrow('crash');
      expect(await good.read(counter)).toEqual({ ok: true, value: { count: 1 } });
    }
  });

  test('an atomic write is temp + rename: no scratch file survives, the mode is private, "format" is first', async () => {
    const home = await freshHome();
    const port = createStatePort({ home, pluginId: 'demo', files, fs: createNodeHostFs() });
    await port.write(counter, { count: 5 });
    await port.write(counter, { count: 6 });
    const folder = join(home, 'state', 'demo');
    expect(await readdir(folder)).toEqual(['counter.json']);
    expect((await stat(join(folder, 'counter.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await Bun.file(join(folder, 'counter.json')).text()).toStartWith('{\n  "format": 1,');
  });

  test('a secret is written 0600 and read back byte for byte', async () => {
    const home = await freshHome();
    const port = createStatePort({ home, pluginId: 'demo', files, fs: createNodeHostFs() });
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await port.write(key, bytes);
    expect((await stat(join(home, 'state', 'demo', 'k.key'))).mode & 0o777).toBe(0o600);
    const read = await port.read(key);
    expect(read.ok && [...(read.value as Uint8Array)]).toEqual([...bytes]);
  });

  test('a link planted where a state file belongs is never followed', async () => {
    const home = await freshHome();
    const folder = join(home, 'state', 'demo');
    await createNodeHostFs().ensureDirectory(folder, 0o700);
    await writeFile(join(home, 'elsewhere.json'), '{"format":1,"count":1}');
    await symlink(join(home, 'elsewhere.json'), join(folder, 'counter.json'));
    const port = createStatePort({ home, pluginId: 'demo', files, fs: createNodeHostFs() });
    const read = await port.read(counter);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.reason).toBe('io');
  });

  test('a jsonl file survives a torn tail on disk: the next append cuts it off and the history reads whole', async () => {
    const home = await freshHome();
    const port = createStatePort({ home, pluginId: 'demo', files, fs: createNodeHostFs() });
    await port.append(log, { count: 1 });
    const path = join(home, 'state', 'demo', 'log.jsonl');
    await writeFile(path, `${await Bun.file(path).text()}{"format":1,"cou`);
    await port.append(log, { count: 2 });
    const got: unknown[] = [];
    for await (const entry of port.lines(log)) got.push(entry);
    expect(got).toEqual([{ count: 1 }, { count: 2 }]);
  });

  test('sqlite: format lives in user_version; a mismatch is damaged and nothing is touched', async () => {
    const home = await freshHome();
    const port = createStatePort({ home, pluginId: 'demo', files, fs: createNodeHostFs() });
    const handle = port.sqlite(db);
    handle.run('CREATE TABLE t (id INTEGER)');
    handle.run('INSERT INTO t VALUES (?)', [7]);
    handle.close();
    expect(port.sqlite(db).query<{ id: number }>('SELECT id FROM t')).toEqual([{ id: 7 }]);
    const older = defineState({ name: 'db', path: 'index.sqlite', store: 'sqlite', format: 1 });
    const newer = defineState({ name: 'db', path: 'index.sqlite', store: 'sqlite', format: 3 });
    const lower = createStatePort({ home, pluginId: 'demo', files: [older], fs: createNodeHostFs() });
    expect(() => lower.sqlite(older)).toThrow(StoreDamagedError);
    const higher = createStatePort({ home, pluginId: 'demo', files: [newer], fs: createNodeHostFs() });
    expect(() => higher.sqlite(newer)).toThrow(StoreDamagedError);
    expect(higher.damaged().map(d => d.reason)).toEqual(['lower_format']);
    const opened = await openPluginState({
      home,
      pluginId: 'demo',
      files: [newer],
      fs: createNodeHostFs(),
      clock: { now: () => '2026-11-07T09:05:00.000Z' as never },
      kind: 'core',
      liveTargets: false,
    });
    expect(opened.damaged.map(d => d.reason)).toEqual(['lower_format']);
    expect(port.sqlite(db).query<{ id: number }>('SELECT id FROM t')).toEqual([{ id: 7 }]);
  });

  test('sqlite-cache: a format mismatch, or a file that is not a database, is dropped and rebuilt', async () => {
    const home = await freshHome();
    const stale = defineState({ name: 'cache', path: 'cache.sqlite', store: 'sqlite-cache', format: 1 });
    const old = createStatePort({ home, pluginId: 'demo', files: [stale], fs: createNodeHostFs() });
    const first = old.sqlite(stale);
    first.run('CREATE TABLE c (v TEXT)');
    first.run("INSERT INTO c VALUES ('old')");
    first.close();
    const port = createStatePort({ home, pluginId: 'demo', files, fs: createNodeHostFs() });
    const rebuilt = port.sqlite(cache);
    expect(rebuilt.query('SELECT name FROM sqlite_master')).toEqual([]);
    rebuilt.close();
    await writeFile(join(home, 'state', 'demo', 'cache.sqlite'), 'this is not sqlite');
    const again = port.sqlite(cache);
    expect(again.query('SELECT name FROM sqlite_master')).toEqual([]);
    again.close();
    expect(port.damaged()).toEqual([]);
  });

  test('moving a plugin folder aside on a real disk is 0700 and keeps every file', async () => {
    const home = await freshHome();
    const fs = createNodeHostFs();
    const port = createStatePort({ home, pluginId: 'demo', files, fs });
    await port.write(counter, { count: 1 });
    const to = join(home, 'state', 'demo-before-2026-11-07-0905');
    await moveStateAside(fs, { from: join(home, 'state', 'demo'), to });
    expect((await stat(to)).mode & 0o777).toBe(0o700);
    expect(await readdir(to)).toEqual(['counter.json']);
    expect(await readdir(join(home, 'state', 'demo'))).toEqual([]);
  });
});

describe('the home lock on a real disk', () => {
  test('G57 a second daemon is refused with the lock file and `fy daemon adopt`; a freed lock can be taken', async () => {
    const home = await freshHome();
    const first = await acquireHomeLock({ home, binary: 'fy' });
    const refused = await acquireHomeLock({ home, binary: 'fy' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateHomeLockedError);
    expect((refused as StateHomeLockedError).lockFile).toBe(join(home, 'run', 'daemon.lock'));
    expect((refused as StateHomeLockedError).message).toContain('`fy daemon adopt`');
    await first.release();
    const second = await acquireHomeLock({ home, binary: 'fy' });
    await second.release();
    expect((await stat(join(home, 'run', 'daemon.lock'))).mode & 0o777).toBe(0o600);
  });

  test('a failure that is not a lock surfaces as itself, and leaves the lock free', async () => {
    const home = await freshHome();
    const failed = await acquireHomeLock({
      home,
      binary: 'fy',
      setMode: () => {
        throw new Error('injected mode failure');
      },
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(StateHomeLockedError);
    await (await acquireHomeLock({ home, binary: 'fy' })).release();
  });
});
