/**
 * The daemon's private message-token key, and the only code in this package that ever holds it.
 *
 * WHAT IT PROTECTS. Every selection binding and every pagination cursor is an HMAC under this key.
 * Anyone who can read it can mint a binding for content the operator never selected, and preparation
 * would accept the fork. So it is owner-only, published exactly once, and never handed out: the
 * domain receives {@link SessionTranscriptMessageTokenCodec} — `tag` and `matches` — and there is no
 * accessor to add.
 *
 * WHY CREATE-ONCE IS A COMPARE-AND-SET AND NOT A CHECK-THEN-WRITE. Two boots, or two first requests
 * inside one boot, can both find no key. If each then wrote one, the second would overwrite the
 * first and every binding and cursor issued in between would fail verification — silently reported
 * as stale content, which is a lie about the transcript. So a fresh key is written to an exclusive
 * temporary and `link`ed into place: `link` is an atomic create that fails with `EEXIST` the instant
 * the name exists, so exactly one writer wins and every loser adopts the winner's key. An in-memory
 * promise queue cannot do this — it does not exist across two processes, and it does not survive a
 * crash between the write and the publication.
 *
 * THE TEMPORARY DOES NOT LIVE BESIDE THE FINAL. It is created under the state home's own temporary
 * directory, with the repository's `<basename>.<writerId>.tmp` scratch grammar, because that is the
 * only directory the layout sweeps and the only shape its marker-absent recovery recognises. A
 * scratch file dropped next to the key would read as foreign state and make the home unbootable.
 *
 * DURABILITY IS ORDERED, and the order is the whole guarantee: the temporary's bytes are synced and
 * closed, its directory is synced, the link publishes the final name, the final FILE and its parent
 * are synced before a single tag is issued, and only then is this writer's own temporary removed and
 * its directory synced again. A directory that cannot be synced at all is tolerated for exactly the
 * three refusals that mean the filesystem has no directory fsync; a FILE fsync is never tolerated,
 * because a key whose bytes are not on disk is a key every outstanding token will be refused
 * against after the next power loss.
 *
 * IT FAILS CLOSED, ALWAYS. Missing after publication, not a regular file, a symlink, the wrong mode,
 * the wrong length, or unreadable: every one of them refuses. There is no process-local fallback
 * key, because a fallback would issue tags that verify now and are refused for ever afterwards —
 * the failure would show up as "your selection is stale" long after the cause was gone.
 *
 * LOSING THE KEY IS A DURABILITY LOSS, NOT A CACHE EVICTION. Every outstanding binding and cursor
 * becomes stale at once. That is the honest consequence of the property this file exists to hold,
 * and it belongs in the threat model rather than in a recovery path that invents a new key.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionTranscriptMessageTokenCodec } from '../../../lib/session/transcript/message-token.ts';
import { SESSION_MESSAGE_TOKEN_KEY_BASENAME } from '../../storage/state-home-layout.ts';

/** 256 bits, the same width every other daemon-minted secret is drawn at. */
export const SESSION_MESSAGE_TOKEN_KEY_BYTES = 32;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Owner read/write and nothing else — checked on the way in, not merely set on the way out. */
const REQUIRED_KEY_PERMISSIONS = 0o600;

/** The refusals that mean "this filesystem has no directory fsync", and nothing wider. */
const TOLERATED_DIRECTORY_SYNC_CODES = ['EINVAL', 'ENOTSUP', 'EPERM'] as const;

/**
 * Exclusive create that refuses to follow a symlink, and a read that refuses one — and that cannot
 * be made to hang by the very input it exists to refuse.
 *
 * `O_EXCL` already declines to follow at the final component, and `O_NOFOLLOW` says the same thing
 * on the read side, where a planted symlink would otherwise let another user's file answer as the
 * daemon's key.
 *
 * `O_NONBLOCK` IS THE ONE THAT IS NOT OBVIOUS, and without it the refusal below is unreachable. A
 * read-only open of a FIFO blocks until a writer appears, so a FIFO left at the key's name would
 * suspend the open for ever: `stat()` would never run, the "is not a regular file" refusal would
 * never fire, and the daemon would hang with no error, no timeout and no log line. With the flag the
 * open returns immediately even with no writer, the handle reports a FIFO, and the refusal that is
 * already written does its job. On a regular file the flag does nothing at all.
 *
 * A directory is opened `O_DIRECTORY` for the same class of reason: it refuses anything that is not
 * a directory instead of following it, and it therefore cannot block either. These are raw
 * `node:fs` calls, so the state filesystem's own symlink ban never runs in front of them.
 */
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * The one durable key location, under the state directory and nowhere else.
 *
 * The basename is IMPORTED, never repeated. The state-home layout owns it because its marker-absent
 * recovery is the other program that has to recognise this exact file: two literals that drifted
 * would make a home holding a perfectly good key read as foreign state and refuse to boot, with no
 * signal pointing at the mismatch.
 */
