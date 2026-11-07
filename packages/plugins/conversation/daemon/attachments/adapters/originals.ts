import type { StatePort } from '@ferretry/kernel/contract';
import type { AttachmentOriginalsPort } from '../lib/ferret-attachments.ts';
import { ATTACHMENT_MANIFEST_STATE, ATTACHMENT_ORIGINAL_STATE, nameOf, SEPARATOR } from './state.ts';

const bytesOf = (value: unknown): Uint8Array | undefined =>
  value === undefined ? undefined : typeof value === 'string' ? new TextEncoder().encode(value) : (value as Uint8Array);

/**
 * A ferret's attachment originals in the plugin's state, as the store's {@link AttachmentOriginalsPort}.
 *
 * The original is written first and the manifest last, so a torn upload leaves an original with no manifest, which the
 * store reads as no attachment at all; a failed one removes what it wrote (today's `FileAttachmentOriginals`).
 */
export class StateAttachmentOriginals implements AttachmentOriginalsPort {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write' | 'list' | 'remove'>) {}

  async attachmentIds(ferretId: string): Promise<readonly string[]> {
    const prefix = `${ferretId}${SEPARATOR}`;
    return (await this.state.list(ATTACHMENT_MANIFEST_STATE))
      .filter(name => name.startsWith(prefix))
      .map(name => name.slice(prefix.length));
  }

  async readManifest(ferretId: string, attachmentId: string): Promise<string | undefined> {
    const read = await this.state.read(ATTACHMENT_MANIFEST_STATE, nameOf(ferretId, attachmentId));
    if (!read.ok) throw new Error(read.error.sentence);
    const bytes = bytesOf(read.value);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  async readOriginal(ferretId: string, attachmentId: string): Promise<Uint8Array> {
    const read = await this.state.read(ATTACHMENT_ORIGINAL_STATE, nameOf(ferretId, attachmentId));
    if (!read.ok) throw new Error(read.error.sentence);
    const bytes = bytesOf(read.value);
    if (bytes === undefined) throw new Error('the attachment original is missing');
    return new Uint8Array(bytes);
  }

  async publish(ferretId: string, attachmentId: string, original: Uint8Array, manifest: string): Promise<void> {
    const name = nameOf(ferretId, attachmentId);
    try {
      await this.state.write(ATTACHMENT_ORIGINAL_STATE, original as never, name);
      await this.state.write(ATTACHMENT_MANIFEST_STATE, new TextEncoder().encode(manifest) as never, name);
    } catch (error) {
      await this.state.remove(ATTACHMENT_ORIGINAL_STATE, name);
      await this.state.remove(ATTACHMENT_MANIFEST_STATE, name);
      throw error;
    }
  }
}
