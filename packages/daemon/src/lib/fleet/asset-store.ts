/**
 * Reading and locating the text files the fleet copies into account homes.
 *
 * This is the filesystem half of the asset boundary; `assets.ts` is the pure half. Everything here
 * answers a question only the filesystem can: is this path still inside the tree, is the entry a
 * regular file, and is what it holds text a person could have been editing.
 *
 * **Every read goes through a pinned root.** A resolved pathname is only a claim about the past:
 * between checking a directory and opening a file beneath it, the directory can be renamed away and
 * replaced with a link to anywhere, after which a path-based read lands outside the tree having
 * passed every check. `SessionRootPinner` holds the root open as an object rather than a name and
 * walks each component from that descriptor, refusing a link at any of them — the same primitive
 * the session file surface uses, for the same reason. A platform that cannot pin fails closed.
 *
 * Nothing here writes. A proposal's asset edits travel to disk through the provisioner, inside the
 * same rollback boundary as the fleet they belong to — a saved instruction file with no account to
 * copy it into is exactly the half-state that boundary exists to prevent.
 */
import type { PinnedRoot, PinnedTarget, SessionRootPinner } from '../session/filesystem/ports.ts';
import { FsError } from '../session/filesystem/types.ts';
import {
  type FleetAssetListing,
  FleetAssetRefusal,
  isEditableText,
  MAX_ASSET_FILE_BYTES,
  parseAssetPath,
} from './assets.ts';

/** How many entries a listing will report before it says the tree is larger than it can describe. */
const MAX_ASSET_ENTRIES = 500;
/** How many entries it will *visit*, so a tree of empty directories cannot make it walk forever. */
const MAX_ASSET_VISITS = 5000;
/** How deep it will go. A path is bounded to the same depth, so anything deeper is not editable. */
const MAX_ASSET_DEPTH = 8;

/**
 * Decode bytes as text, refusing anything that is not valid UTF-8.
 *
 * Reading with a UTF-8 encoding silently substitutes replacement characters for invalid bytes, so a
 * binary file arrives looking like text and an editor round-trip would corrupt it. Fatal decoding
 * makes "is this text" the question it appears to be.
 */
function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export interface FleetAssetDocument {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
}

/** Everything the asset tree holds, and whether that is all of it. */
export interface FleetAssetTree {
  readonly files: readonly FleetAssetListing[];
  /** False when a bound stopped the walk, so a caller never reads a partial list as the whole. */
  readonly complete: boolean;
}

interface WalkState {
  readonly found: FleetAssetListing[];
  visits: number;
  complete: boolean;
}

/**
 * The pinned walk speaks its own taxonomy rather than errno, so both are read here: `not_found` is
 * what it reports for an absent entry, and a raw `ENOENT` still reaches this from the pin itself.
 */
