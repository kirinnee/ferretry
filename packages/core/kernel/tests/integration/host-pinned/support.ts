import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Every test in this suite operates on throwaway directories under the OS temp directory. Nothing here may
 * ever resolve a developer checkout or a real state home.
 */
const created: string[] = [];

/** A temp directory (its real path) that the suite deletes on teardown. */
export async function tempDirectory(label: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), `fy-${label}-`)));
  created.push(directory);
  return directory;
}

export async function cleanupTempDirectories(): Promise<void> {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}
