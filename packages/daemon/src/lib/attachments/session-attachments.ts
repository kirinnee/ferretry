import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { type AttachmentView, AttachmentViewSchema } from '@ferretry/protocol';
import { PdfDecryptError, type PdfDecryptor } from './pdf-decrypt-protocol.ts';

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const UNLOCK_LIFETIME_MS = 15 * 60_000;
const ID = /^att_[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_NAME = /^[^/\\\0]+$/;
const STORED_MANIFEST_KEYS = new Set(['id', 'filename', 'mime', 'size', 'sha256', 'createdAt', 'encrypted']);

export type AttachmentFailure =
  | 'invalid'
  | 'not_found'
  | 'corrupt'
  | 'too_large'
  | 'wrong_password'
  | 'locked'
  | 'decryption_failed';

export class SessionAttachmentError extends Error {
  constructor(
    readonly failure: AttachmentFailure,
    message: string,
  ) {
    super(message);
  }
}

/** One attachment's durable manifest, exactly as `manifest.json` holds it beside its `original`. */
export interface StoredAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly encrypted?: { readonly kind: 'pdf' };
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..')
    throw new SessionAttachmentError('invalid', 'session id is not usable');
}

function usableFilename(filename: string): boolean {
  return SAFE_NAME.test(filename) && filename !== '.' && filename !== '..';
}

/**
 * Where one session's attachment originals live: `<root>/attachments/<daemonId>/<sessionId>`.
 *
 * The ONE owner of that layout. The store's file adapter, the transfer copier and the fork all
 * resolve a session's tree through this, so none of them can name a plausible-looking directory the
 * others never read. The directory includes daemonId even though each daemon owns a different state
 * home: sharing a state root must still never make one daemon's attachment addressable by another.
 */
export function attachmentDirectory(root: string, daemonId: string, sessionId: string): string {
  if (daemonId.trim() === '') throw new SessionAttachmentError('invalid', 'a daemon id is required');
  assertSessionId(sessionId);
  return join(root, 'attachments', daemonId, sessionId);
}

/**
 * One manifest, PARSED rather than trusted, and the only place that decides what a usable one is —
 * for the store that reads it and for the transfer copier that copies it verbatim.
 *
 * `AttachmentViewSchema` already owns what an attachment's facts must look like — a non-empty
 * filename and mime, a non-negative integer size, a 64-hex digest, a real instant — so the durable
 * projection is validated against it rather than this file re-listing those rules and drifting from
 * them. What that schema cannot know is checked beside it:
 *
 * - the record holds the durable keys and nothing else, because the copier publishes the raw bytes
 *   and an unplanned field would otherwise cross into another session unseen;
 * - the directory an attachment was found in must be the id the record claims;
 * - the id must be the CONTENT ADDRESS of the bytes it describes (`att_<sha256>`), so a manifest
 *   cannot rename somebody else's content into this slot;
 * - the durable encryption record is exactly `{ kind: 'pdf' }` or nothing — a shape this store writes
 *   and no wire schema describes, never normalised from something else, because the projection
 *   reports every encrypted original as locked;
 * - a filename can never be read back as a path, `.` and `..` included.
 *
 * Anything else is `corrupt`. Proving the ORIGINAL bytes still hash to this address is deliberately
 * NOT done here — that belongs to the paths that read those bytes.
 */
export function parseStoredAttachmentManifest(document: unknown, attachmentId: string): StoredAttachment {
  const record: Readonly<Record<string, unknown>> =
    typeof document === 'object' && document !== null && !Array.isArray(document)
      ? (document as Readonly<Record<string, unknown>>)
      : {};
  const hasOnlyDurableFields = Object.keys(record).every(key => STORED_MANIFEST_KEYS.has(key));
  const encrypted = record.encrypted;
  const encryptionIsDurable =
    encrypted === undefined ||
    (typeof encrypted === 'object' &&
      encrypted !== null &&
      !Array.isArray(encrypted) &&
      Object.keys(encrypted).length === 1 &&
      (encrypted as { readonly kind?: unknown }).kind === 'pdf');
  const durable = AttachmentViewSchema.safeParse({
    id: record.id,
    filename: record.filename,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    createdAt: record.createdAt,
    ...(encrypted === undefined ? {} : { encrypted: { kind: 'pdf', locked: true } }),
  });
  if (
    !durable.success ||
    !hasOnlyDurableFields ||
    !encryptionIsDurable ||
    durable.data.id !== attachmentId ||
    durable.data.id !== `att_${durable.data.sha256}` ||
    !usableFilename(durable.data.filename)
  )
    throw new SessionAttachmentError('corrupt', 'attachment manifest is invalid');
  return {
    id: durable.data.id,
    filename: durable.data.filename,
    mime: durable.data.mime,
    size: durable.data.size,
    sha256: durable.data.sha256,
    createdAt: durable.data.createdAt,
    ...(encrypted === undefined ? {} : { encrypted: { kind: 'pdf' as const } }),
  };
}

