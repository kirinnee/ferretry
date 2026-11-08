import { describe, expect, test } from 'bun:test';
import { defineConfig } from '../../../contract/index.ts';
import type { ConfigWriteAllDocument } from '../../../contract/ports.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { acceptedConfigFile, acceptedName } from '../../../host/config/accepted.ts';
import { createStatePort } from '../../../host/state/state-port.ts';
import { createMemoryHostFs, type MemoryHostFs } from '../../../host/state/memory-fs.ts';
import type { HostFs } from '../../../host/state/host-fs.ts';
import { z } from 'zod';
import { captureLog, HOME, loginsDef, manualClock, updatesDef } from './support.ts';

/**
 * `ConfigPort.writeAll`: several of a plugin's own files as ONE act. All or none, each document's own `ifMatch`, each
 * judged as a single write is (the same judge, per document, with its own path), one held document holds the whole
 * set, and a stop mid-set puts every file back on the next load.
 */
const UPDATES = `${HOME}/config/updates.yaml`;
const LOGIN_A = `${HOME}/config/logins/a.yaml`;
const JOURNAL = `${HOME}/state/kernel/config-write-set.json`;
const RAW_SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const otherDef = defineConfig({
  file: 'other.yaml',
  schema: z.strictObject({ on: z.boolean().default(false) }),
  axis: 'configure',
  loosens: () => [],
});

interface Asked {
  readonly plugin: string;
  readonly path: string;
  readonly removal: boolean;
  readonly sentences: readonly string[];
}

function harness(options: { readonly verdict?: boolean; readonly fs?: HostFs; readonly base?: MemoryHostFs } = {}) {
  const base = options.base ?? createMemoryHostFs();
  const fs = options.fs ?? base;
  const log = captureLog();
  const asked: Asked[] = [];
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log,
    binary: 'fy',
    defs: [
      { plugin: 'p', def: updatesDef },
      { plugin: 'p', def: loginsDef },
      { plugin: 'q', def: otherDef },
    ],
    judge: input => (asked.push(input), options.verdict ?? false),
  });
  const port = files.port('p');
  const disk = (path: string): string | undefined => base.snapshot().get(path);
  /** limit 5 and login `a` with a budget of 5, both in effect (tightenings: nothing asked). */
  const start = async () => {
    await files.reload();
    expect((await port.write(updatesDef, undefined, 'limit: 5\n')).kind).toBe('written');
    expect((await port.write(loginsDef, 'a', 'budget: 5\n')).kind).toBe('written');
    asked.length = 0;
  };
  return { base, fs, log, files, port, asked, disk, start };
}

/** A tightening set: the limit down, login `a`'s budget down, a new login `b`. */
const TIGHTEN: readonly ConfigWriteAllDocument[] = [
  { def: updatesDef, edit: { patch: { limit: 3 } } },
  { def: loginsDef, name: 'a', edit: 'budget: 2\n' },
  { def: loginsDef, name: 'b', edit: 'budget: 1\n' },
];

