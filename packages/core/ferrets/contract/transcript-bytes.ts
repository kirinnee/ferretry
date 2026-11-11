import { type FencedPath, MAX_ROOT_WINDOW_BYTES, type RootHandle } from '@ferretry/kernel/contract';
import { type HarnessTranscriptBytes, HarnessTranscriptReplaced } from './kinds.ts';

/** The part of a root the byte handle needs: a harness hands over its own proved `agent-homes` root. */
export type TranscriptBytesRoot = Pick<RootHandle, 'readBytes' | 'fileIdentity' | 'stat'>;

/** The length of the opaque token (22 hex characters of a SHA-256, as v4's transcript location token). */
const TOKEN_LENGTH = 22;

/**
 * Opens a {@link HarnessTranscriptBytes} over the ONE file a harness proved to be a ferret's transcript (G162). Shared by
 * the harnesses so the rules cannot drift between them:
 *
 * - the handle names no path: `file` is a digest of the path and the file's device and inode, so it changes when the
 *   file is replaced, and no field of the handle and no message of an error it raises carries the path;
 * - it reads only that file: a window is `[offset, offset + length)` clamped to `MAX_ROOT_WINDOW_BYTES`, short where
 *   the file ends and empty past it; a negative, fractional or unsafe offset or length is refused;
 * - every read re-checks the file's identity (before and after the read), so a file replaced after the proof (a rename,
 *   a symlink put in its place) rejects {@link HarnessTranscriptReplaced} instead of being read.
 *
 * `undefined` when the file is not a regular file the root can stat.
 */
export async function openTranscriptBytes(
  root: TranscriptBytesRoot,
  file: FencedPath,
  format: HarnessTranscriptBytes['format'],
  /** SHA-256 of the text as lowercase hex (a contract imports no `node:crypto`, so the harness supplies it). */
  sha256Hex: (text: string) => string,
): Promise<HarnessTranscriptBytes | undefined> {
  const identity = await root.fileIdentity(file);
  const opened = await root.stat(file);
  if (identity === undefined || opened?.kind !== 'file') return undefined;
  const token = sha256Hex(`${file}\0${identity.device}:${identity.inode}`).slice(0, TOKEN_LENGTH);
  // The name still reaches the same device and inode AND the root still stats it as a regular file: the identity alone
  // is not enough, because a symlink made right after the file was removed can be handed the freed inode number, while
  // the root's `stat` refuses a link. (A file removed and recreated under a reused inode is the proved name again, a
  // regular file in the same fenced folder: it is read, never refused, and its `file` token is the same.)
  const same = async (): Promise<boolean> => {
    const now = await root.fileIdentity(file).catch(() => undefined);
    if (now === undefined || now.device !== identity.device || now.inode !== identity.inode) return false;
    return (await root.stat(file).catch(() => undefined))?.kind === 'file';
  };
  return {
    format,
    file: token,
    size: opened.size,
    mtimeMs: Date.parse(opened.modified),
    read: async (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('the transcript offset is out of range');
      if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('the transcript length is out of range');
      if (!(await same())) throw new HarnessTranscriptReplaced();
      if (length === 0) return new Uint8Array(0);
      let bytes: Uint8Array;
      try {
        bytes = await root.readBytes(file, { offset, length: Math.min(length, MAX_ROOT_WINDOW_BYTES) });
      } catch {
        // The root's own message names the path: say only what happened.
        if (!(await same())) throw new HarnessTranscriptReplaced();
        throw new Error('the transcript could not be read');
      }
      if (!(await same())) throw new HarnessTranscriptReplaced();
      return bytes;
    },
    stat: async () => {
      if (!(await same())) return undefined;
      const now = await root.stat(file).catch(() => undefined);
      return now?.kind === 'file' ? { size: now.size, mtimeMs: Date.parse(now.modified) } : undefined;
    },
  };
}
