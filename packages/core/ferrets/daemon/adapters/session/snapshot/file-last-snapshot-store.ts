import type { FencedPath, RootHandle, RootLstat } from '@ferretry/kernel/contract';
import type { SessionId } from '../../../lib/session-id.ts';
import {
  LAST_SNAPSHOT_MAX_CHARS,
  type LastSnapshotReader,
  type LastSnapshotWriter,
  type StoredLastSnapshot,
} from '../../../lib/session/snapshot/index.ts';
import { assertOwnSession, assertSessionsRoot, OwnFolder } from '../sessions-root.ts';

/** The file's name in the ferret's own folder (today's `SessionPaths.lastSnapshot`). A constant: no caller names it. */
const LAST_SNAPSHOT_FILE = 'last-snapshot.txt';

/**
 * The most bytes the file may hold: {@link LAST_SNAPSHOT_MAX_CHARS} characters at the most UTF-8 can spend on one
 * (three bytes per UTF-16 unit). A longer text is refused on write, and a longer file is unreadable, never cut.
 */
export const LAST_SNAPSHOT_MAX_BYTES = LAST_SNAPSHOT_MAX_CHARS * 3;

/** The kernel's refusal word, read structurally: this plugin may not import the kernel's host. */
function refusalOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'RootError') return undefined;
  const refusal = (error as { readonly refusal?: unknown }).refusal;
  return typeof refusal === 'string' ? refusal : undefined;
}

/** What this store asks of the kernel's root. */
export type LastSnapshotRoot = Pick<
  RootHandle,
  'name' | 'internal' | 'ensurePrivateDirectory' | 'resolve' | 'publish' | 'lstat' | 'readDurable' | 'fileIdentity'
>;

/**
 * The one final pane frame a stopped ferret leaves behind (today's `FileLastSnapshotStore`): `last-snapshot.txt` in the
 * ferret's own `0700` folder on the internal `sessions` root, written `0600`.
 *
 * The text it is handed is already MASKED ({@link LastSnapshotCapture}); this store never sees a screen that was not.
 *
 * ATOMIC: `RootHandle.publish` writes a new `0600` temp file (exclusive, no-follow, synced) and renames it onto the
 * name, then syncs the folder, so a reader sees the old frame or the new one, never half of one.
 *
 * NO LINK IS FOLLOWED OR WRITTEN THROUGH. A name that is a link, a folder, a device or a file with a second hard link is
 * refused on write (nothing is replaced) and is unreadable on read. A read also proves, while it still holds the file
 * open, that the NAME (never followed) is that very file with one link: the kernel's read follows a leaf link that
 * stays inside the root, so without that proof a link swapped in after the first check could hand back another file
 * of this folder (the credential beside it).
 *
 * A missing file stays missing evidence: this store never makes a blank frame for it. ONE HANDLE, ONE FERRET.
 *
 * A READ IS TOTAL AND CHANGES NOTHING. It answers `absent`, `unreadable` or `read` and never throws: another
 * ferret's id is `absent` (this handle holds no frame of it), and the error names no session. It makes no folder
 * and narrows no mode: a ferret that never kept a frame has no folder, and that is `absent` too. The text it
 * answers is what was masked when the frame was KEPT; a reader that serves it masks it again, because a value added
 * to the Vault after the capture is not masked in the file.
 */
export class FileLastSnapshotStore implements LastSnapshotReader, LastSnapshotWriter {
  private readonly folder: OwnFolder;

  constructor(
    private readonly root: LastSnapshotRoot,
    private readonly ferret: SessionId,
  ) {
    assertSessionsRoot(root, 'the last-snapshot store');
    this.folder = new OwnFolder(root);
  }

  file(id: SessionId): FencedPath {
    assertOwnSession(this.ferret, id, 'the last-snapshot store');
    const resolved = this.root.resolve(LAST_SNAPSHOT_FILE);
    if (!resolved.ok) throw new Error(`the last snapshot is outside its root (${resolved.error})`);
    return resolved.value;
  }

  async write(id: string, text: string): Promise<void> {
    const target = this.file(id as SessionId);
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > LAST_SNAPSHOT_MAX_BYTES) throw new Error('the last snapshot is larger than a frame may be');
    await this.folder.ensure();
    const existing = await this.root.lstat(target);
    if (existing !== undefined && (existing.kind !== 'file' || existing.links !== 1))
      throw new Error('the last snapshot name is not a plain file, so nothing was written');
    await this.root.publish(target, bytes, { mode: 0o600 });
  }

  async read(id: string): Promise<StoredLastSnapshot> {
    if (id !== this.ferret) return { kind: 'absent' };
    try {
      const target = this.file(id as SessionId);
      const leaf = await this.leaf(target);
      if (leaf === 'no-folder' || leaf === undefined) return { kind: 'absent' };
      if (leaf.kind !== 'file' || leaf.links !== 1 || leaf.size > LAST_SNAPSHOT_MAX_BYTES)
        return { kind: 'unreadable' };
      const bytes = await this.root.readDurable(target, LAST_SNAPSHOT_MAX_BYTES + 1, async held => {
        const named = await this.root.fileIdentity(target);
        const still = await this.root.lstat(target);
        const same =
          named !== undefined &&
          named.device === held.identity.device &&
          named.inode === held.identity.inode &&
          still?.kind === 'file' &&
          still.links === 1;
        return same ? held.bytes : undefined;
      });
      if (bytes === undefined)
        return (await this.root.lstat(target)) === undefined ? { kind: 'absent' } : { kind: 'unreadable' };
      if (bytes.length > LAST_SNAPSHOT_MAX_BYTES) return { kind: 'unreadable' };
      return { kind: 'read', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      // Never the error's words: a filesystem error can quote a path, and a decoder's a fragment of the screen.
      return { kind: 'unreadable' };
    }
  }

  /**
   * The leaf's own kind, or `no-folder` when the ferret's folder is not there yet: the kernel refuses a name below a
   * scoped folder that does not exist (`outside`), and a read must not make it to ask.
   */
  private async leaf(target: FencedPath): Promise<RootLstat | undefined | 'no-folder'> {
    try {
      return await this.root.lstat(target);
    } catch (error) {
      if (refusalOf(error) === 'outside') return 'no-folder';
      throw error;
    }
  }
}
