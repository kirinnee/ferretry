/**
 * The one durability contract every transfer artifact is published under.
 *
 * WHY THIS EXISTS. The fork stamps its receipt `imported` the moment `importPlan` resolves, and that
 * receipt is durable. So a durable `imported` may only be reachable once every artifact the import
 * claims — the deterministic first-turn brief, and each plan-pinned attachment original plus its
 * verbatim manifest — will still be there after power is cut. `writeFile` + `rename` does not
 * establish that: the bytes and the new directory entry can both be sitting in the page cache when
 * the machine stops, leaving a receipt that says `imported` in front of a target with no brief. The
 * replay then skips import on the receipt phase and refuses the target instead of repairing it.
 *
 * WHAT DURABLE MEANS HERE, in the order the calls have to happen:
 *
 *   1. ensure the tree, then persist every lazily created directory ENTRY parent-first, from an
 *      ancestor whose own entry is already durable down to the artifact directory's parent;
 *   2. create the temporary EXCLUSIVELY, write every byte, `fsync` the file, close it;
 *   3. `rename` it over the final path — the atomic publication;
 *   4. `fsync` the artifact directory, so the published NAME survives as well as its bytes;
 *   5. CONFIRM the name still resolves to the inode step 2 flushed. Steps 1–4 alone let a concurrent
 *      rename leave the caller holding a durability claim about an inode nothing here ever synced —
 *      identical bytes included, because "the same bytes" is not "the same inode, flushed".
 *
 * A directory entry is persisted by flushing the directory that CONTAINS it, never the directory
 * itself, which is why step 1 walks parents and step 4 flushes the artifact directory rather than
 * its parent.
 *
 * THE CONCURRENT CREATOR IS THE SUBTLE CASE. `mkdir(..., { recursive: true })` reports only what
 * THIS call created, so an attempt that observed a directory another attempt had just made would
 * skip the very parent flush its own successful return depends on — and the other attempt may crash
 * before flushing anything. The chain is therefore persisted unconditionally from the declared
 * durable ancestor, not derived from what this call happened to create. Flushing a directory that
 * was already durable costs one syscall; skipping one that was not costs the artifact.
 *
 * REPLAY DURABILITY IS NOT FREE EITHER, AND IT IS INODE-EXACT — PROVE, FLUSH, CONFIRM. An idempotent
 * replay that finds byte-identical artifacts has proved only that they are VISIBLE, which is exactly
 * what a page cache provides before a power loss. So {@link TransferArtifactDurability.prove} reads
 * and flushes through ONE read-only handle — proving bytes by path and then re-opening that path to
 * flush would leave a window in which a concurrent writer's rename makes the flushed inode a different
 * file from the proved one — and {@link TransferArtifactDurability.proveDurable} then persists the
 * names and CONFIRMS that each final path still resolves to the inode identity it proved. A caller
 * that cannot get that far publishes its own frozen bytes instead of vouching for a name whose
 * contents it never read.
 *
 * TEMPORARY OWNERSHIP IS TRACKED, NOT ASSUMED. `open(..., 'wx')` means a colliding temporary name
 * belongs to another writer: its bytes are never truncated, and cleanup only ever removes the
 * temporary THIS attempt created.
 */

import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * One already-published artifact and what makes its bytes the plan's.
 *
 * The proof belongs to the CALLER: only it knows whether a manifest still carries every planned fact
 * or a brief is the document the frozen plan renders. This module owns durability, never meaning.
 */
interface ProvableArtifact {
  readonly file: string;
  readonly proves: (bytes: Buffer) => boolean;
}

/**
 * How many times a replay will re-prove after a concurrent rename substituted a name under it.
 *
 * One substitution is a race worth re-reading; a second means the caller should stop chasing another
 * writer and publish its own frozen bytes, which it can always do.
 */
const SUBSTITUTION_ATTEMPTS = 2;

/**
 * The flushes durability is built from.
 *
 * They are the same syscall on a real filesystem and two seams here because a test can only prove the
 * ORDER of a publication if it can tell a directory flush from the flush of the file being published.
 * A test WRAPS them; a recorder that stood in for them and never flushed would make every durability
 * claim above vacuous.
 */
export interface DurableArtifactIo {
  /** Persists the names of the entries this directory contains. */
  readonly syncDirectory: (path: string) => Promise<void>;
  /**
   * Persists a file THROUGH THE OPEN HANDLE the caller holds — the temporary about to be published,
   * or an existing artifact a replay has just proved from that same handle.
   *
   * The handle is the point: a flush by path could persist a DIFFERENT inode from the one whose bytes
   * were read or written. `path` is carried only so an observer can name what was flushed.
   */
  readonly syncOpenFile: (handle: FileHandle, path: string) => Promise<void>;
}

/**
 * Codes a filesystem answers a DIRECTORY flush with when it cannot do one at all.
 *
 * The repo-standard tolerance, matching `StateFileSystem` and the session effect ledger: refusing to
 * publish on such a filesystem would make the daemon unusable there rather than safer, and it cannot
 * repair a platform that has no directory flush. The honest consequence, said out loud, is that on
 * one of those filesystems an artifact's NAME degrades to page-cache visibility. Its BYTES do not:
 * a file flush is never tolerated, because a filesystem that cannot flush a file cannot support the
 * receipt's guarantee at all, and silently proceeding would be the failure the receipt then hides.
 */
