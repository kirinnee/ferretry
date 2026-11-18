import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { CLEAR_FOLDER_MS, type PrivateGuard, privatelyHeld } from '../../../host/fence-guard.ts';
import { identityKey } from '../../../host/fence-index.ts';

/**
 * A read walks the folders above its file on every call; they are remembered clear for a moment so a hundred ferrets'
 * reads do not each look at the same folders again. The file ITSELF is looked at every time, so a replaced or relinked
 * entry is never answered from the memory.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-clear-folders-`));
  parents.push(parent);
  const base = `${parent}/base`;
  const folder = `${base}/projects/-work`;
  const secret = `${parent}/secret.json`;
  await mkdir(folder, { recursive: true });
  await writeFile(`${folder}/conv.jsonl`, 'transcript');
  await writeFile(secret, 'private');
  const identity = await REAL.identity(secret);
  if (identity === undefined) throw new Error('the secret is there');
  const guard: PrivateGuard = {
    keys: { has: key => key === identityKey(identity), size: 1 },
    closed: new Set(),
  };
  return { parent, base, folder, file: `${folder}/conv.jsonl`, secret, guard };
}

/** The disk, counting every `identity` look it is asked for. */
function counting(): { readonly fs: HostFs; readonly looks: string[] } {
  const looks: string[] = [];
  return {
    looks,
    fs: {
      ...REAL,
      identity: async path => {
        looks.push(path);
        return await REAL.identity(path);
      },
    },
  };
}

describe('privatelyHeld remembers clear folders for a moment', () => {
  test('a second read of a sibling looks at the entry only; after the moment it walks again', async () => {
    const l = await layout();
    const { fs, looks } = counting();
    let at = 1_000;
    const clock = (): number => at;
    expect(await privatelyHeld(fs, l.guard, l.file, l.base, clock)).toBe(false);
    expect(looks).toEqual([l.file, l.folder, `${l.base}/projects`, l.base]);
    looks.length = 0;
    expect(await privatelyHeld(fs, l.guard, l.file, l.base, clock)).toBe(false);
    expect(looks).toEqual([l.file]);
    looks.length = 0;
    at += CLEAR_FOLDER_MS + 1;
    expect(await privatelyHeld(fs, l.guard, l.file, l.base, clock)).toBe(false);
    expect(looks).toEqual([l.file, l.folder, `${l.base}/projects`, l.base]);
  });

  test('the entry itself is never answered from memory: a file replaced by a link to a private file is held at once', async () => {
    const l = await layout();
    let at = 1_000;
    const clock = (): number => at;
    expect(await privatelyHeld(REAL, l.guard, l.file, l.base, clock)).toBe(false);
    // The transcript's name now reaches the private file (a hard link, a bind mount's identity): same moment, warm memory.
    await rm(l.file);
    await link(l.secret, l.file);
    expect(await privatelyHeld(REAL, l.guard, l.file, l.base, clock)).toBe(true);
    // And one replaced by another plain file is still clear.
    await rm(l.file);
    await writeFile(l.file, 'again');
    expect(await privatelyHeld(REAL, l.guard, l.file, l.base, clock)).toBe(false);
  });

  test('a file that is gone is held (a doubt refuses), with the memory warm', async () => {
    const l = await layout();
    const clock = (): number => 5;
    expect(await privatelyHeld(REAL, l.guard, l.file, l.base, clock)).toBe(false);
    await rm(l.file);
    expect(await privatelyHeld(REAL, l.guard, l.file, l.base, clock)).toBe(true);
  });

  test('a folder swapped for a private one is caught when the memory runs out, and by any new guard at once', async () => {
    const l = await layout();
    let at = 1_000;
    const clock = (): number => at;
    expect(await privatelyHeld(REAL, l.guard, l.file, l.base, clock)).toBe(false);
    // The folder above the file is replaced by the private folder's identity: the guard that names it is built afresh.
    const swapped = `${l.base}/projects/-work`;
    await rename(swapped, `${swapped}.old`);
    await mkdir(swapped);
    await writeFile(`${swapped}/conv.jsonl`, 'x');
    const identity = await REAL.identity(swapped);
    if (identity === undefined) throw new Error('the folder is there');
    const fresh: PrivateGuard = { keys: { has: key => key === identityKey(identity), size: 1 }, closed: new Set() };
    expect(await privatelyHeld(REAL, fresh, `${swapped}/conv.jsonl`, l.base, clock)).toBe(true);
    // The old guard (its memory is its own) agrees once the moment passes: the folder is looked at again.
    const sameGuard: PrivateGuard = { keys: l.guard.keys, closed: new Set() };
    expect(await privatelyHeld(REAL, sameGuard, `${swapped}/conv.jsonl`, l.base, clock)).toBe(false);
    at += CLEAR_FOLDER_MS + 1;
    const later: PrivateGuard = { keys: fresh.keys, closed: new Set() };
    expect(await privatelyHeld(REAL, later, `${swapped}/conv.jsonl`, l.base, clock)).toBe(true);
  });

  test('a folder on a device the guard holds closed is held, and a held answer is never remembered', async () => {
    const l = await layout();
    const device = (await REAL.identity(l.base))?.device;
    if (device === undefined) throw new Error('the base is there');
    const closed: PrivateGuard = { keys: { has: () => false, size: 1 }, closed: new Set([device]) };
    const clock = (): number => 7;
    expect(await privatelyHeld(REAL, closed, l.file, l.base, clock)).toBe(true);
    expect(await privatelyHeld(REAL, closed, l.file, l.base, clock)).toBe(true);
  });

  test('the memory belongs to one disk: another disk (a different look at the same names) is walked afresh', async () => {
    const l = await layout();
    const clock = (): number => 9;
    expect(await privatelyHeld(REAL, l.guard, l.file, l.base, clock)).toBe(false);
    const other = counting();
    expect(await privatelyHeld(other.fs, l.guard, l.file, l.base, clock)).toBe(false);
    expect(other.looks).toEqual([l.file, l.folder, `${l.base}/projects`, l.base]);
  });

  test('deeper walks never extend an ancestor past its own moment', async () => {
    const l = await layout();
    const deeper = `${l.folder}/a/b`;
    await mkdir(deeper, { recursive: true });
    await writeFile(`${deeper}/c.jsonl`, 'x');
    await writeFile(`${l.folder}/a/d.jsonl`, 'x');
    const { fs, looks } = counting();
    let at = 1_000;
    const clock = (): number => at;
    // The walk from the base's folders remembers them until 1_000 + the moment.
    expect(await privatelyHeld(fs, l.guard, l.file, l.base, clock)).toBe(false);
    // Just before they run out, a deeper walk stops at the remembered folder and remembers the new ones.
    at = 1_000 + CLEAR_FOLDER_MS - 100;
    looks.length = 0;
    expect(await privatelyHeld(fs, l.guard, `${deeper}/c.jsonl`, l.base, clock)).toBe(false);
    expect(looks).toEqual([`${deeper}/c.jsonl`, deeper, `${l.folder}/a`]);
    // After the ancestor's own moment nothing below it is still remembered: the whole chain is walked again.
    at = 1_000 + CLEAR_FOLDER_MS + 1;
    looks.length = 0;
    expect(await privatelyHeld(fs, l.guard, `${l.folder}/a/d.jsonl`, l.base, clock)).toBe(false);
    expect(looks).toEqual([`${l.folder}/a/d.jsonl`, `${l.folder}/a`, l.folder, `${l.base}/projects`, l.base]);
  });
});
