import { dirname } from 'node:path';
import type { FileSystemPort } from '../../../lib/ports.ts';

/**
 * Writes one JSON document so that no reader ever sees half of it.
 *
 * The monitor's two artifacts are read by things that cannot ask again — a human at a terminal, a
 * warden sweep, a supervisor that has just restarted — and a truncated heartbeat would read as a
 * damaged park rather than as a partial write. The file system port replaces the target atomically
 * (a temporary file beside it, renamed over), so the directory is made private first and the document
 * lands whole.
 */
export async function writeJsonAtomic(
  fileSystem: Pick<FileSystemPort, 'ensureDirectory' | 'writeTextAtomic'>,
  file: string,
  document: unknown,
): Promise<void> {
  await fileSystem.ensureDirectory(dirname(file), 0o700);
  await fileSystem.writeTextAtomic(file, `${JSON.stringify(document)}\n`);
}
