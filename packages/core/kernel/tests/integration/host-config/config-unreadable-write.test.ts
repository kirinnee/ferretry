import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createNodeHostFs, type HostFs } from '../../../host/state/host-fs.ts';
import { captureLog, loginsDef, manualClock, updatesDef } from '../../unit/host-config/support.ts';

/**
 * A config file the kernel cannot read (over the 256 KiB cap, a link, a directory, a FIFO)
 * reads as `absent` to the etag and to the load. A write, an owner's write, a removal or a set pinned `ifMatch: 'absent'`
 * (or pinned to nothing) must therefore REFUSE it, in the sentence a set's refusal says, and leave it exactly as it was —
 * on a real disk, through the real service. A non-UTF-8 file is still READ (decoded with U+FFFD, its etag unchanged), but
 * every WRITE over it is refused in its own sentence (BG-005), because saving would replace bytes nobody edited. A set
 * refuses it even when the set only removes it (its journal holds the prior as decoded text, so a roll-back would write
 * U+FFFD over the owner's bytes); the single removal journals nothing, so it is not refused.
 */
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const OVER_THE_CAP = `${'# a comment line to pad the file past the cap\n'.repeat(7000)}limit: 5\n`;

interface Case {
  readonly name: string;
  /** Puts the unreadable thing at `path`, and returns what must be true of it afterwards. */
  readonly plant: (path: string, home: string) => Promise<() => Promise<string>>;
}

/** What is at `path`, said in one string: any change to it (kind, link target, bytes, entries) changes the string. */
async function fingerprint(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return `link -> ${await readlink(path)}`;
  if (info.isDirectory()) return `directory [${(await readdir(path)).join(',')}]`;
  if (info.isFIFO()) return 'fifo';
  return `file ${Buffer.from(await readFile(path)).toString('hex')}`;
}

const CASES: readonly Case[] = [
  {
    name: 'a file over the 256 KiB cap',
    plant: async path => {
      await writeFile(path, OVER_THE_CAP);
      return async () => await fingerprint(path);
    },
  },
  {
    name: 'a symbolic link',
    plant: async (path, home) => {
      const target = join(home, 'elsewhere.yaml');
      await writeFile(target, 'limit: 5\n');
      await symlink(target, path);
      return async () => `${await fingerprint(path)} | ${await fingerprint(target)}`;
    },
  },
  {
    name: 'a directory',
    plant: async path => {
      await mkdir(path);
      await writeFile(join(path, 'inside.txt'), 'kept\n');
      return async () => await fingerprint(path);
    },
  },
  {
    name: 'a FIFO',
    plant: async path => {
      const made = Bun.spawnSync(['mkfifo', path]);
      if (made.exitCode !== 0) throw new Error('mkfifo is not available');
      return async () => await fingerprint(path);
    },
  },
];

async function planted(kase: Case) {
  const home = await mkdtemp(join(tmpdir(), 'fy-kernel-unreadable-'));
  homes.push(home);
  await mkdir(join(home, 'config'), { recursive: true });
  const path = join(home, 'config', 'updates.yaml');
  const same = await kase.plant(path, home);
  const before = await same();
  const files = createConfigFiles({
    home,
    fs: createNodeHostFs(),
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'updates', def: updatesDef }],
  });
  return { files, port: files.port('updates'), same, before };
}

/** The sentence a set's refusal of the same file says: every other writer says exactly this. */
async function setSentence(kase: Case): Promise<string> {
  const { port } = await planted(kase);
  const outcome = await port.writeAll([{ def: updatesDef, edit: 'limit: 7\n', ifMatch: 'absent' }]);
  if (outcome.kind !== 'refused' || outcome.reason !== 'unreadable') throw new Error('the set did not refuse the file');
  return outcome.issues[0]?.message ?? '';
}

/** `limit: 5`, a Latin-1 é (a lone 0xE9, not UTF-8) in a comment: it reads, and any save would turn that byte into U+FFFD. */
const LATIN1 = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nlimit: 5\n')]);
const NOT_UTF8 = 'updates.yaml is not UTF-8: saving would change bytes you did not edit; nothing was written';