function isMissing(error: unknown): boolean {
  if (error instanceof FsError) return error.code === 'not_found';
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** A component of the walk was a link, or the leaf was not the kind of thing that was asked for. */
function isConfinementRefusal(error: unknown): boolean {
  return (
    error instanceof FsError &&
    (error.code === 'escapes_root' || error.code === 'not_a_directory' || error.code === 'not_a_file')
  );
}

export interface FleetAssetStoreOptions {
  /**
   * The directory held open — an ancestor the asset tree sits *inside*, never the tree itself.
   *
   * Pinning `fleet/assets` would make the guarded pathname its own guard: swap that one directory
   * for a link a moment before the pin and the pin follows it, after which every component below
   * is faithfully walked inside somebody else's tree. Pinning the state home instead puts `fleet`
   * and `assets` on the walk like any other component, so swapping either is refused.
   */
  readonly trustedRoot: string;
  /** Where the asset tree sits beneath that root, `/`-separated. */
  readonly assetsPrefix: string;
  /** The absolute asset path, for reporting and for the provisioner's own containment check. */
  readonly assetsDirectory: string;
  readonly pinner: SessionRootPinner;
}

export class FleetAssetStore {
  constructor(private readonly options: FleetAssetStoreOptions) {}

  /** One asset-relative path, as the pinned walk names it: beneath the trusted root. */
  private within(relative: string): string {
    const prefix = this.options.assetsPrefix;
    if (prefix === '') return relative;
    return relative === '' ? prefix : `${prefix}/${relative}`;
  }

  /**
   * Hold the trusted root open for the duration of one operation.
   *
   * A tree that does not exist yet is not damage — a host prepared but never edited has none — so
   * that case is reported as an empty read rather than as a failure. Anything else is a refusal.
   */
  private async pinned<T>(use: (root: PinnedRoot) => Promise<T>, absent: () => T): Promise<T> {
    let root: PinnedRoot;
    try {
      root = await this.options.pinner.pin(this.options.trustedRoot);
    } catch (error) {
      if (isMissing(error)) return absent();
      throw new FleetAssetRefusal(`the fleet asset tree could not be opened safely: ${reasonOf(error)}`);
    }
    try {
      return await use(root);
    } finally {
      await root.close();
    }
  }

  /**
   * Every asset the tree holds, described honestly.
   *
   * A file that cannot be edited here — too large, not text, not a regular file — is still listed,
   * with the reason. Hiding it would tell a person their instructions are missing when they are
   * merely something this editor will not touch.
   */
  async list(): Promise<FleetAssetTree> {
    return await this.pinned(
      async root => {
        const walk: WalkState = { found: [], visits: 0, complete: true };
        await this.walk(root, '', 0, walk);
        return {
          files: walk.found.toSorted((left, right) => left.path.localeCompare(right.path)),
          // Said out loud, because a truncated list that looks complete is how a person concludes
          // their instructions are missing when they are merely past where this stopped describing.
          complete: walk.complete,
        };
      },
      () => ({ files: [], complete: true }),
    );
  }

  private async walk(root: PinnedRoot, prefix: string, depth: number, walk: WalkState): Promise<void> {
    if (depth >= MAX_ASSET_DEPTH) {
      walk.complete = false;
      return;
    }

    let directory: PinnedTarget;
    try {
      directory = await root.open(this.within(prefix), { wantDirectory: true });
    } catch (error) {
      // The asset tree itself being absent is the ordinary first-run case, not damage.
      if (prefix === '' && isMissing(error)) return;
      // A directory that vanished or turned into a link between being listed and being opened is
      // not described rather than guessed at.
      walk.complete = false;
      return;
    }

    let listing: Awaited<ReturnType<PinnedTarget['list']>>;
    try {
      listing = await directory.list(MAX_ASSET_ENTRIES);
    } finally {
      await directory.close();
    }
    if (listing.truncated) walk.complete = false;

    for (const entry of [...listing.entries].sort((left, right) => left.name.localeCompare(right.name))) {
      walk.visits += 1;
      if (walk.visits > MAX_ASSET_VISITS || walk.found.length >= MAX_ASSET_ENTRIES) {
        walk.complete = false;
        return;
      }
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.type === 'symlink') {
        walk.found.push({
          path: relative,
          bytes: 0,
          readable: false,
          reason: 'is a link, which the asset editor never follows',
        });
        continue;
      }
      if (entry.type === 'dir') {
        await this.walk(root, relative, depth + 1, walk);
        continue;
      }
      if (entry.type !== 'file') {
        walk.found.push({ path: relative, bytes: 0, readable: false, reason: 'is not a regular file' });
        continue;
      }
      walk.found.push(await this.describe(root, relative));
    }
  }

  /** Describe one entry through the pinned walk, never through its pathname. */
  private async describe(root: PinnedRoot, relative: string): Promise<FleetAssetListing> {
    const damaged = (bytes: number, reason: string): FleetAssetListing => ({
      path: relative,
      bytes,
      readable: false,
      reason,
    });

    let target: PinnedTarget;
    try {
      target = await root.open(this.within(relative));
    } catch (error) {
      if (isMissing(error)) return damaged(0, 'was removed while the tree was being read');
      return damaged(0, 'could not be opened safely');
    }

    try {
      if (target.metadata.type !== 'file') return damaged(0, 'is not a regular file');
      // One byte past the limit rather than the size just observed, so growth is caught by the read
      // itself instead of being trusted away. `undefined` means it exceeded the cap.
      const bytes = await target.read(MAX_ASSET_FILE_BYTES + 1);
      if (bytes === undefined || bytes.length > MAX_ASSET_FILE_BYTES) {
        return damaged(target.metadata.size, `is larger than ${MAX_ASSET_FILE_BYTES} bytes`);
      }
      const content = decodeText(bytes);
      if (content === undefined) return damaged(bytes.length, 'is not valid text');
      if (!isEditableText(content)) return damaged(bytes.length, 'is not editable text');
      return { path: relative, bytes: bytes.length, readable: true };
    } finally {
      await target.close();
    }
  }

  /** One asset's text, or a refusal saying exactly why it is not readable here. */
  async read(relative: string): Promise<FleetAssetDocument> {
    const safe = parseAssetPath(relative);
    return await this.pinned(
      async root => {
        let target: PinnedTarget;
        try {
          target = await root.open(this.within(safe));
        } catch (error) {
          if (isMissing(error)) throw new FleetAssetRefusal(`no asset at "${relative}"`, true);
          if (isConfinementRefusal(error)) {
            throw new FleetAssetRefusal(
              `asset "${relative}" passes through a link or leaves the asset tree, which the asset editor never follows`,
            );
          }
          throw new FleetAssetRefusal(`asset "${relative}" could not be opened safely: ${reasonOf(error)}`);
        }

        try {
          if (target.metadata.type !== 'file') {
            throw new FleetAssetRefusal(`asset "${relative}" is not a regular file`);
          }
          const bytes = await target.read(MAX_ASSET_FILE_BYTES + 1);
          if (bytes === undefined || bytes.length > MAX_ASSET_FILE_BYTES) {
            throw new FleetAssetRefusal(
              `asset "${relative}" is larger than the ${MAX_ASSET_FILE_BYTES}-byte editing limit`,
            );
          }
          const content = decodeText(bytes);
          if (content === undefined) throw new FleetAssetRefusal(`asset "${relative}" is not valid text`);
          if (!isEditableText(content)) throw new FleetAssetRefusal(`asset "${relative}" is not editable text`);
          return { path: safe, content, bytes: bytes.length };
        } finally {
          await target.close();
        }
      },
      () => {
        throw new FleetAssetRefusal(`no asset at "${relative}"`, true);
      },
    );
  }

  /**
   * The absolute path a proposal's asset edit will be written to.
   *
   * The write itself happens through the provisioner, which does its own containment against the
   * roots the composition root declared — so this proves the *name* is one the asset tree may hold
   * and that nothing already on the path is a link, and leaves the write's own boundary to it.
   */
  async resolve(relative: string): Promise<string> {
    const safe = parseAssetPath(relative);
    const directory = this.options.assetsDirectory;
    const separator = directory.endsWith('/') ? '' : '/';
    await this.pinned(
      async root => {
        const parent = safe.includes('/') ? safe.slice(0, safe.lastIndexOf('/')) : '';
        try {
          const target = await root.open(this.within(parent), { wantDirectory: true });
          await target.close();
        } catch (error) {
          // A parent that does not exist yet is ordinary: the write creates it. Anything else means
          // the path leaves the tree or passes through a link, and that is refused.
          if (isMissing(error)) return;
          throw new FleetAssetRefusal(`asset path "${relative}" passes through a link or leaves the asset tree`);
        }
      },
      () => undefined,
    );
    return `${directory}${separator}${safe}`;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
