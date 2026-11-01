import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  type FolderDisk,
  type GuardedFolder,
  type GuardRule,
  openFolderBelow,
  openFolderOutsideStateHomes,
  removeEntryWithin,
  type StateHomes,
} from '../lib/state-home-guard.ts';
import { NodeGuardDisk } from './node-guard-disk.ts';

/**
 * The bytes of the regular file at `target`, read WITHOUT following a link at its last step and without blocking
 * on a pipe. A destination's entries sit in folders a harness can write, so a file looked at a moment ago may be a
 * link into the state home by now; reading it this way refuses that (`ELOOP`) instead of reading the home.
 *
 * Synchronous on purpose: a seal reads every file of a skills tree, and each asynchronous file-handle call costs
 * Bun about as much as reading a small file whole, which turned a rollback of a 2,500-file tree from seconds into
 * many. These are an account's own small files, read once each.
 */
export async function readRegularFile(target: string): Promise<Buffer> {
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${target} is not a regular file`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** A destination folder the state-home guard refused: the message names the rule and the folder, never its contents. */
class DestinationRefusedError extends Error {
  constructor(
    folder: string,
    readonly rule: GuardRule,
    home?: string,
  ) {
    super(`refusing to write in ${folder}: ${DestinationRefusedError.why(rule, home)}`);
    this.name = 'DestinationRefusedError';
  }

  private static why(rule: GuardRule, home: string | undefined): string {
    switch (rule) {
      case 'state-home':
        return `it is inside this daemon's state home (${home ?? 'FY_HOME'}), which holds this machine's credentials`;
      case 'link':
        return "a symbolic link stands where a folder must be, inside this daemon's state home, so it is not followed";
      case 'not-a-folder':
        return 'it is not a folder';
      default:
        return `the state-home guard refused it (${rule})`;
    }
  }
}

/**
 * A move or a delete this platform cannot make safely, so it is not made: the folder is reached by path (no
 * descriptor paths — macOS) and is below a runtime's top folder, where the runtime's harness can swap it for a link
 * between the check and the step. The provisioner skips the operation and says so in its result; a rollback reports
 * the entry it could not take back.
 */
export class ConfinedDestinationError extends Error {
  constructor(readonly target: string) {
    super(
      `not moving or removing ${target} on this platform: its folder is reached by path below a runtime's top folder, where a swap timed between the check and the step could redirect it into the state home`,
    );
    this.name = 'ConfinedDestinationError';
  }
}

const strictlyInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * THE PROVISIONER'S DESTINATION SIDE, through the one state-home guard (`../lib/state-home-guard.ts`).
 *
 * A runtime's folder is written by its harness, and so by the agent running in it: anything below the runtime's
 * top folder can be swapped for a link the moment after it was checked. So nothing below it is reached by path.
 * Every read, write, move and delete goes through a folder opened and checked here, and reaches the entry
 * THROUGH that handle (Linux `/proc/self/fd/N/<leaf>`): inside a home, every folder is opened from the home down
 * without following a link, and anywhere else where a folder lands must be outside every home. A refusal throws
 * {@link DestinationRefusedError}, and the apply rolls back.
 *
 * `homes` absent (a provisioner given no fence, as in a test of the copy itself) judges no home and still reaches
 * every entry through a checked handle.
 *
 * **Where there are no descriptor paths (macOS), it fails closed below a runtime's top folder** (`tops`, the
 * runtimes' own folders): every step there re-proves the folder and then goes by path, and a swap timed between the
 * two could still redirect a rename or an unlink into the home. So no name there is moved aside or removed
 * ({@link ConfinedDestinationError}); only a temporary this apply minted under a random name is ever unlinked. A
 * Linux host asked for descriptor paths that has no `/proc` refuses every apply rather than reading every folder
 * as empty.
 */
export class DestinationFolders {
  private realTops: Promise<readonly string[]> | undefined;

  constructor(
    private readonly homes: StateHomes | undefined,
    private readonly disk: FolderDisk = new NodeGuardDisk(),
    private readonly tops: readonly string[] = [],
  ) {}

  /** Whether moving aside or removing a name in `folder` is refused here (see the class). */
  async confined(folder: GuardedFolder): Promise<boolean> {
    if (folder.anchored) return false;
    this.realTops ??= Promise.all(this.tops.map(async top => await realpath(top).catch(() => path.resolve(top))));
    return (await this.realTops).some(top => strictlyInside(top, folder.path));
  }

  /** Throws {@link ConfinedDestinationError} for `target`, a name in `folder`, when moving it aside is refused here. */
  async assertMayMove(folder: GuardedFolder, target: string): Promise<void> {
    if (await this.confined(folder)) throw new ConfinedDestinationError(target);
  }

  private reachable(): void {
    if (this.disk.missingDescriptorPaths === true) {
      throw new Error(
        'refusing to provision: this host has no /proc/self/fd, so no destination folder can be reached through its descriptor',
      );
    }
  }

  /** The folder at `folder`, checked, or `undefined` when it (or a folder above it) is not there. */
  async existing(folder: string): Promise<GuardedFolder | undefined> {
    this.reachable();
    const opened = await openFolderOutsideStateHomes(folder, this.homes, this.disk);
    if (opened.ok) return opened.value;
    if (opened.rule === 'not-found') return undefined;
    throw new DestinationRefusedError(folder, opened.rule, opened.home);
  }

  /** The folder at `folder`, checked, made first (each missing folder with `mode`) when it is not there. */
  async made(folder: string, mode: number): Promise<GuardedFolder> {
    this.reachable();
    const opened = await openFolderOutsideStateHomes(folder, this.homes, this.disk, { make: mode });
    if (opened.ok) return opened.value;
    throw new DestinationRefusedError(folder, opened.rule, opened.home);
  }

  /** The folder `leaf` inside the checked `parent`, opened through it without following a link; made with `mode` when given. */
  async child(parent: GuardedFolder, leaf: string, label: string, mode?: number): Promise<GuardedFolder> {
    const opened = await openFolderBelow(parent, leaf, this.homes, this.disk, mode === undefined ? {} : { make: mode });
    if (opened.ok) return opened.value;
    throw new DestinationRefusedError(label, opened.rule, opened.home);
  }

  /** Removes `leaf` of the checked `folder` — a file, a link, or a whole tree — never following a link. */
  async remove(folder: GuardedFolder, leaf: string): Promise<void> {
    await this.assertMayMove(folder, path.join(folder.path, leaf));
    await removeEntryWithin(folder, leaf, this.homes, this.disk);
  }

  /**
   * Unlinks a FILE this apply created under a random name (a temporary, a staged copy of a file). Allowed even where
   * {@link remove} is not: a swap can only redirect it to a name nobody else has. Already gone is done.
   */
  async removeOwnFile(folder: GuardedFolder, leaf: string): Promise<void> {
    await this.disk.unlink(await folder.entry(leaf)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /** Removes the EMPTY folder `leaf` of the checked `folder` (`rmdir`, which never follows a link). */
  async removeEmpty(folder: GuardedFolder, leaf: string): Promise<void> {
    await this.assertMayMove(folder, path.join(folder.path, leaf));
    await this.disk.rmdir(await folder.entry(leaf));
  }

  /** Runs `use` with the folder at `folder` (or `undefined` when it is not there), and closes it after. */
  async within<T>(folder: string, use: (opened: GuardedFolder | undefined) => Promise<T>): Promise<T> {
    const opened = await this.existing(folder);
    try {
      return await use(opened);
    } finally {
      await opened?.close();
    }
  }
}
