import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
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
      case 'changed':
        return 'it changed while it was being checked';
      default:
        return `the state-home guard refused it (${rule})`;
    }
  }
}

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
 */
export class DestinationFolders {
  constructor(
    private readonly homes: StateHomes | undefined,
    private readonly disk: FolderDisk = new NodeGuardDisk(),
  ) {}

  /** The folder at `folder`, checked, or `undefined` when it (or a folder above it) is not there. */
  async existing(folder: string): Promise<GuardedFolder | undefined> {
    const opened = await openFolderOutsideStateHomes(folder, this.homes, this.disk);
    if (opened.ok) return opened.value;
    if (opened.rule === 'not-found') return undefined;
    throw new DestinationRefusedError(folder, opened.rule, opened.home);
  }

  /** The folder at `folder`, checked, made first (each missing folder with `mode`) when it is not there. */
  async made(folder: string, mode: number): Promise<GuardedFolder> {
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
    await removeEntryWithin(folder, leaf, this.homes, this.disk);
  }

  /** Removes the EMPTY folder `leaf` of the checked `folder` (`rmdir`, which never follows a link). */
  async removeEmpty(folder: GuardedFolder, leaf: string): Promise<void> {
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