const DIRECTORY_SYNC_UNSUPPORTED: ReadonlySet<string> = new Set(['EINVAL', 'ENOTSUP', 'EPERM']);

/**
 * Persists one path — a directory's entries, or a file's bytes.
 *
 * Opened READ-ONLY, which is all `fsync` needs and is what makes this safe to call on an artifact
 * another attempt published: it can flush what is there without being able to restamp it. A directory
 * cannot be opened any other way.
 */
export async function fsyncArtifactPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const realArtifactIo: DurableArtifactIo = {
  syncDirectory: fsyncArtifactPath,
  syncOpenFile: async handle => await handle.sync(),
};

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Which file on which device, so a proved inode can be told apart from whatever a name means later. */
function identityOf(info: { readonly dev: number; readonly ino: number }): string {
  return `${info.dev}:${info.ino}`;
}

/**
 * The directories that CONTAIN the entries on the path from a durable ancestor to `directory`,
 * oldest first.
 *
 * Parent-first is the whole ordering rule: a child's name is only reachable after its parent's name
 * is. The walk stops at `durableAncestor` — or at the filesystem root, so a caller that names an
 * ancestor which is not on this path widens the chain instead of walking forever.
 */
function entryOwners(directory: string, durableAncestor: string): readonly string[] {
  const owners: string[] = [];
  for (let current = dirname(directory); ; current = dirname(current)) {
    owners.push(current);
    if (current === durableAncestor || dirname(current) === current) break;
  }
  return owners.reverse();
}

/** Publishes transfer artifacts so a caller's successful return survives power loss. */
export class TransferArtifactDurability {
  constructor(
    private readonly uniqueId: () => string = randomUUID,
    private readonly io: DurableArtifactIo = realArtifactIo,
  ) {}

  /**
   * Ensures the artifact directory exists and persists every entry down to its parent.
   *
   * The artifact directory's OWN entries are flushed by {@link publish} after it publishes a name
   * into them, so nothing here flushes `directory` itself.
   */
  async ensureDirectory(directory: string, durableAncestor: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.persistChain(directory, durableAncestor);
  }

  /**
   * The whole replay guarantee for a set of already-published artifacts: PROVE, FLUSH, CONFIRM.
   *
   * Each artifact is proved and flushed through one read-only handle, then the names it hangs on are
   * persisted — the chain and the artifact directory — and only then is each final path compared back
   * to the inode identity that was proved. That last step is the one a page-cache argument cannot
   * cover: a concurrent writer's rename between the proof and this return would leave the name
   * pointing at bytes this call never read and never flushed, so vouching for it would be a lie the
   * receipt then makes durable.
   *
   * `false` means absent, mismatched, or substituted twice over — a caller's cue to publish its own
   * frozen bytes rather than keep chasing another writer.
   */
  async proveDurable(
    directory: string,
    durableAncestor: string,
    artifacts: readonly ProvableArtifact[],
  ): Promise<boolean> {
    for (let attempt = 0; attempt < SUBSTITUTION_ATTEMPTS; attempt += 1) {
      const identities: string[] = [];
      for (const artifact of artifacts) {
        const identity = await this.prove(artifact.file, artifact.proves);
        if (identity === undefined) return false;
        identities.push(identity);
      }
      await this.persistDirectory(directory, durableAncestor);
      if (await this.namesHold(artifacts, identities)) return true;
    }
    return false;
  }

  /**
   * Read-only proof of a set of artifacts: nothing is flushed, and no name is confirmed.
   *
   * For the caller that may only REFUSE drift. It has nothing to confirm because it is not vouching
   * for durability — it is deciding whether what is there right now matches the plan.
   */
  async proveVisible(artifacts: readonly ProvableArtifact[]): Promise<boolean> {
    for (const artifact of artifacts) {
      if ((await this.prove(artifact.file, artifact.proves, false)) === undefined) return false;
    }
    return true;
  }

