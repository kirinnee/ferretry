import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { HostFs } from '@ferretry/kernel/host';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import {
  FileResumeTurnStore,
  TURN_MARKERS,
} from '../../../../../daemon/adapters/session/resume/file-resume-turn-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * A host with no descriptor reach (macOS: no `/proc/self/fd`) must still let a ferret be messaged and resumed. Every
 * send and every resume clears the completion markers and a stale author record in the `sessions` root; those are
 * FILE removes, which the kernel still performs there (by path, after one re-proof of the folder, a declared GAP).
 * Only a folder remove is refused. Fixture values only.
 */

const FERRET = parseSessionId('mw7bp88g-50e00159');
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The real disk, except that no open folder reaches its entries by a descriptor path (what macOS offers). */
const withoutReach = (disk: HostFs): HostFs => ({
  ...disk,
  openDirectory: async path => ({ ...(await disk.openDirectory(path)), entryPath: () => undefined }),
});

async function subject() {
  const parent = await mkdtemp(`${tmpdir()}/fy-turns-blind-`);
  dirs.push(parent);
  const disk = await diskSessionsRoot(parent, FERRET, withoutReach);
  return { ...disk, store: new FileResumeTurnStore(disk.root, FERRET) };
}

const gone = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) === undefined;

describe('the resume turn store on a host without descriptor reach', () => {
  test('S44 clearMarkers still removes every completion marker of the ferret, and nothing else', async () => {
    const { store, folder } = await subject();
    await store.writeTurn(FERRET, 1, 'First.\n');
    for (const marker of TURN_MARKERS) await writeFile(`${folder}/${marker}.marker`, '');

    await store.clearMarkers(FERRET);

    for (const marker of TURN_MARKERS) expect(await gone(`${folder}/${marker}.marker`)).toBe(true);
    expect(await readFile(`${folder}/turns/turn-001.md`, 'utf8')).toBe('First.\n');
  });

  test('S44 a turn with no author still removes the stale author record beside its number', async () => {
    const { store, folder } = await subject();
    await store.writeTurn(FERRET, 2, 'Old words.\n', { kind: 'ferretry', feature: 'Warden' });
    expect(await gone(`${folder}/turns/turn-002.by.json`)).toBe(false);

    await store.writeTurn(FERRET, 2, 'New words.\n');

    expect(await gone(`${folder}/turns/turn-002.by.json`)).toBe(true);
    expect(await readFile(`${folder}/turns/turn-002.md`, 'utf8')).toBe('New words.\n');
  });
});
