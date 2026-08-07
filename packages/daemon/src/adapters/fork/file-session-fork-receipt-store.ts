/**
 * A file-backed {@link SessionForkReceiptStore}: the one durable home of a fork receipt, keyed
 * daemon-globally by the plan-derived `(sourceSessionId, requestId)` identity, never under or
 * through the source session.
 *
 * THE CLAIM IS A REAL COMPARE-AND-SET, not a read-then-write. Two daemon-side attempts that both
 * found no receipt must not both mint a target, and a file store that read-then-wrote could not
 * promise that: a retry is milliseconds away, and a second `read` returning `undefined` between the
 * first's write and its return would mint a second reserved target. So `claim` writes the receipt to
 * a private temporary file and then `link`s it into place; `link` is an atomic create that fails with
 * `EEXIST` the instant a target name already exists, so exactly one attempt wins the pair and every
 * other is answered with the document that won. The loser ADOPTS the winner's target and plan rather
 * than creating a second session, and the orchestration decides whether the winner's payload matches.
 *
 * ATOMIC IS NOT YET DURABLE. Before a receipt name can be published, the exclusive private
 * temporary is written, synced, and closed. After `link` or `rename` publishes it, the containing
 * directory is synced before the operation returns. A recursive directory creation has the same
 * rule at every level: each new entry's parent is synced, parent first. Every claim also re-syncs
 * the receipt directory's parent before writing, even when `mkdir` reports that it created nothing;
 * otherwise a concurrent directory creator could pause before its sync while this claimant returns.
 * An `EEXIST` loser likewise syncs the receipt directory itself before adopting the winner, so it
 * cannot outrun a winner paused between `link` and its own directory sync.
 *
 * A TEMPORARY IS OWNED ONLY WHILE ITS NAME IS STILL THIS WRITER'S. A `rename` consumes the
 * temporary name, so ownership is dropped in the same step that the rename succeeds, before
 * anything else is awaited. Cleanup that ran after that point would unlink whatever answers to the
 * name now, and a later writer that generated the same name would lose its own private bytes. A
 * `link` is different: it publishes a second name for the same inode and leaves the temporary in
 * place, so the claim keeps ownership and removes it. Directory persistence is refused outright by
 * filesystems that implement no directory fsync, so exactly `EINVAL`, `ENOTSUP` and `EPERM` are
 * tolerated there. A file fsync stays strict: unpersisted bytes are a lost receipt, never a
 * missing platform feature.
 *
 * A PROCESS RESTART CAN SEE MORE THAN A POWER-LOSS RESTART. If a process dies after `rename` but
 * before the directory sync, its replacement can read the later phase from the kernel page cache
 * and skip work even though a later power loss could still roll that name back. Therefore every
 * existing receipt returned by `read` or adopted after `EEXIST` is repaired before return: its
 * bytes are parsed and fsynced through ONE read-only handle, and only then is the containing
 * directory synced. The handle is the proof. A name re-opened after the parse can resolve to a
 * different inode — a concurrent publisher's rename, or nothing at all — so a repair addressed by
 * name could answer with one file's document while persisting another's. An equal-phase `advance`
 * is decided and repaired on that same pinned handle, and it replaces no inode.
 *
 * THE ADVANCE IS MONOTONIC AND NEVER OVERWRITES A MISMATCH. A receipt comes off disk as untrusted
 * input, so `advance` re-parses the holder before it writes: a corrupt or unknown-version document is
 * refused, a document for a different decision (the full-decision `fingerprint` no longer matches) is
 * refused outright and the frozen receipt is left intact, and a phase that would move backwards is
 * refused. A replay of an advance that already landed finds the boundary already crossed and leaves
 * the receipt untouched rather than rewriting it. Forward progress is a private temporary plus an
 * atomic `rename`, so a crash leaves either the old receipt or the new one and never a torn file.
 *
 * SOURCE IMMUTABILITY HOLDS BY CONSTRUCTION: the only path this store ever opens for writing is the
 * daemon-global `state/forks/<planId>.json`, derived from the composite key. No source session
 * directory is named, so none can be touched — source decisions were derived once in preparation
 * and frozen into the receipt before this store is ever asked to claim it. Import's later
 * validation-only source re-read is outside this write-capable store.
 *
 * NOT CONCURRENCY-SAFE FOR ONE KEY BEYOND THE CLAIM. The claim is a genuine compare-and-set, but
 * `advance` is a read-verify-write that the orchestrator must serialize per key (the fork service's
 * `SessionForkSerial`, keyed on the composite, is the production pattern). Distinct keys address
 * distinct files, which is all a fan-out of forks needs.
 */