/**
 * The durable half of the store: one session's originals and their manifests, wherever they live.
 *
 * Every id handed to it has already been validated, so an implementation may use them as path
 * segments. Any failure it throws other than the documented absences is read as `corrupt`.
 */
export interface AttachmentOriginalsPort {
  /** The entry names that are directories under this session's tree; empty when there is no tree. */
  attachmentIds(sessionId: string): Promise<readonly string[]>;
  /** The raw manifest text, or `undefined` when this attachment has no manifest. */
  readManifest(sessionId: string, attachmentId: string): Promise<string | undefined>;
  readOriginal(sessionId: string, attachmentId: string): Promise<Uint8Array>;
  /** Writes the original, then publishes the manifest atomically; leaves nothing behind on failure. */
  publish(sessionId: string, attachmentId: string, original: Uint8Array, manifest: string): Promise<void>;
}

interface UnlockedAttachment {
  readonly bytes: Uint8Array;
  readonly expiresAt: number;
}

export interface SessionAttachmentStoreOptions {
  readonly daemonId: string;
  readonly originals: AttachmentOriginalsPort;
  readonly decrypt: PdfDecryptor;
  readonly now?: () => Date;
  /**
   * Arranges for `evict` to run once `delayMs` have passed. The store calls it on every unlock so a
   * plaintext nobody reads again is still zeroed at its expiry rather than at process exit. Expiry
   * is enforced on every read regardless; this only bounds how long unread plaintext lingers.
   */
  readonly scheduleEviction?: (delayMs: number, evict: () => void) => void;
}

/**
 * Durable originals plus a process-local plaintext cache.
 *
 * Only `original` and its JSON manifest are ever written, through {@link AttachmentOriginalsPort}.
 * A plaintext unlock is not a storage operation: it lives in this object's memory, scoped to one
 * daemon and session, until it is locked, its session is released, or it EXPIRES — and an expired
 * entry is zeroed and reads as locked, whatever has or has not been called since.
 */
export class SessionAttachmentStore {
  private readonly unlocked = new Map<string, UnlockedAttachment>();
  private readonly now: () => Date;

  constructor(private readonly options: SessionAttachmentStoreOptions) {
    if (options.daemonId.trim() === '') throw new Error('a daemon id is required for attachment storage');
    this.now = options.now ?? (() => new Date());
  }

  private key(sessionId: string, attachmentId: string): string {
    return `${this.options.daemonId}:${sessionId}:${attachmentId}`;
  }

  private assertIds(sessionId: string, attachmentId: string): void {
    assertSessionId(sessionId);
    if (!ID.test(attachmentId)) throw new SessionAttachmentError('invalid', 'attachment id is not usable');
  }

  private evict(key: string, entry: UnlockedAttachment): void {
    if (this.unlocked.get(key) !== entry) return;
    entry.bytes.fill(0);
    this.unlocked.delete(key);
  }

  /** Zeroes and forgets every plaintext whose lifetime has run out. */
  private sweep(): void {
    const now = this.now().getTime();
    for (const [key, entry] of this.unlocked) if (entry.expiresAt <= now) this.evict(key, entry);
  }

  /**
   * One attachment as its MANIFEST alone describes it: identity, size, content hash, and the locked
   * state of an encrypted original. Nothing here consults the plaintext cache, so this projection is
   * the same for every reader regardless of what some session has unlocked.
   */
  private durableView(stored: StoredAttachment): AttachmentView {
    return {
      id: stored.id,
      filename: stored.filename,
      mime: stored.mime,
      size: stored.size,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      ...(stored.encrypted === undefined ? {} : { encrypted: { kind: 'pdf', locked: true } }),
    };
  }

