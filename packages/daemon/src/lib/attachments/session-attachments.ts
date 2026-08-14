import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type AttachmentView, AttachmentViewSchema } from '@ferretry/protocol';
import { decryptPdfInMemory, PdfDecryptError } from './decrypt-pdf.ts';

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const ID = /^att_[a-f0-9]{64}$/;
const SAFE_NAME = /^[^/\\\0]+$/;

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

interface StoredAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly encrypted?: { readonly kind: 'pdf' };
}

interface UnlockedAttachment {
  readonly bytes: Uint8Array;
  readonly expiresAt: string;
}

export interface SessionAttachmentStoreOptions {
  readonly root: string;
  readonly daemonId: string;
  readonly decrypt?: (bytes: Uint8Array, password: string) => Promise<Uint8Array>;
  readonly now?: () => Date;
}

/**
 * Durable originals plus a process-local plaintext cache.
 *
 * The directory includes daemonId even though each daemon owns a different state
 * home: sharing a state root must still never make one daemon's attachment addressable
 * by another. Only `original` and its JSON manifest are written under this root.
 */
export class SessionAttachmentStore {
  private readonly unlocked = new Map<string, UnlockedAttachment>();
  private readonly decrypt: (bytes: Uint8Array, password: string) => Promise<Uint8Array>;
  private readonly now: () => Date;

  constructor(private readonly options: SessionAttachmentStoreOptions) {
    if (options.daemonId.trim() === '') throw new Error('a daemon id is required for attachment storage');
    this.decrypt = options.decrypt ?? decryptPdfInMemory;
    this.now = options.now ?? (() => new Date());
  }

  private key(sessionId: string, attachmentId: string): string {
    return `${this.options.daemonId}:${sessionId}:${attachmentId}`;
  }

  private directory(sessionId: string, attachmentId: string): string {
    this.assertId(sessionId, 'session');
    if (!ID.test(attachmentId)) throw new SessionAttachmentError('invalid', 'attachment id is not usable');
    return join(this.options.root, 'attachments', this.options.daemonId, sessionId, attachmentId);
  }

  private assertId(value: string, label: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..')
      throw new SessionAttachmentError('invalid', `${label} id is not usable`);
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
    const unlocked = this.unlocked.get(this.key(sessionId, stored.id));
    if (stored.encrypted === undefined || unlocked === undefined) return this.durableView(stored);
    return {
      ...this.durableView(stored),
      encrypted: {
        kind: 'pdf',
        locked: false,
        expiresAt: unlocked.expiresAt,
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
    this.assertId(sessionId, 'session');
    const root = join(this.options.root, 'attachments', this.options.daemonId, sessionId);
    let entries: readonly Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
      throw new SessionAttachmentError('corrupt', 'attachment storage for this session cannot be listed');
    }
    const ids = entries
      .filter(entry => entry.isDirectory() && ID.test(entry.name))
      .map(entry => entry.name)
      .sort();
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
    const directory = this.directory(sessionId, attachmentId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        throw new SessionAttachmentError('not_found', 'attachment was not found');
      throw new SessionAttachmentError('corrupt', 'attachment manifest cannot be read');
    }
    return this.manifest(parsed, attachmentId);
  }

  /**
   * One manifest, PARSED rather than trusted, and the only place that decides what a usable one is.
   *
   * `AttachmentViewSchema` already owns what an attachment's facts must look like — a non-empty
   * filename and mime, a non-negative integer size, a 64-hex digest, a real instant — so the durable
   * projection is validated against it rather than this file re-listing those rules and drifting from
   * them. Four things that schema cannot know are checked beside it:
   *
   * - the directory an attachment was found in must be the id the record claims;
   * - the id must be the CONTENT ADDRESS of the bytes it describes (`att_<sha256>`), so a manifest
   *   cannot rename somebody else's content into this slot;
   * - the durable encryption record is `{ kind: 'pdf' }` or nothing — a shape this store writes and
   *   no wire schema describes, and one that must never be normalised from something else, because
   *   the projection reports every encrypted original as locked;
   * - a filename can never be read back as a path.
   *
   * Anything else is `corrupt`. That matters beyond this store: this inventory feeds a durable
   * transfer plan, so a manifest half-read here becomes a plan that fails validation much later,
   * about a session, instead of a refusal now, about the file that is actually damaged. Proving the
   * ORIGINAL bytes still hash to this address is deliberately NOT done here — that belongs to the
   * paths that read those bytes: `download`, and the transfer copier on the import write.
   */
  private manifest(document: unknown, attachmentId: string): StoredAttachment {
    const record: Readonly<Record<string, unknown>> =
      typeof document === 'object' && document !== null && !Array.isArray(document)
        ? (document as Readonly<Record<string, unknown>>)
        : {};
    const encrypted = record.encrypted;
    const encryptionIsDurable =
      encrypted === undefined ||
      (typeof encrypted === 'object' &&
        encrypted !== null &&
        !Array.isArray(encrypted) &&
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
      !encryptionIsDurable ||
      durable.data.id !== attachmentId ||
      durable.data.id !== `att_${durable.data.sha256}` ||
      !SAFE_NAME.test(durable.data.filename)
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

  async upload(
    sessionId: string,
    input: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array },
  ): Promise<AttachmentView> {
    this.assertId(sessionId, 'session');
    const filename = basename(input.filename.replaceAll('\\', '/'));
    if (!SAFE_NAME.test(filename) || filename === '.' || filename === '..')
      throw new SessionAttachmentError('invalid', 'attachment filename is not usable');
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new SessionAttachmentError('too_large', 'attachment exceeds the daemon size limit');
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const id = `att_${sha256}`;
    const directory = this.directory(sessionId, id);
    const manifestPath = join(directory, 'manifest.json');
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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(directory, 'original'), input.bytes, { flag: 'wx', mode: 0o600 });
      const temporary = join(directory, `.manifest-${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(stored)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, manifestPath);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return this.view(stored, sessionId);
  }

  async download(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ readonly attachment: AttachmentView; readonly bytes: Uint8Array }> {
    const stored = await this.stored(sessionId, attachmentId);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(this.directory(sessionId, attachmentId), 'original')));
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
      plain = await this.decrypt(original, password);
      if (plain.byteLength === 0 || plain.byteLength > MAX_ATTACHMENT_BYTES * 2)
        throw new SessionAttachmentError('decryption_failed', 'decrypted attachment is not usable');
      this.unlocked.set(this.key(sessionId, attachmentId), {
        bytes: plain,
        expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString(),
      });
      plain = undefined;
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
    const unlocked = this.unlocked.get(this.key(sessionId, attachmentId));
    unlocked?.bytes.fill(0);
    this.unlocked.delete(this.key(sessionId, attachmentId));
    return this.view(stored, sessionId);
  }

  releaseSession(sessionId: string): void {
    const prefix = `${this.options.daemonId}:${sessionId}:`;
    for (const [key, unlocked] of this.unlocked) {
      if (key.startsWith(prefix)) {
        unlocked.bytes.fill(0);
        this.unlocked.delete(key);
      }
    }
  }
}
