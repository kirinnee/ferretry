import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes one JSON document so that no reader ever sees half of it.
 *
 * The monitor's two artifacts are read by things that cannot ask again — a human at a terminal, a
 * warden sweep, a supervisor that has just restarted — and a truncated heartbeat would read as a
 * damaged park rather than as a partial write. The payload lands beside the target and is renamed
 * over it, which is atomic within a filesystem.
 */
export async function writeJsonAtomic(
  file: string,
  document: unknown,
  uniqueId: () => string = randomUUID,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${uniqueId()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}
