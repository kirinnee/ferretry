import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isLaunchOverlayFileName,
  type LaunchOverlayFile,
  type LaunchOverlayFiles,
} from '../../../lib/session/launch/index.ts';

/** The directory is the daemon's alone. */
const DIRECTORY_MODE = 0o700;
/** A file may hold the login's credential, so it is the owner's alone. */
const FILE_MODE = 0o600;
/** A launch file nobody has asked about for this long is swept: a live session's is touched whenever its argv is rebuilt. */
const SWEEP_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A leftover of an interrupted write. */
const TEMPORARY_SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The per-launch Claude settings files, one directory of them.
 *
 * WHY A FILE. A login's literal credential is pinned in its fixed settings, and a fast or compact launch replaces
 * that file with a merged overlay. The overlay used to be written into the argv; with a credential in it that
 * reached `ps` and the session's recorded command. It is written here instead and the argv names its path.
 *
 * CONTENT-ADDRESSED, so the path is a pure function of the launch (the name says which login settings, compaction
 * trigger and fast mode) and a revive, a Restart or a move rebuilds the very file a running process was started
 * with. The write is atomic (a private temporary file, then a rename) and the file is 0600 in a 0700 directory.
 *
 * SWEPT SAFELY. Only files of this shape are ever removed, only once they are older than {@link SWEEP_AFTER_MS},
 * never the one just placed, and every use (a launch, or a stale-settings read) touches the file, so a session
 * that is still being looked after keeps its own. A swept file is simply written again by the next launch.
 */
export class FileLaunchOverlayFiles implements LaunchOverlayFiles {
  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  async place(file: LaunchOverlayFile, options: { readonly write: boolean }): Promise<string | undefined> {
    const path = join(this.directory, file.name);
    if (!options.write) {
      const present = await stat(path).catch(() => undefined);
      if (present !== undefined) await this.#touch(path);
      return path;
    }
    await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(this.directory, DIRECTORY_MODE).catch(() => undefined);
    const existing = await readFile(path, 'utf8').catch(() => undefined);
    if (existing !== file.content) {
      const temporary = join(this.directory, `.${file.name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await writeFile(temporary, file.content, { mode: FILE_MODE, flag: 'wx' });
        await rename(temporary, path);
      } catch (failure) {
        await unlink(temporary).catch(() => undefined);
        throw failure;
      }
    }
    await chmod(path, FILE_MODE).catch(() => undefined);
    await this.#touch(path);
    await this.#sweep(file.name);
    return path;
  }

  async #touch(path: string): Promise<void> {
    const instant = new Date(this.now());
    await utimes(path, instant, instant).catch(() => undefined);
  }

  /** Best effort: a sweep that fails leaves old files for the next one. */
  async #sweep(keep: string): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      const launch = isLaunchOverlayFileName(name);
      const leftover = name.startsWith('.launch-') && name.endsWith('.tmp');
      if (name === keep || (!launch && !leftover)) continue;
      const path = join(this.directory, name);
      const found = await stat(path).catch(() => undefined);
      if (found === undefined || !found.isFile()) continue;
      if (this.now() - found.mtimeMs > (launch ? SWEEP_AFTER_MS : TEMPORARY_SWEEP_AFTER_MS))
        await unlink(path).catch(() => undefined);
    }
  }
}