  private view(stored: StoredAttachment, sessionId: string): AttachmentView {
    this.sweep();
    const unlocked = this.unlocked.get(this.key(sessionId, stored.id));
    if (stored.encrypted === undefined || unlocked === undefined) return this.durableView(stored);
    return {
      ...this.durableView(stored),
      encrypted: {
        kind: 'pdf',
        locked: false,
        expiresAt: new Date(unlocked.expiresAt).toISOString(),
        decryptedSize: unlocked.bytes.byteLength,
      },
    };
  }

  /**
   * Every attachment this session DURABLY holds, in content-address order.
   *
   * Deliberately blind to the unlock cache. A transfer inventory describes originals — the bytes that
   * can be copied — and an encrypted original is locked whatever some live session has decrypted in
   * memory. Reporting an unlock here would let one session's password decide what another session is
   * told it inherits, so the list is built from `durableView` and every encrypted entry reads locked.
   *
   * A directory with no manifest is a torn upload rather than an attachment, so it is skipped: there
   * is nothing to describe and nothing to carry. A manifest that EXISTS and does not parse is a
   * different answer and is raised, because bytes may well be there and an inventory that quietly
   * omitted them would report a complete list that is not one.
   */
  async list(sessionId: string): Promise<readonly AttachmentView[]> {
    assertSessionId(sessionId);
    let entries: readonly string[];
    try {
      entries = await this.options.originals.attachmentIds(sessionId);
    } catch {
      throw new SessionAttachmentError('corrupt', 'attachment storage for this session cannot be listed');
    }
    const ids = entries.filter(name => ID.test(name)).sort();
    const views: AttachmentView[] = [];
    for (const id of ids) {
      try {
        views.push(this.durableView(await this.stored(sessionId, id)));
      } catch (error) {
        if (error instanceof SessionAttachmentError && error.failure === 'not_found') continue;
        throw error;
      }
    }
    return views;
  }

  private async stored(sessionId: string, attachmentId: string): Promise<StoredAttachment> {
    this.assertIds(sessionId, attachmentId);
    let text: string | undefined;
    try {
      text = await this.options.originals.readManifest(sessionId, attachmentId);
    } catch {
      throw new SessionAttachmentError('corrupt', 'attachment manifest cannot be read');
    }
    if (text === undefined) throw new SessionAttachmentError('not_found', 'attachment was not found');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SessionAttachmentError('corrupt', 'attachment manifest cannot be read');
    }
    return parseStoredAttachmentManifest(parsed, attachmentId);
  }

  async upload(
    sessionId: string,
    input: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array },
  ): Promise<AttachmentView> {
    assertSessionId(sessionId);
    const filename = basename(input.filename.replaceAll('\\', '/'));
    if (!usableFilename(filename)) throw new SessionAttachmentError('invalid', 'attachment filename is not usable');
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new SessionAttachmentError('too_large', 'attachment exceeds the daemon size limit');
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const id = `att_${sha256}`;
    try {
      const existing = await this.stored(sessionId, id);
      return this.view(existing, sessionId);
    } catch (error) {
      if (!(error instanceof SessionAttachmentError) || error.failure !== 'not_found') throw error;
    }
    const encrypted = input.mime === 'application/pdf' && new TextDecoder().decode(input.bytes).includes('/Encrypt');
    const stored: StoredAttachment = {
      id,
      filename,
      mime: input.mime || 'application/octet-stream',
      size: input.bytes.byteLength,
      sha256,
      createdAt: this.now().toISOString(),
      ...(encrypted ? { encrypted: { kind: 'pdf' as const } } : {}),
    };
    await this.options.originals.publish(sessionId, id, input.bytes, `${JSON.stringify(stored)}\n`);
    return this.view(stored, sessionId);
  }

  async download(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ readonly attachment: AttachmentView; readonly bytes: Uint8Array }> {
    const stored = await this.stored(sessionId, attachmentId);
    let bytes: Uint8Array;
    try {
      bytes = await this.options.originals.readOriginal(sessionId, attachmentId);
    } catch {
      throw new SessionAttachmentError('corrupt', 'attachment original is missing');
    }
    if (bytes.byteLength !== stored.size || createHash('sha256').update(bytes).digest('hex') !== stored.sha256)
      throw new SessionAttachmentError('corrupt', 'attachment original does not match its manifest');
    return { attachment: this.view(stored, sessionId), bytes };
  }

  async unlock(sessionId: string, attachmentId: string, password: string): Promise<AttachmentView> {
    if (password.length === 0) throw new SessionAttachmentError('wrong_password', 'a password is required');
    const stored = await this.stored(sessionId, attachmentId);
    if (stored.encrypted === undefined) throw new SessionAttachmentError('invalid', 'attachment is not encrypted');
    const original = (await this.download(sessionId, attachmentId)).bytes;
    let plain: Uint8Array | undefined;
    try {
      plain = await this.options.decrypt(original, password);
      if (plain.byteLength === 0 || plain.byteLength > MAX_ATTACHMENT_BYTES * 2)
        throw new SessionAttachmentError('decryption_failed', 'decrypted attachment is not usable');
      const key = this.key(sessionId, attachmentId);
      const previous = this.unlocked.get(key);
      if (previous !== undefined) this.evict(key, previous);
      const entry: UnlockedAttachment = { bytes: plain, expiresAt: this.now().getTime() + UNLOCK_LIFETIME_MS };
      this.unlocked.set(key, entry);
      plain = undefined;
      this.options.scheduleEviction?.(UNLOCK_LIFETIME_MS, () => this.evict(key, entry));
      return this.view(stored, sessionId);
    } catch (error) {
      if (error instanceof PdfDecryptError)
        throw new SessionAttachmentError(
          error.failure === 'wrong_password' ? 'wrong_password' : 'decryption_failed',
          error.message,
        );
      throw error;
    } finally {
      original.fill(0);
      plain?.fill(0);
      // Password is intentionally use-once: it is never journaled, cached, or placed in the secret vault.
    }
  }

  async lock(sessionId: string, attachmentId: string): Promise<AttachmentView> {
    const stored = await this.stored(sessionId, attachmentId);
    const key = this.key(sessionId, attachmentId);
    const unlocked = this.unlocked.get(key);
    if (unlocked !== undefined) this.evict(key, unlocked);
    return this.view(stored, sessionId);
  }

  /** Zeroes and forgets every plaintext this session holds — called when the session stops or is gone. */
  releaseSession(sessionId: string): void {
    const prefix = `${this.options.daemonId}:${sessionId}:`;
    for (const [key, unlocked] of this.unlocked) if (key.startsWith(prefix)) this.evict(key, unlocked);
  }
}

