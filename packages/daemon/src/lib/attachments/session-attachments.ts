import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AttachmentView } from '@ferretry/protocol';
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

  private view(stored: StoredAttachment, sessionId: string): AttachmentView {
    const unlocked = this.unlocked.get(this.key(sessionId, stored.id));
    return {
      id: stored.id,
      filename: stored.filename,
      mime: stored.mime,
      size: stored.size,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      ...(stored.encrypted === undefined
        ? {}
        : unlocked === undefined
          ? { encrypted: { kind: 'pdf', locked: true } }
          : {
              encrypted: {
                kind: 'pdf',
                locked: false,
                expiresAt: unlocked.expiresAt,
                decryptedSize: unlocked.bytes.byteLength,
              },
            }),
    };
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
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as StoredAttachment).id !== attachmentId ||
      !SAFE_NAME.test((parsed as StoredAttachment).filename ?? '') ||
      typeof (parsed as StoredAttachment).size !== 'number'
    )
      throw new SessionAttachmentError('corrupt', 'attachment manifest is invalid');
    return parsed as StoredAttachment;
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
