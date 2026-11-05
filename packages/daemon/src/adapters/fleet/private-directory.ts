/**
 * A folder only this daemon's account can read or write, for a CLI to be started in.
 *
 * WHY: a CLI reads project files from its working directory — `claude -p` loads `<cwd>/.claude/settings.json`,
 * `.mcp.json` and `CLAUDE.md`, and `codex` reads `AGENTS.md`. Started in a world-writable folder such as
 * `/tmp`, a file somebody else planted there would run with the login's environment. So the runtime check
 * starts its CLI in an empty folder under the state home that nobody else can write to.
 *
 * It is created `0700` when missing; when it exists it must be a real directory (not a symlink) owned by the
 * account this daemon runs as, and any group/other permission is removed. Anything else is refused: a folder
 * that is not ours is not one to hand a login's environment to.
 */
import { chmod, lstat, mkdir } from 'node:fs/promises';

/** Why a folder was not usable as a private working folder. */
export class PrivateDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateDirectoryError';
  }
}

export interface PrivateDirectoryOptions {
  /** The account the daemon runs as. Absent (a platform with no uid): ownership is not checked. */
  readonly uid?: number | undefined;
}

/** Makes `path` a private directory, or throws {@link PrivateDirectoryError} saying why it cannot be. */
export async function ensureOwnedPrivateDirectory(
  path: string,
  options: PrivateDirectoryOptions = {},
): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new PrivateDirectoryError(`${path} is a symbolic link, not a folder of ours.`);
  if (!entry.isDirectory()) throw new PrivateDirectoryError(`${path} is not a folder.`);
  if (options.uid !== undefined && entry.uid !== options.uid) {
    throw new PrivateDirectoryError(`${path} is owned by another account.`);
  }
  if ((entry.mode & 0o077) !== 0) await chmod(path, 0o700);
  return path;
}
