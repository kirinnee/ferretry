import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { captureLog, manualClock, updatesDef } from '../../unit/host-config/support.ts';

/**
 * A config file the kernel cannot read (over the 256 KiB cap, a link, a directory, a FIFO)
 * reads as `absent` to the etag and to the load. A write, an owner's write, a removal or a set pinned `ifMatch: 'absent'`
 * (or pinned to nothing) must therefore REFUSE it, in the sentence a set's refusal says, and leave it exactly as it was —
 * on a real disk, through the real service. A non-UTF-8 file is deliberately NOT here: it is still read (decoded with
 * U+FFFD) and a write over it lands; refusing it changes a valid read, so it is reported, not done.
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