describe('writeAll: all or none', () => {
  test('a set that checks is written whole: every file in effect, every record moved, no intent record left', async () => {
    const h = harness();
    await h.start();
    const outcome = await h.port.writeAll(TIGHTEN);
    expect(outcome.kind).toBe('written');
    if (outcome.kind !== 'written') return;
    expect(outcome.documents.map(({ path, name, removed, loosened }) => ({ path, name, removed, loosened }))).toEqual([
      { path: 'updates.yaml', name: undefined, removed: false, loosened: [] },
      { path: 'logins/a.yaml', name: 'a', removed: false, loosened: [] },
      { path: 'logins/b.yaml', name: 'b', removed: false, loosened: [] },
    ]);
    expect(h.port.file(updatesDef)).toEqual({ limit: 3 });
    expect([...h.port.collection(loginsDef)]).toEqual([
      ['a', { model: 'x', budget: 2 }],
      ['b', { model: 'x', budget: 1 }],
    ]);
    expect(h.disk(JOURNAL)).toBeUndefined();
    // the etag each answer names is the file's own: it reads back as that file
    const read = await h.files.read('p', loginsDef, 'b');
    expect(read?.etag).toBe(outcome.documents[2]?.etag as string);
  });

  test('one document refused refuses the set and names it; nothing else is written', async () => {
    const h = harness();
    await h.start();
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 1\n' },
      { def: loginsDef, name: 'a', edit: 'budget: "many"\n' },
    ]);
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'schema',
      document: { path: 'logins/a.yaml', name: 'a' },
    });
    expect(h.port.file(updatesDef)).toEqual({ limit: 5 });
    expect(h.disk(UPDATES)).toBe('limit: 5\n');
    expect(h.disk(JOURNAL)).toBeUndefined();
  });

  test('a raw secret in one document refuses the set, and its value is in no answer and no log', async () => {
    const h = harness();
    await h.start();
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 1\n' },
      { def: loginsDef, name: 'b', edit: `model: ${RAW_SECRET}\n` },
    ]);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'raw_secret', document: { path: 'logins/b.yaml' } });
    expect(JSON.stringify(outcome)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(h.log.lines)).not.toContain(RAW_SECRET);
    expect(h.disk(UPDATES)).toBe('limit: 5\n');
  });

  test('a file on disk that holds a raw secret refuses the set, so the intent record never copies it', async () => {
    const h = harness();
    await h.start();
    h.base.seed(LOGIN_A, `budget: 5\nmodel: ${RAW_SECRET}\n`);
    await h.files.reload();
    const outcome = await h.port.writeAll([{ def: loginsDef, name: 'a', edit: 'budget: 1\n' }]);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'raw_secret', document: { path: 'logins/a.yaml' } });
    expect(JSON.stringify(outcome)).not.toContain(RAW_SECRET);
    for (const [path, text] of h.base.snapshot()) if (path.includes('/state/')) expect(text).not.toContain(RAW_SECRET);
  });

  test('another plugin’s file, a bad name and the same file twice each refuse the set before anything is read', async () => {
    const h = harness();
    await h.start();
    expect(
      await h.port.writeAll([
        { def: updatesDef, edit: 'limit: 1\n' },
        { def: otherDef, edit: 'on: true\n' },
      ]),
    ).toEqual({ kind: 'refused', reason: 'not_declared', document: { path: 'other.yaml' }, issues: [] });
    expect(await h.port.writeAll([{ def: loginsDef, name: 'Bad Name', edit: 'budget: 1\n' }])).toEqual({
      kind: 'refused',
      reason: 'bad_name',
      document: { path: 'logins', name: 'Bad Name' },
      issues: [],
    });
    expect(
      await h.port.writeAll([
        { def: loginsDef, name: 'a', edit: 'budget: 1\n' },
        { def: loginsDef, name: 'a', edit: 'budget: 2\n' },
      ]),
    ).toMatchObject({ kind: 'refused', reason: 'duplicate', document: { path: 'logins/a.yaml' } });
    expect(h.port.file(updatesDef)).toEqual({ limit: 5 });
    expect(h.disk(LOGIN_A)).toBe('budget: 5\n');
  });

  test('an empty set is written with no documents and touches nothing', async () => {
    const h = harness();
    await h.start();
    const before = new Map(h.base.snapshot());
    expect(await h.port.writeAll([])).toEqual({ kind: 'written', documents: [] });
    expect(new Map(h.base.snapshot())).toEqual(before);
  });

  test('a removal rides in a set: the file and its record go with the rest', async () => {
    const h = harness({ verdict: true });
    await h.start();
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 2\n' },
      { def: loginsDef, name: 'a', edit: { remove: true } },
    ]);
    expect(outcome).toMatchObject({
      kind: 'written',
      documents: [
        { path: 'updates.yaml', removed: false },
        { path: 'logins/a.yaml', removed: true, etag: 'absent', loosened: ['raises or removes the budget'] },
      ],
    });
    expect(h.disk(LOGIN_A)).toBeUndefined();
    expect(h.port.collection(loginsDef).size).toBe(0);
    const state = createStatePort({ home: HOME, pluginId: 'kernel', files: [acceptedConfigFile], fs: h.base });
    expect(await state.read(acceptedConfigFile, acceptedName('logins/a.yaml'))).toEqual({ ok: true, value: undefined });
  });
});

