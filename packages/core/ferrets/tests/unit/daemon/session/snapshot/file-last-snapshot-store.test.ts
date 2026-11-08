import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import {
  FileLastSnapshotStore,
  LAST_SNAPSHOT_MAX_BYTES,
} from '../../../../../daemon/adapters/session/snapshot/file-last-snapshot-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

const FERRET = parseSessionId('mw7bp88g-50e00159');
const OTHER = parseSessionId('mw7bp88g-50e00160');
/** What the credential file beside the frame holds: a link must never hand it back. */
const CREDENTIAL = '{"FY_SESSION_TOKEN":"fixture-credential"}';

describe('F-0326 the last-snapshot file on the sessions root', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const fresh = async () => {
    const parent = await mkdtemp(`${tmpdir()}/fy-last-snapshot-`);
    dirs.push(parent);
    const { root, folder } = await diskSessionsRoot(parent, FERRET);
    return { parent, folder, store: new FileLastSnapshotStore(root, FERRET) };
  };
  const mode = async (path: string) => (await lstat(path)).mode & 0o777;

  test('F-0326 it is state/ferrets/sessions/{ferret}/last-snapshot.txt, 0600 in a 0700 folder, replaced whole', async () => {
    const { parent, folder, store } = await fresh();
    expect(await store.read(FERRET)).toEqual({ kind: 'absent' });
    await store.write(FERRET, 'first frame\n');
    await store.write(FERRET, 'second frame\n');
    expect(folder).toBe(`${parent}/home/state/ferrets/sessions/${FERRET}`);
    expect(String(store.file(FERRET))).toBe(`${folder}/last-snapshot.txt`);
    expect(await readFile(`${folder}/last-snapshot.txt`, 'utf8')).toBe('second frame\n');
    expect(await mode(`${folder}/last-snapshot.txt`)).toBe(0o600);
    expect(await mode(folder)).toBe(0o700);
    // Atomic: the temp file the publish wrote through is never left behind.
    expect(await readdir(folder)).toEqual(['last-snapshot.txt']);
    expect(await store.read(FERRET)).toEqual({ kind: 'read', text: 'second frame\n' });
  });

  test('F-0326 a link at the name is refused: nothing is written through it, and a read never follows it', async () => {
    const { folder, store } = await fresh();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(`${folder}/environment.json`, CREDENTIAL, { mode: 0o600 });
    await symlink('environment.json', `${folder}/last-snapshot.txt`);
    expect(await store.read(FERRET)).toEqual({ kind: 'unreadable' });
    await expect(store.write(FERRET, 'frame')).rejects.toThrow('not a plain file');
    expect(await readFile(`${folder}/environment.json`, 'utf8')).toBe(CREDENTIAL);
    expect((await lstat(`${folder}/last-snapshot.txt`)).isSymbolicLink()).toBe(true);
  });

  test('F-0326 a second hard link at the name (another file of the folder) is refused and unreadable', async () => {
    const { folder, store } = await fresh();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(`${folder}/environment.json`, CREDENTIAL, { mode: 0o600 });
    await link(`${folder}/environment.json`, `${folder}/last-snapshot.txt`);
    expect(await store.read(FERRET)).toEqual({ kind: 'unreadable' });
    await expect(store.write(FERRET, 'frame')).rejects.toThrow('not a plain file');
    expect(await readFile(`${folder}/environment.json`, 'utf8')).toBe(CREDENTIAL);
  });

  test('F-0326 an oversize frame is refused on write, and an oversize file is unreadable, never cut', async () => {
    const { folder, store } = await fresh();
    await expect(store.write(FERRET, 'x'.repeat(LAST_SNAPSHOT_MAX_BYTES + 1))).rejects.toThrow('larger');
    await expect(lstat(`${folder}/last-snapshot.txt`)).rejects.toThrow();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(`${folder}/last-snapshot.txt`, 'y'.repeat(LAST_SNAPSHOT_MAX_BYTES + 1), { mode: 0o600 });
    expect(await store.read(FERRET)).toEqual({ kind: 'unreadable' });
  });

  test('F-0326 a folder at the name is unreadable, and one handle serves its own ferret only', async () => {
    const { folder, store } = await fresh();
    await mkdir(`${folder}/last-snapshot.txt`, { recursive: true, mode: 0o700 });
    expect(await store.read(FERRET)).toEqual({ kind: 'unreadable' });
    await expect(store.write(FERRET, 'frame')).rejects.toThrow();
    await expect(store.write(OTHER, 'frame')).rejects.toThrow('through the folder of');
    // A read is total: another ferret's id is absent from this handle, never a rejection that names both sessions.
    expect(await store.read(OTHER)).toEqual({ kind: 'absent' });
  });

  test('F-0326 a read makes no folder: a ferret that never kept a frame has none, and that is absent', async () => {
    const { folder, store } = await fresh();
    expect(await store.read(FERRET)).toEqual({ kind: 'absent' });
    await expect(lstat(folder)).rejects.toThrow();
    expect(await store.read(OTHER)).toEqual({ kind: 'absent' });
    await expect(lstat(folder)).rejects.toThrow();
  });

  test('F-0326 a read narrows no folder: a wider folder stays as it is until a write holds it to 0700', async () => {
    const { folder, store } = await fresh();
    await mkdir(folder, { recursive: true, mode: 0o755 });
    await chmod(folder, 0o755);
    await writeFile(`${folder}/last-snapshot.txt`, 'kept frame', { mode: 0o600 });
    expect(await store.read(FERRET)).toEqual({ kind: 'read', text: 'kept frame' });
    expect(await mode(folder)).toBe(0o755);
    await store.write(FERRET, 'next frame');
    expect(await mode(folder)).toBe(0o700);
  });
});
