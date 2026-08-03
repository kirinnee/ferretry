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
 * Read the token `fyd` mints at `<FY_HOME>/api-token`.
 *
 * A local account with broader-than-owner permissions could steal the daemon's admin credential,
 * so do not accept a file that grants any group or other access. Missing, unreadable, and empty
 * evidence remain distinct failures to make first-run recovery diagnosable.
 */
export async function readDaemonToken(path: string, fileSystem = nodeFileSystem): Promise<string> {
  let metadata: Awaited<ReturnType<DaemonTokenFileSystem['stat']>>;
  try {
    metadata = await fileSystem.stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token is missing at ${path}`);
    }
    throw new DaemonTokenFileError(
      `FY_TOKEN is not set and the daemon token cannot be inspected at ${path}: ${(error as Error).message}`,
    );
  }

  if (!metadata.isFile()) {
    throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token at ${path} is not a regular file`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new DaemonTokenFileError(
      `refusing daemon token at ${path}: permissions must be owner-only (current mode ${(metadata.mode & 0o777).toString(8)})`,
    );
  }

  let text: string;
  try {
    text = await fileSystem.readFile(path, 'utf8');
  } catch (error) {
    throw new DaemonTokenFileError(
      `FY_TOKEN is not set and the daemon token cannot be read at ${path}: ${(error as Error).message}`,
    );
  }
  const token = text.trim();
  if (token === '') throw new DaemonTokenFileError(`FY_TOKEN is not set and the daemon token at ${path} is empty`);
  return token;
}