describe('writeAll: each document its own ifMatch', () => {
  test('one stale document is a conflict naming it, and no document is written', async () => {
    const h = harness();
    await h.start();
    const updates = await h.files.read('p', updatesDef);
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 1\n', ifMatch: updates?.etag as string },
      { def: loginsDef, name: 'a', edit: 'budget: 1\n', ifMatch: 'not-the-etag' },
    ]);
    expect(outcome).toEqual({ kind: 'conflict', path: 'logins/a.yaml', name: 'a' });
    expect(h.disk(UPDATES)).toBe('limit: 5\n');
    expect(h.disk(LOGIN_A)).toBe('budget: 5\n');
  });

  test('every ifMatch current: written; "absent" expects nothing there', async () => {
    const h = harness();
    await h.start();
    const updates = await h.files.read('p', updatesDef);
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 1\n', ifMatch: updates?.etag as string },
      { def: loginsDef, name: 'b', edit: 'budget: 1\n', ifMatch: 'absent' },
    ]);
    expect(outcome.kind).toBe('written');
    // a file expected absent that is there is stale
    expect(await h.port.writeAll([{ def: loginsDef, name: 'b', edit: 'budget: 0\n', ifMatch: 'absent' }])).toEqual({
      kind: 'conflict',
      path: 'logins/b.yaml',
      name: 'b',
    });
  });

  test('a file that moved on disk since the last reload is a conflict even without an ifMatch', async () => {
    const h = harness();
    await h.start();
    h.base.seed(LOGIN_A, 'budget: 4\n');
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 1\n' },
      { def: loginsDef, name: 'a', edit: 'budget: 1\n' },
    ]);
    expect(outcome).toEqual({ kind: 'conflict', path: 'logins/a.yaml', name: 'a' });
    expect(h.disk(UPDATES)).toBe('limit: 5\n');
  });
});

describe('writeAll: one held document holds the whole set', () => {
  test('a loosening the judge holds: NOTHING is written, and the outcome names the document and says the set is held', async () => {
    const h = harness({ verdict: false });
    await h.start();
    const before = new Map(h.base.snapshot());
    const outcome = await h.port.writeAll([
      { def: loginsDef, name: 'a', edit: 'budget: 1\n' },
      { def: updatesDef, edit: 'limit: 50\n' },
    ]);
    expect(outcome).toEqual({
      kind: 'held',
      held: [{ path: 'updates.yaml', sentences: ['raises the limit from 5 to 50'] }],
      sentence:
        'updates.yaml (raises the limit from 5 to 50) loosens what this machine may spend or do, so the whole set is ' +
        'held for the owner: none of its 2 documents was written and nothing in it took effect. Ask the owner to make ' +
        'this change.',
    });
    // the tightening beside it did not take effect either, and nothing waits on disk
    expect(new Map(h.base.snapshot())).toEqual(before);
    expect(h.port.collection(loginsDef).get('a')).toEqual({ model: 'x', budget: 5 });
    expect(h.files.held()).toEqual([]);
  });

  test('the SAME judge a single write asks is asked, per document, with that document’s own path', async () => {
    const h = harness({ verdict: true });
    await h.start();
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 50\n' },
      { def: loginsDef, name: 'a', edit: 'budget: 1\n' },
      { def: loginsDef, name: 'b', edit: 'model: y\n' },
    ]);
    expect(outcome).toMatchObject({
      kind: 'written',
      documents: [{ loosened: ['raises the limit from 5 to 50'] }, { loosened: [] }, { loosened: [] }],
    });
    // a tightening is never asked about; the loosening is asked as `write` asks it
    expect(h.asked).toEqual([
      { plugin: 'p', path: 'updates.yaml', removal: false, sentences: ['raises the limit from 5 to 50'] },
    ]);
    h.asked.length = 0;
    expect((await h.port.write(updatesDef, undefined, 'limit: 60\n')).kind).toBe('written');
    expect(h.asked).toEqual([
      { plugin: 'p', path: 'updates.yaml', removal: false, sentences: ['raises the limit from 50 to 60'] },
    ]);
  });

  test('a removal is judged as `remove` judges it (removal: true), and held it holds the set', async () => {
    const h = harness({ verdict: false });
    await h.start();
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 1\n' },
      { def: loginsDef, name: 'a', edit: { remove: true } },
    ]);
    expect(outcome).toMatchObject({ kind: 'held', held: [{ path: 'logins/a.yaml', name: 'a' }] });
    expect(h.asked).toEqual([
      { plugin: 'p', path: 'logins/a.yaml', removal: true, sentences: ['raises or removes the budget'] },
    ]);
    expect(h.disk(LOGIN_A)).toBe('budget: 5\n');
    expect(h.disk(UPDATES)).toBe('limit: 5\n');
  });

  test('the first held document stops the asking: a later loosening is not asked about and not named', async () => {
    const h = harness({ verdict: false });
    await h.start();
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 50\n' },
      { def: loginsDef, name: 'a', edit: 'model: y\n' },
    ]);
    expect(outcome).toMatchObject({ kind: 'held', held: [{ path: 'updates.yaml' }] });
    expect(h.asked.map(item => item.path)).toEqual(['updates.yaml']);
  });

  test('an added ${secret:NAME} holds the set before ANY judge is asked, even one that would let it through', async () => {
    const h = harness({ verdict: true });
    await h.start();
    const outcome = await h.port.writeAll([
      { def: updatesDef, edit: 'limit: 50\n' },
      { def: loginsDef, name: 'b', edit: 'model: ${secret:MODEL_KEY}\n' },
    ]);
    expect(outcome).toMatchObject({ kind: 'held', held: [{ path: 'logins/b.yaml', name: 'b' }] });
    if (outcome.kind === 'held') expect(outcome.sentence).toContain('the whole set is held');
    expect(h.asked).toEqual([]);
    expect(h.disk(UPDATES)).toBe('limit: 5\n');
  });

  test('a file with an edit already held for the owner refuses the set: a set never discards a held edit', async () => {
    const h = harness();
    await h.start();
    h.base.seed(UPDATES, 'limit: 70\n');
    await h.files.reload();
    expect(h.files.held()).toHaveLength(1);
    const outcome = await h.port.writeAll([
      { def: loginsDef, name: 'a', edit: 'budget: 1\n' },
      { def: updatesDef, edit: 'limit: 1\n' },
    ]);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'already_held', document: { path: 'updates.yaml' } });
    expect(h.disk(UPDATES)).toBe('limit: 70\n');
    expect(h.files.held()).toHaveLength(1);
    expect(h.disk(LOGIN_A)).toBe('budget: 5\n');
  });
});

