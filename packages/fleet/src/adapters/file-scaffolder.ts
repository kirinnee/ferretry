import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
 *   The check is made twice: on the path as written, and on where its parent physically is, because
 *   a symlinked directory inside a root is lexically inside it and writes somewhere else entirely.
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
    const updated: string[] = [];
    const progress = { created, kept, updated, directories };

    for (const directory of scaffold.directories) {
      try {
        await this.assertWritablePath(directory);
        await mkdir(directory, { recursive: true, mode: scaffold.directoryMode });
      } catch (error) {
        throw new FleetScaffoldPartialError(directory, progress, error);
      }
      directories.push(directory);
    }

    for (const file of scaffold.files) {
      try {
        await this.assertWritablePath(file.path);
        // Recorded from inside, the moment the file exists: a `chmod` that fails afterwards does
        // not un-write it, and leaving it out of the report would hide a file that is on the host.
        if (!(await this.writeIfAbsent(file.path, file.content, file.mode, () => created.push(file.path)))) {
          const replacement =
            file.updateIfPresent === undefined ? undefined : file.updateIfPresent(await readFile(file.path, 'utf8'));
          if (replacement === undefined) {
            kept.push(file.path);
          } else {
            await replaceFile(file.path, replacement);
            updated.push(file.path);
          }
        }
      } catch (error) {
        throw new FleetScaffoldPartialError(file.path, progress, error);
      }
    }

    return {
      created,
      kept,
      updated,
      ...(scaffold.declaration !== undefined &&
      (created.includes(scaffold.declaration.path) || updated.includes(scaffold.declaration.path))
        ? { declaredAccounts: scaffold.declaration.accounts }
        : {}),
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
   *
   * Lexically AND physically: the parent is resolved through every symlink that exists, and so is each
   * root, so a root that is itself a link (a temporary directory on macOS is one) still matches while a
   * linked directory inside a root that points out of it does not.
   */
  private async assertWritablePath(target: string): Promise<void> {
    const resolved = path.resolve(target);
    if (!within(this.allowedRoots, resolved)) {
      throw new Error(`refusing to write outside configured fleet roots: ${target}`);
    }
    // A declared root is where the operator said the fleet lives, wherever that physically is.
    if (this.allowedRoots.includes(resolved)) return;
    const physical = path.join(await physicalPath(path.dirname(resolved), target), path.basename(resolved));
    const physicalRoots = await Promise.all(this.allowedRoots.map(root => physicalPath(root, target)));
    if (!within(physicalRoots, physical)) {
      throw new Error(`refusing to write outside configured fleet roots: ${target}`);
    }
  }
}

const within = (roots: readonly string[], resolved: string): boolean =>
  roots.some(root => {
    if (resolved === root) return true;
    const relative = path.relative(root, resolved);
    return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });

/**
 * Where an absolute path physically is: its deepest existing ancestor resolved through every link,
 * with the components that do not exist yet appended as written — nothing can redirect a directory
 * this is about to create.
 *
 * A component that is there but resolves to nothing is a dangling link, and a `mkdir` through it would
 * create its target wherever it points, so that is refused rather than read as "not there yet".
 */
async function physicalPath(absolute: string, target: string): Promise<string> {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const dangling = await lstat(current).then(
      () => true,
      () => false,
    );
    if (dangling) {
      throw new Error(`refusing to write through a link that points at nothing: ${target}`);
    }
    // The filesystem root always exists, so this walk ends there at the latest.
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
}

/**
 * Replace an existing file atomically and at the mode it already has.
 *
 * Rewriting it in place would leave a truncated starter behind a crash, and would write through a link
 * swapped in after the check; a rename replaces the name, never the file a link points at. The mode
 * is the existing file's because somebody may have widened it on purpose, exactly as for directories.
 */
async function replaceFile(destination: string, content: string): Promise<void> {
  const { mode } = await stat(destination);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, mode & 0o7777);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
