import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentOriginalsPort } from '../../lib/attachments/index.ts';

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * A session's attachment originals on disk, in the tree `attachmentDirectory` names.
 *
 * Implements `AttachmentOriginalsPort`. It is constructed with the SAME per-session resolver the
 * transfer copier receives, so an upload, a download and a fork's copy all address one tree. Each
 * attachment is a directory holding exactly `original` and `manifest.json`; the original is written
 * exclusively first and the manifest renamed into place last, so a torn upload leaves a directory with
 * no manifest — which the store reads as no attachment at all — and a failed one leaves nothing.
 */
export class FileAttachmentOriginals implements AttachmentOriginalsPort {
  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  async attachmentIds(sessionId: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.sessionDirectory(sessionId), { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async readManifest(sessionId: string, attachmentId: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.sessionDirectory(sessionId), attachmentId, 'manifest.json'), 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async readOriginal(sessionId: string, attachmentId: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(join(this.sessionDirectory(sessionId), attachmentId, 'original')));
  }

  async publish(sessionId: string, attachmentId: string, original: Uint8Array, manifest: string): Promise<void> {
    const directory = join(this.sessionDirectory(sessionId), attachmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(directory, 'original'), original, { flag: 'wx', mode: 0o600 });
      const temporary = join(directory, `.manifest-${this.uniqueId()}.tmp`);
      await writeFile(temporary, manifest, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(directory, 'manifest.json'));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
