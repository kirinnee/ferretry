/**
 * The effect ledger on disk: one file per act, admitted by a real compare-and-set.
 *
 * THE ADMISSION IS `link`, NOT "read then write". Two attempts that both found no record must not
 * both be told to type into the same pane, and a read followed by a write leaves exactly that window
 * open. `link(2)` fails with `EEXIST` when the destination already exists, atomically and in the
 * kernel, so precisely one attempt per key can ever create the record — the loser reads whatever won
 * and is answered from it. It is the same primitive the fork receipt store claims a pair with, for
 * the same reason.
 *
 * DURABILITY IS THE POINT, so every step is synced. A record that reached the page cache and not the
 * platter is a record a power loss turns back into "never attempted", which is precisely the answer
 * that makes a retry type into a live agent a second time. The temp file's contents are synced
 * before it is linked, and the CONTAINING DIRECTORY is synced after: on a crash, an fsync'd file
 * whose directory entry was never persisted is a file that does not exist.
 *
 * AND THAT RULE APPLIES TO THE DIRECTORIES THEMSELVES, which is the part it is easy to stop one
 * level short of. An entry lives in its PARENT, so syncing `<session>/effects` persists the record
 * inside it and says nothing about `effects`' own name in `<session>`. Nothing in POSIX extends a
 * directory fsync to ancestors; on ext4 with `data=ordered` the earlier `mkdir` usually rides along
 * in the same journal transaction, but that is an implementation artefact rather than a contract,
 * and the one place this ledger must not rest on "usually" is the question it exists to answer. So
 * every attempt syncs the record directory's own parent, and any higher ancestor this `mkdir` had to
 * create, PARENT FIRST and before the record is written — a child's own fsync is only well defined
 * once its entry is durable.
 *
 * EVERY ATTEMPT, NOT ONLY THE ONE THAT CREATED THE DIRECTORY. Creating a directory is not atomic
 * with persisting its name, so a second attempt can see `mkdir` create nothing, skip the parent, win
 * the record link and return `perform` while the first attempt has still not persisted the entry
 * they are both writing into. It removes a guarantee that would otherwise depend on which attempt
 * happened to get there first.
 *
 * NOTE THAT ALL OF THIS IS ABOUT POWER LOSS, not about this program exiting. A write that reached
 * the page cache survives a process dying, so a lost response, a restart mid-drive and a retry
 * seconds later are all already safe without any of it. Syncing is what makes the ledger true across
 * a host that lost power in the middle of a keystroke sequence.
 *
 * NO PARTIAL DOCUMENT IS EVER VISIBLE. Nothing is written at the record's own path — the complete
 * bytes are assembled under a unique temporary name and moved into place in one operation, so a
 * reader either sees no file or sees a whole one. A torn document would be read as a damaged record
 * and refused, which is safe but needlessly turns a crash into an unrecoverable effect.
 *
 * THE FILENAME IS A HASH OF THE EFFECT ID, and the id itself is stored INSIDE the document. Effect
 * ids come from callers — a request id off the wire, a plan-derived string — so using one as a path
 * component would let `../../` reach out of the session it names. Hashing removes the question
 * entirely: every filename is hex of a fixed length whatever was asked for. The id is then re-proved
 * from the document on the way back, so the hash is a naming device and never the identity.
 */

import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  beginSessionEffect,
  parseSessionEffectRecord,
  type SessionEffectAdmission,
  type SessionEffectKey,
  type SessionEffectLedger,
  SessionEffectLedgerError,
  type SessionEffectRecord,
  type SessionEffectStanding,
  sessionEffectStanding,
  settleSessionEffect,
} from '../../../lib/session/effects/index.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/** The directory each session's effect records live in, beneath the session's own directory. */
const EFFECTS_DIRECTORY = 'effects';

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

/**
 * Whether an error means this platform cannot sync a directory at all.
 *
 * Exactly the three the state filesystem tolerates, and no more — a directory sync that failed for
 * any other reason has not happened, and the durability this file promises would be a lie.
 */
function unsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM';
}

/**
 * Persisting one directory's own entries.
 *
 * Exported because it is the seam's default, and a test that wants to observe the ORDER directories
 * are synced in wraps it rather than replaces it — a recorder that stood in for the real thing would
 * leave every other case fsyncing nothing while still passing.
 *
 * THE REPO-STANDARD TOLERANCE, matching `StateFileSystem`: some filesystems cannot sync a directory
 * at all, and failing the fork there would make the daemon unusable rather than safer. The honest
 * consequence is that on such a platform this ledger's guarantee degrades to page-cache visibility —
 * a property of the platform, which refusing cannot repair. The FILE fsync stays strict.
 */
