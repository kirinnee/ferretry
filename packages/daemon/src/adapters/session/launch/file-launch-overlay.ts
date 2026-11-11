import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isLaunchOverlayFileName,
  type LaunchOverlayFile,
  type LaunchOverlayFiles,
} from '../../../lib/session/launch/index.ts';

/** The directory is the daemon's alone. */
const DIRECTORY_MODE = 0o700;
/** A file may hold the login's credential, so it is the owner's alone. */
const FILE_MODE = 0o600;
/** A launch file nobody has launched under for this long is swept: every launch writes a fresh one. */
const SWEEP_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A leftover of an interrupted write. */
const TEMPORARY_SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;
/** Created new, never through a symlink, for writing: the one way this adapter ever opens a file. */
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * The recorded commands of the sessions that are still alive, which name the launch files they run under.
 *
 * A session that is not terminated may be revived, and its recorded command is what a revive and the stale-settings
 * read start from, so the file that command names must outlive any sweep. Raises when the answer cannot be had.
 */
export interface LiveLaunchCommands {
  commands(): Promise<readonly (readonly string[])[]>;
}

/** Where the directory lives and who may delete from it; `root` is the state home the directory's checks start at. */
export interface FileLaunchOverlayOptions {
  /** The state home: every directory from here down to the launch directory is checked. */
  readonly root: string;
  readonly live: LiveLaunchCommands;
  readonly now?: () => number;
}

/**
 * The per-launch Claude settings files, one directory of them.
 *
 * WHY A FILE. A login's literal credential is pinned in its fixed settings, and a fast or compact launch replaces
 * that file with a merged overlay. The overlay used to be written into the argv; with a credential in it that
 * reached `ps` and the session's recorded command. It is written here instead and the argv names its path.
 *
 * CONTENT-ADDRESSED, so the path is a pure function of the launch (the name says which login settings, compaction
 * trigger and fast mode) and a revive, a Restart or a move rebuilds the very file a running process was started
 * with.
 *
 * NOTHING FOUND AT THE PATH IS TRUSTED. Whatever is already there — a file, a planted symlink, a directory — is
 * never read, reused, chmod-ed or touched: every launch writes a FRESH file (a new name made with
 * `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, synced) and `rename`s it over the final name, which replaces a symlink
 * instead of following it. The directory is made 0700 and then every directory from the state home down to it is
 * `lstat`ed: each must be a real directory (no symlink), ours, and writable by us alone, or the launch is refused.
 * A wrong mode is a refusal, never something this adapter repairs by path.
 *
 * SWEPT SAFELY. Only files of this shape are ever removed, only once they are older than {@link SWEEP_AFTER_MS}
 * (a launch writes a fresh file, so that is counted from the last launch or revive), never the one just placed and
 * never one a live session's recorded command names. A swept file is simply written again by the next launch.
 */
export class FileLaunchOverlayFiles implements LaunchOverlayFiles {
  readonly #directory: string;
  readonly #root: string;
  readonly #live: LiveLaunchCommands;
  readonly #now: () => number;

  constructor(directory: string, options: FileLaunchOverlayOptions) {
    this.#directory = resolve(directory);
    this.#root = resolve(options.root);
    this.#live = options.live;
    this.#now = options.now ?? Date.now;
  }

  async place(file: LaunchOverlayFile, options: { readonly write: boolean }): Promise<string | undefined> {
    const path = join(this.#directory, file.name);
    // A stale-settings read only asks where the file would be: nothing is created, read or touched.
    if (!options.write) return path;
    await this.#ensureDirectory();
    const temporary = join(this.#directory, `.${file.name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await open(temporary, CREATE_FLAGS, FILE_MODE);
      try {
        await handle.writeFile(file.content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (failure) {
      await unlink(temporary).catch(() => undefined);
      throw failure;
    }
    await this.#sweep(file.name);
    return path;
  }

  /** Makes the directory, then proves every directory from the state home down to it is ours and not a symlink. */
  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const inside = relative(this.#root, this.#directory);
    // A directory outside the root has no chain to walk: it alone is checked.
    const chain =
      inside.startsWith('..') || isAbsolute(inside)
        ? [this.#directory]
        : inside
            .split(sep)
            .reduce<string[]>((paths, step) => [...paths, join(paths.at(-1) ?? this.#root, step)], [this.#root]);
    const uid = process.getuid?.();
    for (const directory of chain) {
      const found = await lstat(directory).catch(() => undefined);
      if (found === undefined || found.isSymbolicLink() || !found.isDirectory())
        throw new Error(
          `${directory} is not a plain directory (it is missing or a symlink), so no launch settings file is written there`,
        );
      if (uid !== undefined && found.uid !== uid)
        throw new Error(`${directory} is owned by another user, so no launch settings file is written there`);
      if ((found.mode & 0o022) !== 0)
        throw new Error(
          `${directory} is writable by its group or by everyone, so no launch settings file is written there; make it private (mode 700)`,
        );
    }
  }

  /** Best effort: a sweep that fails (or cannot learn which files are alive) leaves old files for the next one. */
  async #sweep(keep: string): Promise<void> {
    const names = await readdir(this.#directory).catch(() => [] as string[]);
    const candidates = names.filter(name => name !== keep && (isLaunchOverlayFileName(name) || isLeftover(name)));
    if (candidates.length === 0) return;
    const alive = await this.#live.commands().then(
      commands => commands.flat(),
      () => undefined,
    );
    for (const name of candidates) {
      const launch = isLaunchOverlayFileName(name);
      const path = join(this.#directory, name);
      // A launch file whose liveness cannot be known is kept, never guessed at.
      if (launch && (alive === undefined || alive.some(argument => argument.includes(path)))) continue;
      const found = await lstat(path).catch(() => undefined);
      if (found === undefined || !found.isFile()) continue;
      if (this.#now() - found.mtimeMs > (launch ? SWEEP_AFTER_MS : TEMPORARY_SWEEP_AFTER_MS))
        await unlink(path).catch(() => undefined);
    }
  }
}

const isLeftover = (name: string): boolean => name.startsWith('.launch-') && name.endsWith('.tmp');