/**
 * The store as the attachment routes reach it: every call first proves the session still exists.
 *
 * A session that is gone answers `not_found` AND has every plaintext it held zeroed on the spot, so a
 * removed session's unlocked documents cannot outlive it in memory until their expiry.
 */
export function sessionScopedAttachments(
  store: SessionAttachmentStore,
  exists: (sessionId: string) => Promise<boolean>,
) {
  const require = async (sessionId: string): Promise<void> => {
    if (await exists(sessionId)) return;
    store.releaseSession(sessionId);
    throw new SessionAttachmentError('not_found', 'session was not found');
  };
  return {
    upload: async (
      sessionId: string,
      request: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array },
    ): Promise<AttachmentView> => {
      await require(sessionId);
      return await store.upload(sessionId, request);
    },
    download: async (
      sessionId: string,
      attachmentId: string,
    ): Promise<{ readonly attachment: AttachmentView; readonly bytes: Uint8Array }> => {
      await require(sessionId);
      return await store.download(sessionId, attachmentId);
    },
    unlock: async (sessionId: string, attachmentId: string, password: string): Promise<AttachmentView> => {
      await require(sessionId);
      return await store.unlock(sessionId, attachmentId, password);
    },
    lock: async (sessionId: string, attachmentId: string): Promise<AttachmentView> => {
      await require(sessionId);
      return await store.lock(sessionId, attachmentId);
    },
  };
}

/**
 * A session control whose `stop` also zeroes that session's unlocked plaintext. The release runs
 * whether or not the stop itself succeeded: a half-stopped session holding a decrypted document is
 * the case worth failing closed for.
 */
export function releasingAttachmentsOnStop<
  View,
  Control extends { stop(sessionId: string, reason: string | undefined): Promise<View> },
>(control: Control, store: Pick<SessionAttachmentStore, 'releaseSession'>): Control {
  return {
    ...control,
    stop: async (sessionId: string, reason: string | undefined): Promise<View> => {
      try {
        return await control.stop(sessionId, reason);
      } finally {
        store.releaseSession(sessionId);
      }
    },
  };
}