async function latin1World() {
  const home = await mkdtemp(join(tmpdir(), 'fy-kernel-not-utf8-'));
  homes.push(home);
  await mkdir(join(home, 'config'), { recursive: true });
  const path = join(home, 'config', 'updates.yaml');
  await writeFile(path, LATIN1);
  const files = createConfigFiles({
    home,
    fs: createNodeHostFs(),
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'updates', def: updatesDef }],
  });
  await files.reload();
  const bytes = async () => (await readFile(path)).toString('hex');
  return { files, port: files.port('updates'), path, bytes, before: LATIN1.toString('hex') };
}

/**
 * `updates.yaml` (holding `bytes`) and a `logins` collection in one home. With `failLoginsWrite`, the first write under
 * `logins/` throws ENOSPC, the way a full disk would part-way through a set.
 */
async function setWorld(bytes: Buffer, failLoginsWrite: boolean) {
  const home = await mkdtemp(join(tmpdir(), 'fy-kernel-not-utf8-set-'));
  homes.push(home);
  await mkdir(join(home, 'config'), { recursive: true });
  const path = join(home, 'config', 'updates.yaml');
  await writeFile(path, bytes);
  const base = createNodeHostFs();
  let failed = 0;
  const fs: HostFs = new Proxy(base, {
    get(target, key) {
      if (key === 'writeAtomic')
        return async (p: string, data: string | Uint8Array, mode: number) => {
          if (failLoginsWrite && p.includes('/logins/')) {
            failed += 1;
            throw new Error('ENOSPC: no space left on device');
          }
          return await target.writeAtomic(p, data, mode);
        };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const files = createConfigFiles({
    home,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'updates', def: updatesDef },
      { plugin: 'updates', def: loginsDef },
    ],
  });
  await files.reload();
  return {
    files,
    port: files.port('updates'),
    path,
    loginsPath: join(home, 'config', 'logins', 'work.yaml'),
    failedWrites: () => failed,
  };
}

const refusedAs = (outcome: { readonly kind: string }, sentence = NOT_UTF8): void => {
  expect(outcome.kind).toBe('refused');
  const said = outcome as { reason?: string; issues?: readonly { message: string }[] };
  expect(said.issues?.[0]?.message).toBe(sentence);
};

describe('BG-005 a config write refuses a file that is not UTF-8, and leaves its bytes as they were', () => {
  test('it still READS: in effect, state ok, with the etag of the decoded text', async () => {
    const { files, port } = await latin1World();
    expect(files.status().files).toEqual([{ path: 'updates.yaml', plugin: 'updates', state: 'ok' }]);
    expect((port.file(updatesDef) as { limit: number }).limit).toBe(5);
    expect(await port.etag(updatesDef, undefined)).not.toBe('absent');
  });

  for (const pin of ['etag', undefined] as const) {
    const label = pin === undefined ? 'no ifMatch' : 'the etag it reads with';
    test(`the plugin's write (a whole text and a patch), ${label}, is refused`, async () => {
      const { port, bytes, before } = await latin1World();
      const ifMatch = pin === undefined ? {} : { ifMatch: await port.etag(updatesDef, undefined) };
      for (const edit of ['limit: 7\n', { patch: { limit: 7 } }]) {
        refusedAs(await port.write(updatesDef, undefined, edit, ifMatch));
      }
      expect(await bytes()).toBe(before);
    });
  }

  test('the owner’s write is refused, with no edit held', async () => {
    const { files, port, bytes, before } = await latin1World();
    refusedAs(await port.writeAsOwner(updatesDef, undefined, { patch: { limit: 7 } }));
    const raw = await files.writeAsOwner('updates', updatesDef, undefined, { patch: { limit: 7 } });
    expect(raw.kind === 'refused' && raw.reason).toBe('unreadable');
    expect(await bytes()).toBe(before);
  });

  test('the service’s own write is refused with the unreadable reason', async () => {
    const { files, bytes, before } = await latin1World();
    const raw = await files.write('updates', updatesDef, undefined, 'limit: 7\n');
    expect(raw.kind === 'refused' && raw.reason).toBe('unreadable');
    expect(await bytes()).toBe(before);
  });

  test('a set that writes it is refused, and nothing in the set is written', async () => {
    const { port, bytes, before } = await latin1World();
    const outcome = await port.writeAll([{ def: updatesDef, edit: 'limit: 7\n' }]);
    expect(outcome.kind === 'refused' && outcome.reason).toBe('unreadable');
    expect(JSON.stringify(outcome)).toContain(NOT_UTF8);
    expect(await bytes()).toBe(before);
  });

  test('the owner’s held-edit path: a held removal, the file made not UTF-8 before the next reload, then the owner writes', async () => {
    const { files, path } = await latin1World();
    // Make a held removal first: a readable file at the same path (limit 5 → the default 10 loosens, so it is held).
    await writeFile(path, 'limit: 5\n');
    await files.reload();
    expect((await files.remove('updates', updatesDef, undefined)).kind).toBe('held');
    await writeFile(path, LATIN1);
    const outcome = await files.writeAsOwner('updates', updatesDef, undefined, { patch: { limit: 7 } });
    expect(outcome.kind === 'refused' && outcome.reason).toBe('unreadable');
    expect(outcome.kind === 'refused' && outcome.issues[0]?.message).toBe(NOT_UTF8);
    expect((await readFile(path)).toString('hex')).toBe(LATIN1.toString('hex'));
  });

  test('a set that only removes it is refused as unreadable: its journal would put it back as U+FFFD', async () => {
    const { port, bytes, before } = await latin1World();
    const outcome = await port.writeAll([{ def: updatesDef, edit: { remove: true } }]);
    expect(outcome.kind === 'refused' && outcome.reason).toBe('unreadable');
    refusedAs(outcome);
    expect(await bytes()).toBe(before);
  });

  test('a set that removes it and then fails part-way never rewrites it with U+FFFD (the roll-back case)', async () => {
    // `limit: 15` is accepted (UTF-8), then the owner re-saves the same value as Latin-1: in effect, not held.
    const tight = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nlimit: 15\n')]);
    const world = await setWorld(Buffer.from('limit: 15\n'), true);
    await world.files.confirm(world.files.held()[0]?.id ?? '');
    await writeFile(world.path, tight);
    await world.files.reload();
    const outcome = await world.port.writeAll([
      { def: updatesDef, edit: { remove: true } },
      { def: loginsDef, name: 'work', edit: 'model: fast\n' },
    ]);
    // The set is refused before any write, so the disk full error is never reached and nothing is rolled back.
    refusedAs(outcome);
    expect(world.failedWrites()).toBe(0);
    expect((await readFile(world.path)).toString('hex')).toBe(tight.toString('hex'));
    expect(await Bun.file(world.loginsPath).exists()).toBe(false);
  });

  test('a set with a UTF-8 sibling is refused as a whole: the sibling is not written either', async () => {
    const world = await setWorld(LATIN1, false);
    const outcome = await world.port.writeAll([
      { def: loginsDef, name: 'work', edit: 'model: fast\n' },
      { def: updatesDef, edit: 'limit: 7\n' },
    ]);
    refusedAs(outcome);
    expect((await readFile(world.path)).toString('hex')).toBe(LATIN1.toString('hex'));
    expect(await Bun.file(world.loginsPath).exists()).toBe(false);
  });

  test('discarding a held edit of a non-UTF-8 file restores the version in effect as UTF-8: the owner’s own act', async () => {
    // The in-effect version was itself read from a Latin-1 file, so its accepted text holds U+FFFD: dropping the held
    // bytes (a loosening Latin-1 save) writes that text back, where the é byte was. The held bytes are meant to go.
    const { files, path, bytes } = await latin1World();
    const loosened = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nlimit: 50\n')]);
    await writeFile(path, loosened);
    await files.reload();
    const held = files.held();
    expect(held).toHaveLength(1);
    await files.discard(held[0]?.id ?? '');
    expect(files.held()).toHaveLength(0);
    const after = await bytes();
    expect(after).toBe(
      Buffer.concat([Buffer.from('# caf'), Buffer.from([0xef, 0xbf, 0xbd]), Buffer.from('\nlimit: 5\n')]).toString(
        'hex',
      ),
    );
    expect(Buffer.from(after, 'hex').toString('utf8')).toBe('# caf�\nlimit: 5\n');
  });

  test('a removal is not refused: it replaces no byte', async () => {
    const { port } = await latin1World();
    // limit 5 → the default 10 loosens, so the removal is held for the owner: judged like any removal, not refused
    expect((await port.remove(updatesDef, undefined)).kind).toBe('held');
  });
});

describe('BG-012 m-1: the owner’s held-edit path refuses a target that became unreadable after the edit was held', () => {
  for (const kase of CASES) {
    test(`${kase.name}: a held removal, the path planted before the next reload, then the owner writes`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'fy-kernel-unreadable-held-'));
      homes.push(home);
      await mkdir(join(home, 'config'), { recursive: true });
      const path = join(home, 'config', 'updates.yaml');
      const files = createConfigFiles({
        home,
        fs: createNodeHostFs(),
        clock: manualClock(),
        log: captureLog(),
        binary: 'fy',
        defs: [{ plugin: 'updates', def: updatesDef }],
      });
      await files.reload();
      expect((await files.write('updates', updatesDef, undefined, 'limit: 5\n')).kind).toBe('applied');
      // Removing a file is an edit to its defaults (limit 10 > 5): a loosening, so the removal is held for the owner.
      expect((await files.remove('updates', updatesDef, undefined)).kind).toBe('held');
      expect(files.held()).toHaveLength(1);
      // The path is something the kernel cannot read before any reload sees it.
      const same = await kase.plant(path, home);
      const before = await same();

      const outcome = await files.writeAsOwner('updates', updatesDef, undefined, { patch: { limit: 7 } });

      expect(outcome.kind === 'refused' && outcome.reason).toBe('unreadable');
      expect(await same()).toBe(before);
    });
  }
});

