import { createHash } from 'node:crypto';
import type { EngineFile } from '../engine/catalog.ts';
import type { EngineFilesPort } from '../engine/ports.ts';

/** Whether `bytes` are exactly the pinned file: its size AND its SHA-256. */
export const isPinned = (bytes: Uint8Array, file: Pick<EngineFile, 'bytes' | 'sha256'>): boolean =>
  bytes.byteLength === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256;

/**
 * What each files port has proved while this daemon runs: a file's role, the identity it had when its bytes hashed as pinned, and
 * the digest it was proved against. Per port, so two ports never vouch for each other, and gone when the daemon stops.
 */
const proved = new WeakMap<object, Map<string, { readonly identity: string; readonly sha256: string }>>();

/**
 * The files of `wanted` that are NOT the pinned ones, read back from disk now: the folder is one other programs of this
 * user can write, and what is hashed here is what is loaded next (a native library is code this process is about to run,
 * a model is what that code is fed), so "present at its size" is not what is checked: the bytes are hashed again before
 * EVERY load (the residual hash-to-load gap is declared in docs/voice-modes.md §2.3.1). A file that is missing counts as bad.
 *
 * A port that can say a file's identity (device, inode, size, change times: an etag that is settled) lets a file this daemon already proved skip the
 * read and the hash while that identity is unchanged: rewriting or replacing a file moves it, so a changed file is hashed
 * again. A file without an identity is always hashed.
 */
export async function unverified(
  files: Pick<EngineFilesPort, 'read'> & {
    readonly identity?: (file: Pick<EngineFile, 'role'>) => Promise<string | undefined>;
  },
  wanted: readonly EngineFile[],
): Promise<EngineFile[]> {
  const memo = proved.get(files) ?? new Map<string, { readonly identity: string; readonly sha256: string }>();
  proved.set(files, memo);
  const bad: EngineFile[] = [];
  for (const file of wanted) {
    // The identity is taken BEFORE the read: a file replaced during the read shows a different one next time.
    const identity = await files.identity?.(file);
    const known = memo.get(file.role);
    if (identity !== undefined && known?.identity === identity && known.sha256 === file.sha256) continue;
    memo.delete(file.role);
    const bytes = await files.read(file);
    if (bytes === undefined || !isPinned(bytes, file)) bad.push(file);
    else if (identity !== undefined) memo.set(file.role, { identity, sha256: file.sha256 });
  }
  return bad;
}
