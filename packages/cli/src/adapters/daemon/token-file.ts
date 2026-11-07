import { readFile, stat } from 'node:fs/promises';

export interface DaemonTokenFileSystem {
  stat(path: string): Promise<{ isFile(): boolean; mode: number }>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

const nodeFileSystem: DaemonTokenFileSystem = { stat, readFile };

/** A credential-file failure is actionable but never includes the credential's contents. */
export class DaemonTokenFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonTokenFileError';
  }
}

/**
 * Reads the admin token Gate mints. A file that grants any group or other access is refused: a local account with
 * broader permissions could steal the daemon's whole authority. Missing, unreadable and empty stay distinct failures.
 */
export async function readAdminToken(path: string, fileSystem = nodeFileSystem): Promise<string> {
  let metadata: Awaited<ReturnType<DaemonTokenFileSystem['stat']>>;
  try {
    metadata = await fileSystem.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token is missing at ${path}`);
    throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token cannot be inspected at ${path}: ${(error as Error).message}`);
  }
  if (!metadata.isFile()) throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token at ${path} is not a regular file`);
  if ((metadata.mode & 0o077) !== 0)
    throw new DaemonTokenFileError(
      `refusing daemon token at ${path}: permissions must be owner-only (current mode ${(metadata.mode & 0o777).toString(8)})`,
    );
  let text: string;
  try {
    text = await fileSystem.readFile(path, 'utf8');
  } catch (error) {
    throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token cannot be read at ${path}: ${(error as Error).message}`);
  }
  const token = text.trim();
  if (token === '') throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token at ${path} is empty`);
  return token;
}
