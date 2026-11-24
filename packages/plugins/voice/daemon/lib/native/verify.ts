import { createHash } from 'node:crypto';
import type { EngineFile } from '../engine/catalog.ts';
import type { EngineFilesPort } from '../engine/ports.ts';

/**
 * The files of `native` that are NOT the pinned ones, read back from disk now: a native library is code this process is
 * about to run, so "present at its size" (enough for a model, which was hashed as it was written) is not what is checked
 * here; the bytes are hashed again before EVERY load (the residual hash-to-load gap is declared in
 * docs/voice-modes.md §2.3.1). A file that is missing counts as bad.
 */
export async function unverified(
  files: Pick<EngineFilesPort, 'read'>,
  native: readonly EngineFile[],
): Promise<EngineFile[]> {
  const bad: EngineFile[] = [];
  for (const file of native) {
    const bytes = await files.read(file);
    if (
      bytes === undefined ||
      bytes.byteLength !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      bad.push(file);
  }
  return bad;
}
