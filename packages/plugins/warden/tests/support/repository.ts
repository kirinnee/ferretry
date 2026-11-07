/** Temporary directories for the integration tests that exercise the adapters' real files; removed after the run. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const made: string[] = [];

export async function tempDirectory(prefix = 'fy-warden-'): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  made.push(directory);
  return directory;
}

export async function cleanupTempDirectories(): Promise<void> {
  await Promise.all(made.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
}