  /**
   * Writes complete bytes to a private exclusive temporary, flushes and closes them, atomically
   * publishes the file, flushes the artifact directory — and CONFIRMS the published name still resolves
   * to the inode it flushed.
   *
   * Answers the IDENTITY of the inode it published, or `undefined` when that confirmation failed: a
   * concurrent writer renamed something else over the name while this call was publishing. Its bytes
   * may even be identical, but nothing here flushed THEM, so returning success would hand the caller a
   * durability claim about an inode this process never wrote and never synced.
   *
   * The identity is answered rather than a bare boolean because this confirmation only speaks for the
   * moment it ran. {@link materialize} re-checks the whole set against these identities before it
   * returns, and owns what to do when one of them stopped holding.
   *
   * Call {@link ensureDirectory} first: this deliberately does not create the tree, so the parent
   * flushes cannot end up interleaved between a rename and the flush that publishes its name.
   */
  async publish(directory: string, file: string, bytes: string | Uint8Array): Promise<string | undefined> {
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    // `wx` fails instead of truncating: a colliding temporary belongs to another writer.
    const handle = await open(temporary, 'wx', 0o600);
    let owned = true;
    try {
      // The inode this call exclusively created. Neither the flush nor the rename changes it, so it is
      // what the published name must still mean at the end — the one file whose bytes were synced here.
      const published = identityOf(await handle.stat());
      try {
        if (typeof bytes === 'string') await handle.writeFile(bytes, 'utf8');
        else await handle.writeFile(bytes);
        await this.io.syncOpenFile(handle, temporary);
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      // Published: the name we own is the final one, and there is no temporary left to clean up.
      owned = false;
      await this.syncDirectory(directory);
      return (await this.identityOfName(file)) === published ? published : undefined;
    } finally {
      // Only ever the temporary this attempt created — never a colliding writer's.
      if (owned) await unlink(temporary).catch(() => undefined);
    }
  }

  /**
   * Publishes a whole artifact set and leaves every name durably resolving to a flushed inode, or
   * throws.
   *
   * The loop is the answer to one race: a concurrent writer renaming over a name between this call's
   * `rename` and its return. When that happens the published bytes may be identical, but nothing here
   * flushed the inode the name now points at — so the set is re-proved through
   * {@link proveDurable}, which flushes whatever is there on its own handle and confirms the names.
   * Only if that also loses the race is the whole sequence retried, and after
   * {@link SUBSTITUTION_ATTEMPTS} the call FAILS rather than returning a guarantee it could not
   * establish. Failing here leaves an import retryable; returning would let a receipt advance in front
   * of bytes nobody synced.
   *
   * THE SET IS CONFIRMED AS A SET, and for more than one artifact that is not the same thing as each
   * publication confirming itself. An attachment publishes `original` and then `manifest.json`: the
   * original's confirmation speaks only for the instant it ran, and the manifest's whole publication is
   * a window in which the original's name can be renamed onto an inode nothing here flushed. So after
   * every artifact is published, every name is checked once more against the identity published for it —
   * one `stat` each, no re-read, because those inodes were already flushed.
   */
  async materialize(
    directory: string,
    durableAncestor: string,
    artifacts: readonly (ProvableArtifact & { readonly bytes: string | Uint8Array })[],
  ): Promise<void> {
    for (let attempt = 0; attempt < SUBSTITUTION_ATTEMPTS; attempt += 1) {
      await this.ensureDirectory(directory, durableAncestor);
      const published: string[] = [];
      for (const artifact of artifacts) {
        const identity = await this.publish(directory, artifact.file, artifact.bytes);
        if (identity === undefined) break;
        published.push(identity);
      }
      if (published.length === artifacts.length && (await this.namesHold(artifacts, published))) return;
      if (await this.proveDurable(directory, durableAncestor, artifacts)) return;
    }
    throw new Error(
      `the artifacts under ${directory} were renamed over by another writer while this attempt was ` +
        'publishing them, and neither publication nor re-proof could be confirmed; nothing may be ' +
        'recorded as imported on bytes this attempt did not make durable',
    );
  }

  /**
   * Reads one already-published artifact, hands its bytes to `proves`, and — when the proof holds and
   * `persist` is set — flushes THE SAME HANDLE those bytes were read from.
   *
   * Answers the IDENTITY of the inode it proved (and flushed), or `undefined` for "not there, or not
   * what the plan says". Proof, flush and identity all come from one handle, so a caller can later ask
   * whether the NAME still resolves to the file it actually vouched for.
   */
  async prove(file: string, proves: (bytes: Buffer) => boolean, persist = true): Promise<string | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      if (!proves(await handle.readFile())) return undefined;
      if (persist) await this.io.syncOpenFile(handle, file);
      return identityOf(await handle.stat());
    } finally {
      await handle.close();
    }
  }

  /** The names a replay depends on: the chain, then the artifact directory that holds the artifacts. */
  private async persistDirectory(directory: string, durableAncestor: string): Promise<void> {
    await this.persistChain(directory, durableAncestor);
    await this.syncDirectory(directory);
  }

  /** Whether every final path still resolves to the exact inode that was proved and flushed. */
  private async namesHold(artifacts: readonly ProvableArtifact[], identities: readonly string[]): Promise<boolean> {
    for (const [index, artifact] of artifacts.entries()) {
      if ((await this.identityOfName(artifact.file)) !== identities[index]) return false;
    }
    return true;
  }

  private async identityOfName(file: string): Promise<string | undefined> {
    try {
      return identityOf(await stat(file));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** Every directory flush, with the one tolerance a platform can force on us. */
  private async syncDirectory(path: string): Promise<void> {
    try {
      await this.io.syncDirectory(path);
    } catch (error) {
      if (!DIRECTORY_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }

  private async persistChain(directory: string, durableAncestor: string): Promise<void> {
    for (const owner of entryOwners(directory, durableAncestor)) await this.syncDirectory(owner);
  }
}