import { randomUUID } from 'node:crypto';
import { type FileHandle, link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SessionForkPhaseRegressionError, SessionForkReceiptInvalidError } from '../../lib/fork/failures.ts';
import type { SessionForkKey } from '../../lib/fork/identity.ts';
import { parseSessionForkReceipt, type SessionForkReceipt, sessionForkPhaseRank } from '../../lib/fork/receipt.ts';
import type { SessionForkReceiptStore } from '../../lib/fork/types.ts';
import { deriveTransferPlanId } from '../../lib/transfer/prepare.ts';

const RECEIPT_FILE_SUFFIX = '.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/** The refusals that mean "this filesystem has no directory fsync", and nothing wider. */
const TOLERATED_DIRECTORY_SYNC_CODES = ['EINVAL', 'ENOTSUP', 'EPERM'] as const;

/**
 * The mutation surface needed to make one receipt durable. It is deliberately narrower than a
 * general filesystem: tests can observe publication and sync ordering without replacing reads or
 * giving the adapter another way to write.
 */
export interface SessionForkReceiptFileOperations {
  /** Returns the first directory created, or `undefined` when the complete path already existed. */
  ensureDirectory(path: string, mode: number): Promise<string | undefined>;
  /** Exclusively creates, writes, fsyncs, and closes one private temporary before resolving. */
  writePrivateSynced(path: string, contents: string, mode: number): Promise<void>;
  /** Atomic create-if-absent: the real compare-and-set used by `claim`. */
  link(from: string, to: string): Promise<void>;
  /** Atomic same-directory replacement used by `advance`. */
  replace(from: string, to: string): Promise<void>;
  /**
   * Opens an existing receipt read-only exactly once and gives `use` that inode's bytes together
   * with the fsync of the very handle they came from, so a caller can prove the document it parsed
   * is the document it persisted. Resolves to `undefined` only when the name does not exist, and
   * always closes the handle before returning.
   */
  readPinned<T>(
    path: string,
    use: (text: string, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined>;
  /** Persists entries and metadata belonging to this directory. */
  syncDirectory(path: string): Promise<void>;
  /** Best-effort cleanup of a temporary owned by this writer. */
  discard(path: string): Promise<void>;
}

/**
 * Production receipt operations, kept explicit so the durability sequence is reviewable. The one
 * fsync primitive is injected so that a refusal — the same refusal a directory tolerates and a file
 * does not — can be exercised on this class rather than on a stand-in for it.
 */
export class NodeSessionForkReceiptFileOperations implements SessionForkReceiptFileOperations {
  constructor(private readonly fsync: (handle: { sync: () => Promise<void> }) => Promise<void> = syncHandle) {}

  async ensureDirectory(path: string, mode: number): Promise<string | undefined> {
    return await mkdir(path, { recursive: true, mode });
  }

  async writePrivateSynced(path: string, contents: string, mode: number): Promise<void> {
    let created = false;
    try {
      const handle = await open(path, 'wx', mode);
      created = true;
      try {
        await handle.writeFile(contents, 'utf8');
        await this.fsync(handle);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A generated-name collision belongs to another writer. Only remove a temporary after this
      // invocation's exclusive open proved that it created and therefore owns the path.
      if (created) await silentlyUnlink(path);
      throw error;
    }
  }

  async link(from: string, to: string): Promise<void> {
    await link(from, to);
  }

  async replace(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async readPinned<T>(
    path: string,
    use: (text: string, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    const handle = await openExistingForRead(path);
    if (handle === undefined) return undefined;
    try {
      const text = await handle.readFile('utf8');
      // The fsync closes over this handle, never over `path`: the caller decides from the bytes it
      // was handed whether to persist them, and it persists exactly the inode they came from.
      return await use(text, async () => await this.fsync(handle));
    } finally {
      await handle.close();
    }
  }

  async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, 'r');
      try {
        await this.fsync(handle);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Some filesystems offer no directory persistence at all and say so by refusing the open or
      // the fsync itself. That is a platform limit rather than a lost write, so exactly those
      // refusals are tolerated; every other failure is a real one and still stops the operation.
      if (!TOLERATED_DIRECTORY_SYNC_CODES.some(code => isErrnoCode(error, code))) throw error;
    }
  }

  async discard(path: string): Promise<void> {
    await silentlyUnlink(path);
  }
}

export class FileSessionForkReceiptStore implements SessionForkReceiptStore {
  constructor(
    private readonly receiptPathFor: (key: SessionForkKey) => string,
    private readonly uniqueId: () => string = randomUUID,
    private readonly files: SessionForkReceiptFileOperations = new NodeSessionForkReceiptFileOperations(),
  ) {}

  async read(key: SessionForkKey): Promise<unknown> {
    return this.readDurableDocument(this.receiptPathFor(key), key);
  }

  async claim(receipt: SessionForkReceipt): Promise<unknown> {
    const key = { sourceSessionId: receipt.sourceSessionId, requestId: receipt.requestId };
    const file = this.receiptPathFor(key);
    const directory = dirname(file);
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    let ownsTemporary = false;
    await this.prepareClaimDirectory(directory);
    try {
      await this.files.writePrivateSynced(temporary, canonicalJson(receipt), PRIVATE_FILE_MODE);
      ownsTemporary = true;

      let won = true;
      try {
        await this.files.link(temporary, file);
      } catch (error) {
        if (!isErrnoCode(error, 'EEXIST')) throw error;
        won = false;
      }

      if (won) {
        // The inode was synced under its private name; this makes the new receipt name durable.
        await this.files.syncDirectory(directory);
        return receipt;
      }

      // Lost the compare-and-set: another claim already holds this pair. Adopt its document unchanged
      // — the store does not decide whether the payloads match; the orchestration does. The durable
      // read also closes a window where the winner linked, then paused before its directory sync.
      const held = await this.readDurableDocument(file, key);
      if (held === undefined) {
        throw new SessionForkReceiptInvalidError(key, 'its file vanished between the claim race and the read');
      }
      return held;
    } finally {
      if (ownsTemporary) await this.files.discard(temporary).catch(() => undefined);
    }
  }

  async advance(next: SessionForkReceipt): Promise<void> {
    const key = { sourceSessionId: next.sourceSessionId, requestId: next.requestId };
    const file = this.receiptPathFor(key);

    // One pinned handle decides the whole comparison. The phase this advance is judged against and
    // the inode an already-landed replay repairs are then provably the same file, never a name
    // re-resolved after a concurrent publisher moved something else into it.
    const replayed = await this.files.readPinned(file, async (text, syncPinned) => {
      const current = parseSessionForkReceipt(parseJsonDocument(text, key), key);

      // The durable decision — key, caller payload, explicit target and complete parsed plan — is
      // frozen at the claim and summarized by the receipt `fingerprint`. An advance for a different
      // decision is refused outright and the frozen receipt is left intact, never overwritten.
      if (current.fingerprint !== next.fingerprint) {
        throw new SessionForkReceiptInvalidError(
          key,
          'the receipt being advanced is a different decision than the one this pair froze',
        );
      }

      const nextRank = sessionForkPhaseRank(next.phase);
      const currentRank = sessionForkPhaseRank(current.phase);
      if (nextRank < currentRank) throw new SessionForkPhaseRegressionError(current.phase, next.phase);
      if (nextRank > currentRank) return false;

      // A replay of an advance that already landed does not rewrite it — the inode is left exactly
      // as it is — but it does repair durability: a prior process may have renamed this exact phase
      // and died before syncing the directory.
      await syncPinned();
      return true;
    });

    if (replayed === undefined) {
      throw new SessionForkReceiptInvalidError(key, 'no durable receipt holds this pair, so it cannot be advanced');
    }
    if (replayed) {
      await this.files.syncDirectory(dirname(file));
      return;
    }

    await this.writeAtomic(file, canonicalJson(next));
  }

  /**
   * Returns an existing document only after the inode it was parsed from is durable and the name
   * pointing at that inode is durable too — file first, directory second, and both established
   * through the single handle the bytes came from.
   */
  private async readDurableDocument(file: string, key: SessionForkKey): Promise<unknown> {
    const held = await this.files.readPinned(file, async (text, syncPinned) => {
      const document = parseJsonDocument(text, key);
      await syncPinned();
      return { document };
    });
    if (held === undefined) return undefined;
    await this.files.syncDirectory(dirname(file));
    return held.document;
  }

  /** Power-loss-safe overwrite: synced private bytes, atomic rename, then containing-directory sync. */
  private async writeAtomic(file: string, text: string): Promise<void> {
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    let ownsTemporary = false;
    try {
      await this.files.writePrivateSynced(temporary, text, PRIVATE_FILE_MODE);
      ownsTemporary = true;
      await this.files.replace(temporary, file);
      // The rename consumed the name, so this writer no longer owns it — recorded before the next
      // await, because a cleanup that ran afterwards would unlink whoever holds the name by then.
      ownsTemporary = false;
      await this.files.syncDirectory(dirname(file));
    } finally {
      if (ownsTemporary) await this.files.discard(temporary).catch(() => undefined);
    }
  }

  /**
   * Makes the receipt directory usable after a recursive create. Each directory `mkdir` created has
   * an entry in its own parent, and syncing a child persists none of those ancestor entries. The
   * immediate parent is always synced even on the existing-directory path: another claimant may
   * have created the leaf and still be paused before doing that sync itself.
   */
  private async prepareClaimDirectory(directory: string): Promise<void> {
    const firstCreated = await this.files.ensureDirectory(directory, PRIVATE_DIRECTORY_MODE);
    const firstParent = firstCreated === undefined ? dirname(directory) : dirname(firstCreated);
    for (const parent of parentFirstChain(firstParent, dirname(directory))) {
      await this.files.syncDirectory(parent);
    }
  }
}

/**
 * The daemon-global plan-id location: one receipt file per `(sourceSessionId, requestId)`, never under
 * a session directory. The plan id is the single owner of the composite identity, so the path is
 * derived from it rather than invented here.
 */
export function forkReceiptFile(stateDirectory: string, key: SessionForkKey): string {
  return join(
    stateDirectory,
    'forks',
    `${deriveTransferPlanId(key.sourceSessionId, key.requestId)}${RECEIPT_FILE_SUFFIX}`,
  );
}

/** Stable JSON: object keys sorted recursively, so one receipt has exactly one on-disk spelling. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

/** Parses receipt bytes: a torn file is refused outright, never answered as if unclaimed. */
function parseJsonDocument(text: string, key: SessionForkKey): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SessionForkReceiptInvalidError(key, 'its file is not valid JSON, so the durable anchor is unreadable');
  }
}

/** Opens a name read-only, or answers `undefined` for the one absence that is not a failure. */
async function openExistingForRead(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, 'r');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** The real fsync, named so the one place it is issued from can be substituted in a test. */
async function syncHandle(handle: { sync: () => Promise<void> }): Promise<void> {
  await handle.sync();
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

/** An inclusive ancestor-to-descendant path, rejecting a broken `mkdir` return instead of looping. */
function parentFirstChain(first: string, last: string): readonly string[] {
  const bottomUp: string[] = [];
  let current = last;
  while (true) {
    bottomUp.push(current);
    if (current === first) return bottomUp.reverse();
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`created receipt directory ${last} is not beneath mkdir's first parent ${first}`);
    }
    current = parent;
  }
}

async function silentlyUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* the temporary file was already linked into place or cleaned up */
  }
}
