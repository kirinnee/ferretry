/**
 * The anchor a send's (and a start's) files are written under: the ferret's own `attachments` folder. Its chain from the
 * home down must be private to the daemon — no link, owned by the daemon's uid, not writable by group or world — and
 * that is judged by the kernel's one primitive (`RootHandle.checkPrivateChain`), not by a copy beside the writer.
 * Real disk, fixture temp folders only; `chmod` and the daemon uid are changed in the temp tree alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootsPort } from '@ferretry/kernel/contract';
import { diskPaths, diskSessionsRoots } from '@ferretry/kernel/testing';
import { SessionFiles } from '../../../../../daemon/modules/session-files.ts';
import { ferretId } from '../../../../../contract/testing/index.ts';
import { memoryStorage } from '../../../../support/daemon/storage.ts';

const NOW = '2026-11-08T10:00:00.000Z';
const FERRET = 'mw7bp88g-50e00159';
const UID = process.getuid?.() ?? 0;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function world(options: { readonly daemonUid?: number | null } = {}) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-attach-chain-`));
  parents.push(parent);
  const disk = await diskSessionsRoots(parent, undefined, options);
  const roots: Pick<RootsPort, 'root'> = { root: (_name, scope) => disk.root(scope?.subfolder ?? '') };
  const { storage } = await memoryStorage({ clock: { now: () => NOW } });
  const subject = new SessionFiles({
    roots,
    storage,
    clock: { now: () => NOW },
    sleep: async () => undefined,
    paths: diskPaths(),
    fleet: () => [],
    log: { warn: () => undefined },
  });
  const home = `${parent}/home`;
  const sessions = `${home}/state/ferrets/sessions`;
  const anchor = `${sessions}/${FERRET}/attachments`;
  const send = async () => {
    const attach = subject.port.attach;
    if (attach === undefined) throw new Error('the session port has no attach');
    await attach(ferretId(FERRET), [{ name: 'shot.txt', folder: 'att_1', contents: 'FIXTURE-BYTES' }]);
  };
  return { parent, home, sessions, anchor, send };
}

const kept = async (anchor: string): Promise<readonly string[]> => await readdir(anchor).catch(() => []);

describe('the attachments anchor is judged by RootHandle.checkPrivateChain', () => {
  test('a private chain takes the file, 0600 in a 0700 per-id folder (nothing refused that was allowed)', async () => {
    const w = await world();
    await w.send();
    expect(await readFile(`${w.anchor}/att_1/shot.txt`, 'utf8')).toBe('FIXTURE-BYTES');
    expect(((await lstat(`${w.anchor}/att_1/shot.txt`)).mode & 0o777).toString(8)).toBe('600');
    expect(((await lstat(`${w.anchor}/att_1`)).mode & 0o777).toString(8)).toBe('700');
  });

  test.each([
    ['state/ferrets', 0o770],
    ['state', 0o777],
    ['', 0o775],
  ])(
    'the folder %p writable by group or world (mode %o) refuses the send and writes nothing',
    async (relative, mode) => {
      const w = await world();
      await mkdir(w.anchor, { recursive: true, mode: 0o700 });
      await chmod(relative === '' ? w.home : `${w.home}/${relative}`, mode);
      await expect(w.send()).rejects.toThrow(/writable by its group or by everyone/u);
      expect(await kept(w.anchor)).toEqual([]);
    },
  );

  test('an anchor chain owned by someone other than the daemon uid refuses the send and writes nothing', async () => {
    const w = await world({ daemonUid: UID + 1 });
    await expect(w.send()).rejects.toThrow(/owned by another user/u);
    expect(await kept(w.anchor)).toEqual([]);
  });

  test('an anchor chain whose owner cannot be determined fails closed', async () => {
    const w = await world({ daemonUid: null });
    await expect(w.send()).rejects.toThrow(/could not be determined/u);
    expect(await kept(w.anchor)).toEqual([]);
  });

  test('a link in the chain refuses the send (the state folder is a link to a private folder elsewhere)', async () => {
    const w = await world();
    await mkdir(`${w.parent}/elsewhere`, { mode: 0o700 });
    await rename(`${w.home}/state/ferrets`, `${w.parent}/elsewhere/ferrets`);
    await symlink(`${w.parent}/elsewhere/ferrets`, `${w.home}/state/ferrets`);
    await expect(w.send()).rejects.toThrow();
    expect(await kept(`${w.parent}/elsewhere/ferrets/sessions/${FERRET}/attachments`)).toEqual([]);
  });

  test('an anchor the daemon owns that is wider than 0700 is narrowed to 0700 as before, then the send lands', async () => {
    const w = await world();
    await mkdir(`${w.anchor}`, { recursive: true, mode: 0o700 });
    await chmod(w.anchor, 0o777);
    await w.send();
    expect(((await lstat(w.anchor)).mode & 0o777).toString(8)).toBe('700');
    expect(await readFile(`${w.anchor}/att_1/shot.txt`, 'utf8')).toBe('FIXTURE-BYTES');
  });
});