/**
 * A disk that dies: the first write or removal `target` picks throws, and with `dead` every write after it throws
 * too — a daemon that stopped there and never ran another line.
 */
function dyingDisk(
  base: MemoryHostFs,
  target: (op: 'write' | 'remove', path: string) => boolean,
  dead: boolean,
): HostFs {
  let died = false;
  const fail = (op: 'write' | 'remove', path: string): void => {
    if (died) throw new Error('the daemon stopped');
    if (target(op, path)) {
      died = dead;
      if (!dead) target = () => false;
      throw new Error('the disk failed');
    }
  };
  return {
    ...base,
    writeAtomic: async (path, data, mode) => {
      fail('write', path);
      await base.writeAtomic(path, data, mode);
    },
    remove: async path => {
      fail('remove', path);
      await base.remove(path);
    },
  };
}

describe('writeAll: a stop mid-set honours the last good version of every document', () => {
  const PRIOR = new Map([
    [UPDATES, 'limit: 5\n'],
    [LOGIN_A, 'budget: 5\n'],
  ]);

  test('stopped between two files: the next load puts BOTH back, records included, and removes the intent record', async () => {
    const base = createMemoryHostFs();
    const first = harness({ base });
    await first.start();
    const accepted = createStatePort({ home: HOME, pluginId: 'kernel', files: [acceptedConfigFile], fs: base });
    const recordBefore = await accepted.read(acceptedConfigFile, acceptedName('updates.yaml'));
    // the second config file of the set is where it stops
    const dying = harness({ base, fs: dyingDisk(base, (_op, path) => path === LOGIN_A, true) });
    await dying.files.reload();
    await expect(
      dying.port.writeAll([
        { def: updatesDef, edit: 'limit: 1\n' },
        { def: loginsDef, name: 'a', edit: 'budget: 1\n' },
      ]),
    ).rejects.toThrow('the disk failed');
    // what the stopped daemon left: the first file new, the intent record there
    expect(base.snapshot().get(UPDATES)).toBe('limit: 1\n');
    expect(base.snapshot().get(JOURNAL)).toBeDefined();
    // the next daemon's first load
    const next = harness({ base });
    await next.files.reload();
    for (const [path, text] of PRIOR) expect(base.snapshot().get(path)).toBe(text);
    expect(base.snapshot().get(JOURNAL)).toBeUndefined();
    expect(await accepted.read(acceptedConfigFile, acceptedName('updates.yaml'))).toEqual(recordBefore);
    expect(next.port.file(updatesDef)).toEqual({ limit: 5 });
    expect(next.port.collection(loginsDef).get('a')).toEqual({ model: 'x', budget: 5 });
    expect(next.files.held()).toEqual([]);
    expect(next.log.lines.some(line => line.includes('did not finish'))).toBe(true);
  });

  test('a file the owner changed while the daemon was down is left as they made it; the rest of the set is put back', async () => {
    const base = createMemoryHostFs();
    const first = harness({ base });
    await first.start();
    const dying = harness({ base, fs: dyingDisk(base, (op, path) => op === 'remove' && path === JOURNAL, true) });
    await dying.files.reload();
    await expect(
      dying.port.writeAll([
        { def: updatesDef, edit: 'limit: 1\n' },
        { def: loginsDef, name: 'b', edit: 'budget: 1\n' },
      ]),
    ).rejects.toThrow();
    // while the daemon is down the owner tightens updates.yaml by hand
    await base.writeAtomic(UPDATES, 'limit: 2\n', 0o600);
    const next = harness({ base });
    await next.files.reload();
    expect(base.snapshot().get(UPDATES)).toBe('limit: 2\n');
    expect(base.snapshot().get(`${HOME}/config/logins/b.yaml`)).toBeUndefined();
    expect(base.snapshot().get(JOURNAL)).toBeUndefined();
    expect(next.log.lines.some(line => line.includes('1 changed since were left as they are'))).toBe(true);
  });

  test('stopped after every file and record but before the commit: still put back whole (the removal IS the commit)', async () => {
    const base = createMemoryHostFs();
    const first = harness({ base });
    await first.start();
    const dying = harness({ base, fs: dyingDisk(base, (op, path) => op === 'remove' && path === JOURNAL, true) });
    await dying.files.reload();
    await expect(
      dying.port.writeAll([
        { def: updatesDef, edit: 'limit: 1\n' },
        { def: loginsDef, name: 'b', edit: 'budget: 1\n' },
      ]),
    ).rejects.toThrow();
    // every file and record of the set landed; only the commit did not
    expect(base.snapshot().get(UPDATES)).toBe('limit: 1\n');
    expect(base.snapshot().get(`${HOME}/config/logins/b.yaml`)).toBe('budget: 1\n');
    expect(base.snapshot().get(JOURNAL)).toBeDefined();
    const next = harness({ base });
    await next.files.reload();
    expect(base.snapshot().get(UPDATES)).toBe('limit: 5\n');
    expect(base.snapshot().get(`${HOME}/config/logins/b.yaml`)).toBeUndefined();
    expect(next.port.collection(loginsDef).has('b')).toBe(false);
  });

  test('a disk failure the daemon survives puts the set back at once and throws; nothing of it is in effect', async () => {
    const base = createMemoryHostFs();
    await harness({ base }).start();
    const h = harness({ base, fs: dyingDisk(base, (_op, path) => path === LOGIN_A, false) });
    await h.files.reload();
    await expect(
      h.port.writeAll([
        { def: updatesDef, edit: 'limit: 1\n' },
        { def: loginsDef, name: 'a', edit: 'budget: 1\n' },
      ]),
    ).rejects.toThrow('the disk failed');
    for (const [path, text] of PRIOR) expect(base.snapshot().get(path)).toBe(text);
    expect(base.snapshot().get(JOURNAL)).toBeUndefined();
    expect(h.port.file(updatesDef)).toEqual({ limit: 5 });
    // and the writer still works
    expect((await h.port.writeAll(TIGHTEN)).kind).toBe('written');
  });
});
