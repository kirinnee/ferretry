import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type FleetScaffold,
  type FleetScaffolder,
  FleetScaffoldPartialError,
  type FleetScaffoldResult,
} from '../lib/scaffold.ts';

/**
 * Writes a first-run scaffold to a real filesystem.
 *
 * Two properties, and both are refusals:
 *
 * - **A file is written only when nothing is at its path.** Not "when it differs", not "when it looks
 *   like ours" — when it does not exist. `writeFile` with the `wx` flag makes that the kernel's
 *   decision rather than a check-then-write this could lose a race on, so a second `fy fleet init`
 *   running beside the first cannot clobber the config it just wrote.
 * - **Nothing is written outside the roots the composition root declared**, exactly as provisioning
 *   refuses. A scaffold is a much smaller surface than a plan, but it is still paths from a layout,
 *   and the layout is the thing under test when somebody points `FY_HOME` somewhere unexpected.
 *
 * Directories use `mkdir -p`, so an existing one is not an error and its mode is not disturbed —
 * re-running init on a live fleet must not change permissions somebody may have widened on purpose.
 */
export class FileFleetScaffolder implements FleetScaffolder {
  private readonly allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    if (allowedRoots.length === 0) {
      throw new Error('at least one allowed fleet root is required');
    }
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
  }

  /**
   * Prepare a host, reporting exactly what landed if it cannot finish.
   *
   * A scaffold has no undo — every file it writes is one that was absent, so taking them back could
   * not be told apart from deleting files somebody else had just made. Failing part-way is
   * therefore a real state a person is left in, and it is described rather than collapsed into an
   * error that implies nothing happened.
   */
  async scaffold(scaffold: FleetScaffold): Promise<FleetScaffoldResult> {
    const directories: string[] = [];
    const created: string[] = [];
    const kept: string[] = [];
    const progress = { created, kept, directories };

    for (const directory of scaffold.directories) {
      try {
        this.assertWritablePath(directory);
        await mkdir(directory, { recursive: true, mode: scaffold.directoryMode });
      } catch (error) {
        throw new FleetScaffoldPartialError(directory, progress, error);
      }
      directories.push(directory);
    }

    for (const file of scaffold.files) {
      try {
        this.assertWritablePath(file.path);
        // Recorded from inside, the moment the file exists: a `chmod` that fails afterwards does
        // not un-write it, and leaving it out of the report would hide a file that is on the host.
        if (!(await this.writeIfAbsent(file.path, file.content, file.mode, () => created.push(file.path)))) {
          kept.push(file.path);
        }
      } catch (error) {
        throw new FleetScaffoldPartialError(file.path, progress, error);
      }
    }

    return {
      created,
      kept,
      directories: scaffold.directories,
      pathEntry: scaffold.pathEntry,
    };
  }

  /**
   * True when this call created the file; false when a file was already there.
   *
   * "Already there" means a regular file. A directory or a symlink at the path is not a starter
   * file somebody has edited — it is damaged state, and reporting it as kept would tell a person
   * their fleet is set up while the next `apply` fails somewhere far away with a confusing error.
   * Refuse and name the path instead.
   */
  /**
   * @param onCreated Called the instant the file exists, before anything that can still fail.
   *   A scaffold has no undo, so a file this wrote is on the host whether or not the mode was set
   *   afterwards — and a partial report that omitted it would send somebody looking for a file that
   *   is already there.
   */
  private async writeIfAbsent(
    destination: string,
    content: string,
    mode: number,
    onCreated: () => void,
  ): Promise<boolean> {
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, content, { flag: 'wx', mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lstat(destination);
      if (!existing.isFile()) {
        throw new Error(`${destination} exists but is not a file, so the fleet cannot be prepared here`);
      }
      return false;
    }
    onCreated();
    // `wx` honours the process umask, so a mode meant to be private may not be. Set it explicitly.
    await chmod(destination, mode);
    return true;
  }

  /**
   * A scaffold path must sit strictly inside one of the declared roots. The root itself is allowed,
   * because the fleet directory is the first thing a scaffold creates.
   */
  private assertWritablePath(target: string): void {
    const resolved = path.resolve(target);
    const allowed = this.allowedRoots.some(root => {
      if (resolved === root) return true;
      const relative = path.relative(root, resolved);
      return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!allowed) {
      throw new Error(`refusing to write outside configured fleet roots: ${target}`);
    }
  }
}
