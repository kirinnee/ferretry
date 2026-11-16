import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import {
  FileLastSnapshotStore,
  LAST_SNAPSHOT_MAX_BYTES,
} from '../../../../../daemon/adapters/session/snapshot/file-last-snapshot-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * A read of the last frame is TOTAL: whatever the disk does under it, it answers `absent`, `unreadable` or `read` and
 * never throws, and it never hands back bytes it could not prove were the named file's.
 */

const FERRET = parseSessionId('mw7bp88g-50e00161');

describe('the last-snapshot file when the disk misbehaves under a read', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const fresh = async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fy-last-snapshot-faults-'));
    dirs.push(parent);
    const { root, folder } = await diskSessionsRoot(parent, FERRET);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return { root, folder };
  };

  test('bytes that are not text are unreadable, and no fragment of them is quoted', async () => {
    const { root, folder } = await fresh();
    await writeFile(join(folder, 'last-snapshot.txt'), Uint8Array.of(0x66, 0xff, 0xfe, 0x6f), { mode: 0o600 });

    expect(await new FileLastSnapshotStore(root, FERRET).read(FERRET)).toEqual({ kind: 'unreadable' });
  });

  test('a name that is not the file that was opened is unreadable: another file swapped in after the check', async () => {
    const { root, folder } = await fresh();
    await writeFile(join(folder, 'last-snapshot.txt'), 'a frame', { mode: 0o600 });
    const swapped = { ...root, fileIdentity: async () => ({ device: 0n, inode: 0n }) } as unknown as typeof root;

    expect(await new FileLastSnapshotStore(swapped, FERRET).read(FERRET)).toEqual({ kind: 'unreadable' });
  });

  test('a file that vanished while it was being read is absent, not an error', async () => {
    const { root, folder } = await fresh();
    await writeFile(join(folder, 'last-snapshot.txt'), 'a frame', { mode: 0o600 });
    const vanishing = {
      ...root,
      fileIdentity: async (path: Parameters<typeof root.fileIdentity>[0]) => {
        await rm(join(folder, 'last-snapshot.txt'));
        return await root.fileIdentity(path);
      },
    } as unknown as typeof root;

    expect(await new FileLastSnapshotStore(vanishing, FERRET).read(FERRET)).toEqual({ kind: 'absent' });
  });

  test('a file that grew past the largest frame after it was measured is unreadable, never cut', async () => {
    const { root, folder } = await fresh();
    await writeFile(join(folder, 'last-snapshot.txt'), 'y'.repeat(LAST_SNAPSHOT_MAX_BYTES + 1), { mode: 0o600 });
    const measuredSmall = {
      ...root,
      lstat: async (path: Parameters<typeof root.lstat>[0]) => {
        const real = await root.lstat(path);
        return real === undefined ? undefined : { ...real, size: 1 };
      },
    } as unknown as typeof root;

    expect(await new FileLastSnapshotStore(measuredSmall, FERRET).read(FERRET)).toEqual({ kind: 'unreadable' });
  });

  test('a disk that fails while the name is measured is unreadable, never a throw', async () => {
    const { root } = await fresh();
    const failing = {
      ...root,
      lstat: async () => {
        throw new Error('EIO: /private/path/last-snapshot.txt');
      },
    } as unknown as typeof root;

    expect(await new FileLastSnapshotStore(failing, FERRET).read(FERRET)).toEqual({ kind: 'unreadable' });
  });

  test('a store refuses a root that is not the internal sessions root', async () => {
    const { root } = await fresh();
    const elsewhere = { ...root, name: 'work', internal: false } as unknown as typeof root;

    expect(() => new FileLastSnapshotStore(elsewhere, FERRET)).toThrow('internal sessions root only');
  });
});