export function sessionMessageTokenKeyFile(stateDirectory: string): string {
  return join(stateDirectory, SESSION_MESSAGE_TOKEN_KEY_BASENAME);
}

/** The key could not be established or trusted, so no token may be issued or verified. */
export class SessionMessageTokenKeyError extends Error {
  constructor(message: string) {
    super(`the daemon message-token key ${message}`);
    this.name = 'SessionMessageTokenKeyError';
  }
}

/** One already-published key file, as the pinned handle found it. */
export interface HeldSessionMessageTokenKey {
  readonly bytes: Uint8Array;
  readonly stats: Stats;
}

/**
 * The mutation surface one durable key needs — deliberately narrower than a filesystem, so a test
 * can observe publication and sync ORDER without being handed another way to write.
 */
export interface SessionMessageTokenKeyFileOperations {
  /** Returns the first directory created, or `undefined` when the complete path already existed. */
  ensureDirectory(path: string, mode: number): Promise<string | undefined>;
  /** Exclusively creates, writes, fsyncs and closes one private temporary before resolving. */
  writePrivateSynced(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  /** Atomic create-if-absent: the real compare-and-set behind first publication. */
  link(from: string, to: string): Promise<void>;
  /**
   * Opens the key read-only exactly once and gives `use` that inode's bytes and metadata together
   * with the fsync of the very handle they came from, so a caller can prove the key it validated is
   * the key it persisted. Resolves to `undefined` only when the name does not exist.
   */
  readPinned<T>(
    path: string,
    use: (held: HeldSessionMessageTokenKey, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined>;
  /** Persists the entries and metadata belonging to this directory. */
  syncDirectory(path: string): Promise<void>;
  /**
   * Which inode this NAME resolves to right now, without following a symlink, or `undefined` when
   * nothing answers to it. Used to prove a name still means the file that was validated.
   */
  identityOf(path: string): Promise<string | undefined>;
  /**
   * Removes a temporary this writer created. Tolerates ONLY its absence: any other refusal is a
   * scratch file left behind in a directory whose contents the layout has a rule about.
   */
  discard(path: string): Promise<void>;
}

/** Production key operations, kept explicit so the durability sequence is reviewable. */
export class NodeSessionMessageTokenKeyFileOperations implements SessionMessageTokenKeyFileOperations {
  constructor(private readonly fsync: (handle: { sync: () => Promise<void> }) => Promise<void> = syncHandle) {}

  async ensureDirectory(path: string, mode: number): Promise<string | undefined> {
    return await mkdir(path, { recursive: true, mode });
  }

  async writePrivateSynced(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    let created = false;
    try {
      const handle = await open(path, CREATE_FLAGS, mode);
      created = true;
      try {
        await handle.writeFile(bytes);
        await this.fsync(handle);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A generated-name collision belongs to another writer. Only remove a temporary after this
      // invocation's exclusive open proved that it created, and therefore owns, the path. The
      // removal is allowed to fail loudly: a scratch file nobody can delete is a real problem in a
      // directory the layout has a rule about, and both failures refuse this publication anyway.
      if (created) await this.discard(path);
      throw error;
    }
  }

  async link(from: string, to: string): Promise<void> {
    await link(from, to);
  }

  async readPinned<T>(
    path: string,
    use: (held: HeldSessionMessageTokenKey, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(path, READ_FLAGS);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      // Metadata comes from the OPEN HANDLE, not from the name: a name re-examined after the read
      // can resolve to a different inode, and the mode this validates must be the mode of the very
      // file whose bytes it is about to trust.
      const stats = await handle.stat();
      // THE KIND IS DECIDED BEFORE A SINGLE BYTE IS READ, and that ordering is load-bearing rather
      // than tidy. `O_NONBLOCK` gets the open past a FIFO, but reading one is a different hazard:
      // with a writer attached, `readFile` would block until that writer closed — and would consume
      // whatever it streamed on the way. A directory is the same story with a different errno: the
      // read fails with `EISDIR`, so the caller would see a raw platform error where the contract
      // promises a key refusal. Deciding here means a non-regular file is never read at all, and
      // every kind refusal is one error type. `validateKey` still re-checks the kind afterwards,
      // because an injected operations implementation reaches `use` without passing through here.
      if (!stats.isFile()) throw new SessionMessageTokenKeyError('is not a regular file');
      const bytes = await handle.readFile();
      return await use({ bytes, stats }, async () => await this.fsync(handle));
    } finally {
      await handle.close();
    }
  }

  async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, DIRECTORY_FLAGS);
      try {
        await this.fsync(handle);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Some filesystems offer no directory persistence at all and say so by refusing the open or
      // the fsync itself. That is a platform limit rather than a lost write, so exactly those
      // refusals are tolerated; every other failure is real and still stops the publication.
      if (!TOLERATED_DIRECTORY_SYNC_CODES.some(code => isErrnoCode(error, code))) throw error;
    }
  }

  async identityOf(path: string): Promise<string | undefined> {
    try {
      // `lstat`, not `stat`: a symlink that appeared here answers as itself and therefore as a
      // different inode, which is exactly the mismatch this call exists to catch.
      return inodeIdentity(await lstat(path));
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async discard(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      // Already gone is the only acceptable answer: this writer's exclusive create means nobody
      // else owns the name, so anything else is a scratch file it failed to clean up.
      if (!isErrnoCode(error, 'ENOENT')) throw error;
    }
  }
}

/**
 * HMAC-SHA-256 over a daemon-private key that is created once and reused for the life of the state
 * home.
 *
 * The key is resolved lazily and remembered, so the durability sequence runs once per instance
 * rather than once per token. A failed resolution is NOT remembered: a transient IO failure must not
 * poison every later token, and a corrupt key that an operator repairs must be picked up.
 */
export class FileSessionTranscriptMessageTokenCodec implements SessionTranscriptMessageTokenCodec {
  private pending?: Promise<Uint8Array>;

  constructor(
    private readonly keyFile: string,
    /**
     * Where this writer's exclusive scratch file goes, from the caller that owns the state layout.
     *
     * Injected rather than derived, because the `<state>/tmp/<basename>.<writerId>.tmp` shape is
     * owned by the paths module and recognised by the layout's recovery: a second spelling here
     * would be a second answer to what a legal scratch name is.
     */
    private readonly temporaryFile: (writerId: string) => string,
    private readonly random: (size: number) => Uint8Array = randomBytes,
    private readonly writerId: () => string = randomUUID,
    private readonly files: SessionMessageTokenKeyFileOperations = new NodeSessionMessageTokenKeyFileOperations(),
  ) {}

  async tag(input: Uint8Array): Promise<Uint8Array> {
    return createHmac('sha256', await this.material())
      .update(input)
      .digest();
  }

  /**
   * Constant-time comparison, and a length check that is not one.
   *
   * The length of a tag is public — it is fixed by the algorithm — so comparing lengths first leaks
   * nothing, while `timingSafeEqual` refuses mismatched lengths outright. What must never happen is
   * a byte-by-byte comparison with an early exit, which reports how much of a forged tag was right.
   */
  async matches(input: Uint8Array, tag: Uint8Array): Promise<boolean> {
    const expected = await this.tag(input);
    if (expected.byteLength !== tag.byteLength) return false;
    return timingSafeEqual(expected, tag);
  }

  private material(): Promise<Uint8Array> {
    this.pending ??= this.resolveKey().catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  /** Adopt the published key, or win the race to publish one. */
  private async resolveKey(): Promise<Uint8Array> {
    return (await this.readDurableKey()) ?? (await this.publishKey());
  }

  /**
   * The six-step publication, in the order that makes it survive a power loss:
   * bytes synced and closed under a private name, the scratch directory synced, the atomic link,
   * the final file and its parent synced BEFORE any token exists, then this writer's own scratch
   * removed and its directory synced again.
   */
  private async publishKey(): Promise<Uint8Array> {
    const temporary = this.temporaryFile(this.writerId());
    const scratchDirectory = dirname(temporary);
    const keyDirectory = dirname(this.keyFile);
    await this.files.ensureDirectory(keyDirectory, PRIVATE_DIRECTORY_MODE);
    await this.files.ensureDirectory(scratchDirectory, PRIVATE_DIRECTORY_MODE);

    let ownsTemporary = false;
    let published: Uint8Array;
    try {
      await this.files.writePrivateSynced(temporary, this.mintKey(), PRIVATE_FILE_MODE);
      ownsTemporary = true;
      await this.files.syncDirectory(scratchDirectory);

      try {
        await this.files.link(temporary, this.keyFile);
      } catch (error) {
        if (!isErrnoCode(error, 'EEXIST')) throw error;
      }

      // Whether this attempt won or lost, the key it will USE is the published one, validated and
      // persisted through its own pinned handle. A loser that trusted its own minted bytes would
      // issue tags nobody else can verify.
      const adopted = await this.readDurableKey();
      if (adopted === undefined) throw new SessionMessageTokenKeyError('vanished between publication and first read');
      published = adopted;
    } catch (error) {
      // Already failing, and no token can be issued on this path. The cleanup still runs and is
      // still allowed to fail loudly — a scratch file this attempt cannot remove is a real problem
      // in a directory the layout has a rule about, so it is never swallowed to preserve the
      // original error. Whichever failure surfaces, the materialization refused.
      if (ownsTemporary) await this.discardOwnScratch(temporary, scratchDirectory);
      throw error;
    }

    // Step six, and it is mandatory rather than best-effort: an unremoved scratch file reads as
    // foreign state to the layout's marker-absent recovery, and an unpersisted removal can come
    // back after a power loss. A failure here fails this materialization instead of quietly
    // issuing tokens over a half-finished publication.
    if (ownsTemporary) await this.discardOwnScratch(temporary, scratchDirectory);
    return published;
  }

  /**
   * Remove ONLY this writer's scratch, and persist the removal.
   *
   * `link` leaves the temporary in place, so the name is still this writer's to remove — and it can
   * never be another writer's, because the exclusive create is what proved we made it. Absence is
   * the one tolerated outcome; every other refusal propagates.
   */
  private async discardOwnScratch(temporary: string, scratchDirectory: string): Promise<void> {
    await this.files.discard(temporary);
    await this.files.syncDirectory(scratchDirectory);
  }

  /**
   * Read, validate and persist the published key through ONE pinned handle.
   *
   * The handle is the point. A key validated by name and then re-opened to be synced could be two
   * different files, and the one this daemon signs with would be the one it never checked.
   */
  private async readDurableKey(): Promise<Uint8Array | undefined> {
    const held = await this.files.readPinned(this.keyFile, async (key, syncPinned) => {
      const bytes = validateKey(key);
      await syncPinned();
      return { bytes, identity: inodeIdentity(key.stats) };
    });
    if (held === undefined) return undefined;
    await this.files.syncDirectory(dirname(this.keyFile));

    // PROVE, FLUSH, CONFIRM. Everything above speaks for one open inode; nothing yet speaks for the
    // NAME. A writer that replaced the key between the open and here would leave this daemon signing
    // with bytes the published path no longer holds — every token it minted refused by the next
    // reader, and every token that reader minted refused here, both reported as stale content. A
    // replaced key must fail closed instead, so the name is re-checked against the inode that was
    // validated, without following a symlink that may have appeared in its place.
    if ((await this.files.identityOf(this.keyFile)) !== held.identity)
      throw new SessionMessageTokenKeyError('was replaced while it was being read, so it was never adopted');
    return held.bytes;
  }

  private mintKey(): Uint8Array {
    const bytes = this.random(SESSION_MESSAGE_TOKEN_KEY_BYTES);
    if (bytes.byteLength !== SESSION_MESSAGE_TOKEN_KEY_BYTES)
      throw new SessionMessageTokenKeyError('was minted at the wrong width, so it was never written');
    return bytes;
  }
}

/**
 * Everything that must be true of a key file before this daemon signs with it.
 *
 * Each refusal is a different way the file stops being ours: a directory or device where the key
 * should be, a mode that lets somebody else read it, or a length that is not the width the whole
 * scheme assumes. None of them is repaired here — a key is created once, so "repair" would mean
 * replacing the one thing every outstanding token depends on.
 */
function validateKey(key: HeldSessionMessageTokenKey): Uint8Array {
  if (!key.stats.isFile()) throw new SessionMessageTokenKeyError('is not a regular file');
  if ((key.stats.mode & 0o777) !== REQUIRED_KEY_PERMISSIONS)
    throw new SessionMessageTokenKeyError('is readable by somebody other than its owner');
  if (key.bytes.byteLength !== SESSION_MESSAGE_TOKEN_KEY_BYTES)
    throw new SessionMessageTokenKeyError('is not exactly 32 bytes, so it is damaged or not ours');
  return key.bytes;
}

/** Which file on which device — so a validated inode can be told from whatever a name means later. */
function inodeIdentity(info: Stats): string {
  return `${info.dev.toString()}:${info.ino.toString()}`;
}

/** The real fsync, named so the one place it is issued from can be substituted in a test. */
async function syncHandle(handle: { sync: () => Promise<void> }): Promise<void> {
  await handle.sync();
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