const PINS: readonly (string | undefined)[] = ['absent', undefined];
const pinName = (pin: string | undefined): string => (pin === undefined ? 'no ifMatch' : `ifMatch ${pin}`);

describe('a config write refuses a target the kernel cannot read, and leaves it as it was', () => {
  for (const kase of CASES) {
    for (const pin of PINS) {
      const ifMatch = pin === undefined ? {} : { ifMatch: pin };
      const label = `${kase.name}, ${pinName(pin)}`;

      test(`${label}: the plugin's write (a whole text and a patch) is refused`, async () => {
        const { port, same, before } = await planted(kase);
        const sentence = await setSentence(kase);
        for (const edit of ['limit: 7\n', { patch: { limit: 7 } }]) {
          const outcome = await port.write(updatesDef, undefined, edit, ifMatch);
          expect(outcome.kind).toBe('refused');
          if (outcome.kind !== 'refused') throw new Error('unreachable');
          expect(outcome.issues[0]?.message).toBe(sentence);
        }
        expect(await same()).toBe(before);
      });

      test(`${label}: the owner's write is refused`, async () => {
        const { files, port, same, before } = await planted(kase);
        const sentence = await setSentence(kase);
        const outcome = await port.writeAsOwner(updatesDef, undefined, { patch: { limit: 7 } }, ifMatch);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') throw new Error('unreachable');
        expect(outcome.issues[0]?.message).toBe(sentence);
        const raw = await files.writeAsOwner('updates', updatesDef, undefined, { patch: { limit: 7 } }, ifMatch);
        expect(raw.kind === 'refused' && raw.reason).toBe('unreadable');
        expect(await same()).toBe(before);
      });

      test(`${label}: the service's own write is refused with the unreadable reason`, async () => {
        const { files, same, before } = await planted(kase);
        const raw = await files.write('updates', updatesDef, undefined, 'limit: 7\n', ifMatch);
        expect(raw.kind === 'refused' && raw.reason).toBe('unreadable');
        expect(await same()).toBe(before);
      });

      test(`${label}: a removal is refused`, async () => {
        const { files, port, same, before } = await planted(kase);
        const sentence = await setSentence(kase);
        const outcome = await port.remove(updatesDef, undefined, ifMatch);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') throw new Error('unreachable');
        expect(outcome.issues[0]?.message).toBe(sentence);
        const raw = await files.remove('updates', updatesDef, undefined, ifMatch);
        expect(raw.kind === 'refused' && raw.reason).toBe('unreadable');
        expect(await same()).toBe(before);
      });

      test(`${label}: a set naming it is refused (the baseline every other writer matches)`, async () => {
        const { port, same, before } = await planted(kase);
        const outcome = await port.writeAll([{ def: updatesDef, edit: 'limit: 7\n', ...ifMatch }]);
        expect(outcome.kind === 'refused' && outcome.reason).toBe('unreadable');
        expect(await same()).toBe(before);
      });
    }
  }
});