export async function fsyncEffectDirectory(
  path: string,
  /**
   * Opens the directory to be synced.
   *
   * A parameter rather than a constructor port, and defaulted to the real call, because the ONLY
   * thing a test needs to vary is which errno the open produces — and that cannot be produced from
   * outside on a filesystem that supports directory opens. Nothing else about the helper varies.
   */
  openDirectory: (path: string) => Promise<FileHandle> = path => open(path, 'r'),
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openDirectory(path);
  } catch (error) {
    // TOLERATED AT THE OPEN TOO, which is where a filesystem that cannot sync directories usually
    // says so: it refuses the read-only open of a directory rather than failing the fsync behind it.
    // Tolerating only the sync left the promise this helper's contract makes untrue on exactly the
    // platforms it was written for.
    if (!unsupportedDirectorySync(error)) throw error;
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * The directories whose entries must be persisted before a record is written beneath `leaf`.
 *
 * ALWAYS AT LEAST `dirname(leaf)`, EVEN WHEN THIS CALL CREATED NOTHING, and that is not belt and
 * braces — it is the whole correctness of the thing under concurrency. "Only sync what I created" is
 * a rule about one attempt in isolation, and creating a directory is not atomic with persisting its
 * name. Attempt A creates `<session>/effects` and is descheduled before it syncs `<session>`;
 * attempt B arrives, sees a `mkdir` that created nothing, skips the parent, wins the record link,
 * syncs only the leaf and returns `perform` — with its record durable inside a directory whose own
 * name is not. A power loss there takes `effects` and every record in it, and the act B was admitted
 * to perform runs a second time. So a caller must persist the leaf's own entry on its own behalf
 * rather than inheriting a promise from whoever happened to create it.
 *
 * `firstCreated` is the topmost path the recursive `mkdir` created, or `undefined` when it created
 * nothing. Anything it did create is a contiguous chain down to `leaf`, and each link's entry lives
 * in the link above — so the answer is every directory from `dirname(firstCreated)` down to
 * `dirname(leaf)`, oldest ancestor first, which for the created-nothing case is exactly
 * `[dirname(leaf)]`.
 *
 * The steady-state cost is therefore one fsync of a directory nothing has dirtied, which the kernel
 * settles without IO — a small, constant price for a guarantee that does not depend on who raced.
 */
function parentEntriesToPersist(firstCreated: string | undefined, leaf: string): readonly string[] {
  const top = firstCreated === undefined ? dirname(leaf) : dirname(firstCreated);
  const parents: string[] = [];
  for (let directory = dirname(leaf); ; directory = dirname(directory)) {
    parents.push(directory);
    // The root is its own parent, so this also terminates a chain that never reaches `top` — which
    // would mean the mkdir reported a path outside the one it was asked for.
    if (directory === top || dirname(directory) === directory) break;
  }
  return parents.reverse();
}

export class FileSessionEffectLedger implements SessionEffectLedger {
  constructor(
    /** Where one session's own private directory is. Every path this writes is beneath it. */
    private readonly sessionDirectory: (sessionId: SessionId) => string,
    /** Names the temporary file each write is assembled under; injectable so a test is determinate. */
    private readonly uniqueId: () => string = randomUUID,
    /**
     * Persists one directory's entries.
     *
     * A seam solely so the ORDER can be proved: "the parent is synced, and before the leaf" is a
     * claim about invisible IO, and a claim about invisible IO rots silently. Nothing else varies it.
     */
    private readonly syncDirectory: (path: string) => Promise<void> = fsyncEffectDirectory,
    /**
     * Persists one OPEN file, before anything is allowed to point at it.
     *
     * A seam for exactly one reason: the post-write, pre-publication crash boundary is the moment
     * this ledger's whole claim rests on, and it cannot be reached from the outside — no directory
     * permission or path shape makes an fsync fail after an exclusive create has already succeeded.
     * Narrower than a write port on purpose: it varies WHEN the durability step fails and nothing
     * about what is written.
     */
    private readonly syncOpenFile: (handle: FileHandle) => Promise<void> = async handle => {
      await handle.sync();
    },
  ) {}

  async inspect(key: SessionEffectKey, fingerprint: string): Promise<SessionEffectStanding> {
    const held = await this.held(key);
    return held === undefined ? 'unclaimed' : sessionEffectStanding(held, fingerprint);
  }

  async begin(key: SessionEffectKey, fingerprint: string, at: string): Promise<SessionEffectAdmission> {
    const file = this.file(key);
    const leaf = dirname(file);
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    // Parent first, and before anything is written: each directory's own entry lives one level up,
    // and a leaf synced before its own name is durable persists a record into a directory that a
    // power loss can leave nameless — which reads back as "never attempted". Every attempt does this
    // for itself, whether or not it was the one that created anything; see the walk for the race
    // that makes "only sync what I created" unsound.
    for (const parent of parentEntriesToPersist(await mkdir(leaf, { recursive: true, mode: 0o700 }), leaf))
      await this.syncDirectory(parent);
    // OUTSIDE the cleanup below: `wx` fails when the name is taken, and a name this call did not
    // create belongs to another attempt — unlinking it on the way out would delete a stranger's
    // in-flight record. Losing the exclusive create means this call owns nothing to clean up.
    await this.writeSynced(temporary, beginSessionEffect(key, fingerprint, at));
    try {
      try {
        await link(temporary, file);
      } catch (error) {
        if (!isErrnoCode(error, 'EEXIST')) throw error;
        // Lost the compare-and-set. Whatever holds the key decides this attempt, and a record that
        // vanished between the race and the read is a damaged ledger rather than a free key: it is
        // refused, because the one thing that must never follow a lost race is `perform`.
        const held = await this.held(key);
        if (held === undefined)
          throw new SessionEffectLedgerError(key, 'held the key during a race and then vanished from the ledger');
        return sessionEffectStanding(held, fingerprint);
      }
      // Won it. The record's own entry is only durable once the directory holding it is synced —
      // the last of the chain, and the one every parent above was persisted in order to reach.
      await this.syncDirectory(leaf);
      return 'perform';
    } finally {
      // UNCONDITIONAL here, unlike `settle`, and the difference is `link` against `rename`: a link
      // adds a second name for the same inode and leaves the temporary exactly where it was, so this
      // call still owns that name on every path out — won, lost or thrown.
      await unlink(temporary).catch(() => undefined);
    }
  }

  async settle(key: SessionEffectKey, fingerprint: string, at: string): Promise<void> {
    const held = await this.held(key);
    if (held === undefined)
      throw new SessionEffectLedgerError(key, 'was never begun, so there is nothing that could have finished');
    if (held.fingerprint !== fingerprint)
      throw new SessionEffectLedgerError(key, 'is held for a different act than the one being settled');
    // Already settled under this fingerprint: the boundary is durable, so a replay of the settle is
    // the same fact arriving twice and the record is left exactly as the first attempt wrote it.
    if (held.phase === 'settled') return;

    const file = this.file(key);
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    // Created before the cleanup is armed, for the reason `begin` states.
    await this.writeSynced(temporary, settleSessionEffect(held, at));
    // Ownership of the temporary NAME ends at the rename: the name is free from that moment, and the
    // directory sync below is an await during which another attempt can create its own temporary
    // under the same reused name. Unlinking after that would delete a stranger's in-flight record.
    let owns = true;
    try {
      await rename(temporary, file);
      owns = false;
      await this.syncDirectory(dirname(file));
    } finally {
      if (owns) await unlink(temporary).catch(() => undefined);
    }
  }

  /** Where one effect's record lives. Public so a caller can name it in a report. */
  file(key: SessionEffectKey): string {
    return join(this.sessionDirectory(key.sessionId), EFFECTS_DIRECTORY, `${effectFileName(key.effectId)}.json`);
  }

  /**
   * The stored record, PROVED DURABLE, or `undefined` only when it never existed.
   *
   * READING IS NOT ENOUGH, and this is the window that makes it so. A record reaches the page cache
   * at the `link` or the `rename`, and is only durable once the directory holding it has been synced.
   * A process that died in between leaves a record every later reader can SEE — so a restarted
   * `inspect` answers `unsettled`, a `begin` loser adopts it, a `settle` calls itself already done — while a
   * power cut can still erase it and let the act it admitted run a second time. Every one of those
   * answers is a decision about touching a live pane, so the record they rest on is made durable
   * here, before it is allowed to decide anything.
   *
   * It re-syncs a record that is already durable, which costs an fsync of a clean file and a clean
   * directory. That is the right trade: the alternative is knowing which of the two it is, and
   * nothing on disk says.
   */
  private async held(key: SessionEffectKey): Promise<SessionEffectRecord | undefined> {
    const file = this.file(key);
    let text: string;
    // ONE handle for both the read and the sync, and that is not tidiness. Reading by path and then
    // opening by path again are two lookups of a name a concurrent `settle` republishes by rename: the
    // read can take the begun inode while the second open takes the settled one, so the fsync would
    // make a record durable that this call is not deciding from, and the bytes it IS deciding from
    // would never have been persisted at all. Holding the inode across both closes that entirely.
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      text = await handle.readFile('utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The record's own entry, and the entry naming the directory it lives in.
    for (const parent of parentEntriesToPersist(undefined, dirname(file))) await this.syncDirectory(parent);
    await this.syncDirectory(dirname(file));
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new SessionEffectLedgerError(key, `has a record that is not readable JSON: ${message(error)}`);
    }
    return parseSessionEffectRecord(document, key);
  }

  /** Whole bytes, on the platter, before anything can point at them. */
  private async writeSynced(path: string, record: SessionEffectRecord): Promise<void> {
    // The exclusive create is what establishes ownership, so it is also what obliges this call to
    // clean up. A failure AFTER it leaves a partial private file that no caller can safely remove on
    // its behalf — the callers arm their own cleanup only once this returns, precisely so they never
    // unlink a name another attempt owns — and under a deterministic unique id that leftover would
    // wedge every retry on `EEXIST` for a temporary nobody is writing.
    const handle = await open(path, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await this.syncOpenFile(handle);
      } finally {
        await handle.close();
      }
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * The filename one effect id is stored under.
 *
 * Exported so a test can prove confinement by NAME rather than by hoping a hostile id fails some
 * other way: a caller-minted id never becomes a path component, so no id can address a file outside
 * the session's own effects directory.
 */
export function effectFileName(effectId: string): string {
  return createHash('sha256').update(effectId).digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
