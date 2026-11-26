import { createHash } from 'node:crypto';
import type { EngineFile } from '../engine/catalog.ts';
import type { EngineFilesPort } from '../engine/ports.ts';

/** Whether `bytes` are exactly the pinned file: its size AND its SHA-256. */
export const isPinned = (bytes: Uint8Array, file: Pick<EngineFile, 'bytes' | 'sha256'>): boolean =>
  bytes.byteLength === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256;

/**
 * The files of `files` that are NOT the pinned ones, read back from disk now: the folder is one other programs of this
 * user can write, and what is hashed here is what is loaded next (a native library is code this process is about to run,
 * a model is what that code is fed), so "present at its size" is not what is checked: the bytes are hashed again before
 * EVERY load (the residual hash-to-load gap is declared in docs/voice-modes.md §2.3.1). A file that is missing counts as bad.
 */
export async function unverified(
  files: Pick<EngineFilesPort, 'read'>,
  wanted: readonly EngineFile[],
): Promise<EngineFile[]> {
  const bad: EngineFile[] = [];
  for (const file of wanted) {
    const bytes = await files.read(file);
    if (bytes === undefined || !isPinned(bytes, file)) bad.push(file);
  }
  return bad;
}
