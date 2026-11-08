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

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
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
import { assertOwnSession, assertSessionsRoot, OwnFolder } from '../sessions-root.ts';

/** The directory each session's effect records live in, beneath the session's own directory. */
const EFFECTS_DIRECTORY = 'effects';

/** What this ledger asks of the kernel's root. */
export type LedgerRoot = Pick<
  RootHandle,
  'name' | 'internal' | 'ensurePrivateDirectory' | 'resolve' | 'publish' | 'readDurable' | 'syncDirectory'
>;

export class FileSessionEffectLedger implements SessionEffectLedger {
  private readonly folder: OwnFolder;

  constructor(
    /** The kernel's root the records live in: every step of a write is its durable publish. */
    private readonly root: LedgerRoot,
    /** The one session this ledger is for: its root is that session's own folder, so every path is beneath it. */
    private readonly ferret: SessionId,
  ) {
    assertSessionsRoot(root, 'the session effect ledger');
    this.folder = new OwnFolder(root);
  }

  async inspect(key: SessionEffectKey, fingerprint: string): Promise<SessionEffectStanding> {
    const held = await this.held(key);
    return held === undefined ? 'unclaimed' : sessionEffectStanding(held, fingerprint);
  }

  async begin(key: SessionEffectKey, fingerprint: string, at: string): Promise<SessionEffectAdmission> {
    await this.folder.ensure();
    // The kernel's exclusive publish IS the compare-and-set: ancestors synced parent first, a synced temp file,
    // `link(2)` (EEXIST means somebody else holds the key), the folder synced last, the temp name released.
    const published = await this.root.publish(this.file(key), recordBytes(beginSessionEffect(key, fingerprint, at)), {
      exclusive: true,
      mode: 0o600,
    });
    if (published.outcome === 'published') return 'perform';
    // Lost the compare-and-set. Whatever holds the key decides this attempt, and a record that
    // vanished between the race and the read is a damaged ledger rather than a free key: it is
    // refused, because the one thing that must never follow a lost race is `perform`.
    const held = await this.held(key);
    if (held === undefined)
      throw new SessionEffectLedgerError(key, 'held the key during a race and then vanished from the ledger');
    return sessionEffectStanding(held, fingerprint);
  }

  async settle(key: SessionEffectKey, fingerprint: string, at: string): Promise<void> {
    await this.folder.ensure();
    const held = await this.held(key);
    if (held === undefined)
      throw new SessionEffectLedgerError(key, 'was never begun, so there is nothing that could have finished');
    if (held.fingerprint !== fingerprint)
      throw new SessionEffectLedgerError(key, 'is held for a different act than the one being settled');
    // Already settled under this fingerprint: the boundary is durable, so a replay of the settle is
    // the same fact arriving twice and the record is left exactly as the first attempt wrote it.
    if (held.phase === 'settled') return;
    // Replaces the record by rename, the folder synced after; the temp name is released on a failure and never
    // after the rename (the name is free again and another attempt may own it).
    await this.root.publish(this.file(key), recordBytes(settleSessionEffect(held, at)), { mode: 0o600 });
  }

  /** Where one effect's record lives. Public so a caller can name it in a report. */
  file(key: SessionEffectKey): FencedPath {
    assertOwnSession(this.ferret, key.sessionId, 'the session effect ledger');
    const resolved = this.root.resolve(join(EFFECTS_DIRECTORY, `${effectFileName(key.effectId)}.json`));
    if (!resolved.ok) throw new SessionEffectLedgerError(key, `has a record outside its root (${resolved.error})`);
    return resolved.value;
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
   * ONE descriptor for both the read and the sync (`readDurable`): reading by path and then opening by path again are
   * two lookups of a name a concurrent `settle` republishes by rename, so the fsync could persist a record this call
   * is not deciding from. It re-syncs a record that is already durable, which costs an fsync of a clean file and a
   * clean directory; nothing on disk says which of the two it is.
   */
  private async held(key: SessionEffectKey): Promise<SessionEffectRecord | undefined> {
    await this.folder.ensure();
    const file = this.file(key);
    const read = await this.root.readDurable(file);
    if (read === undefined) return undefined;
    // The record's own entry, and the entry naming the directory it lives in.
    await this.root.syncDirectory(dirname(file) as FencedPath, { parent: true });
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch (error) {
      throw new SessionEffectLedgerError(key, `has a record that is not readable JSON: ${message(error)}`);
    }
    return parseSessionEffectRecord(document, key);
  }
}

const recordBytes = (record: SessionEffectRecord): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(record)}\n`);

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
