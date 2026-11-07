/**
 * A stand-in for the attachment owner's store (`TransferAttachmentStore`, an unbound port owned by Conversation).
 *
 * It keeps the files in memory and records every call, and it models the two rules of the real one the transfer
 * relies on: a `write` replaces a file whole (a reader never sees half of one), and `parseManifest` accepts only a
 * manifest with exactly the durable keys, a content-addressed id and a usable filename. The real store's own
 * behaviour is pinned by Conversation's tests; this exists so the transfer's durability contract can be driven.
 */

import type {
  AttachmentFile,
  TransferAttachmentStore,
  TransferStoredManifest,
} from '../../../../daemon/lib/transfer/ports.ts';

const DURABLE_KEYS = new Set(['id', 'filename', 'mime', 'size', 'sha256', 'createdAt', 'encrypted']);

const key = (sessionId: string, attachmentId: string, file: AttachmentFile): string =>
  `${sessionId}/${attachmentId}/${file}`;

export class MemoryAttachmentStore implements TransferAttachmentStore {
  readonly files = new Map<string, Uint8Array>();
  /** `read <key>` / `write <key>` in call order. */
  readonly calls: string[] = [];
  /** Runs after each write has landed (a crash, or another writer replacing the name). */
  afterWrite: (written: { readonly key: string; readonly sessionId: string; readonly file: AttachmentFile }) => void =
    () => undefined;
  /** Makes a read of this key throw (a file that exists and cannot be read). */
  readonly unreadable = new Set<string>();

  put(sessionId: string, attachmentId: string, file: AttachmentFile, bytes: Uint8Array | string): void {
    this.files.set(
      key(sessionId, attachmentId, file),
      typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes),
    );
  }

  text(sessionId: string, attachmentId: string, file: AttachmentFile): string | undefined {
    const bytes = this.files.get(key(sessionId, attachmentId, file));
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  bytes(sessionId: string, attachmentId: string, file: AttachmentFile): Uint8Array | undefined {
    return this.files.get(key(sessionId, attachmentId, file));
  }

  writesOf(sessionId: string): string[] {
    return this.calls.filter(call => call.startsWith(`write ${sessionId}/`));
  }

  async read(sessionId: string, attachmentId: string, file: AttachmentFile): Promise<Uint8Array | undefined> {
    const at = key(sessionId, attachmentId, file);
    this.calls.push(`read ${at}`);
    if (this.unreadable.has(at)) throw Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' });
    const stored = this.files.get(at);
    return stored === undefined ? undefined : new Uint8Array(stored);
  }

  async write(sessionId: string, attachmentId: string, file: AttachmentFile, bytes: Uint8Array): Promise<void> {
    const at = key(sessionId, attachmentId, file);
    this.calls.push(`write ${at}`);
    this.files.set(at, new Uint8Array(bytes));
    this.afterWrite({ key: at, sessionId, file });
  }

  parseManifest(document: unknown, attachmentId: string): TransferStoredManifest {
    const record =
      typeof document === 'object' && document !== null && !Array.isArray(document)
        ? (document as Readonly<Record<string, unknown>>)
        : {};
    const encrypted = record.encrypted;
    const durableEncryption =
      encrypted === undefined ||
      (typeof encrypted === 'object' &&
        encrypted !== null &&
        Object.keys(encrypted).length === 1 &&
        (encrypted as { kind?: unknown }).kind === 'pdf');
    const sha = record.sha256;
    if (
      !Object.keys(record).every(name => DURABLE_KEYS.has(name)) ||
      !durableEncryption ||
      typeof record.id !== 'string' ||
      record.id !== attachmentId ||
      typeof sha !== 'string' ||
      record.id !== `att_${sha}` ||
      typeof record.filename !== 'string' ||
      record.filename === '' ||
      /[/\\\0]/u.test(record.filename) ||
      record.filename === '.' ||
      record.filename === '..' ||
      typeof record.mime !== 'string' ||
      typeof record.size !== 'number' ||
      typeof record.createdAt !== 'string'
    )
      throw new Error('attachment manifest is invalid');
    return {
      id: record.id,
      filename: record.filename,
      mime: record.mime,
      size: record.size,
      sha256: sha,
      createdAt: record.createdAt as TransferStoredManifest['createdAt'],
      ...(encrypted === undefined ? {} : { encrypted: { kind: 'pdf' as const } }),
    };
  }
}
