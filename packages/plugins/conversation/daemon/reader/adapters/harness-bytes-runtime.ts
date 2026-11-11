import type { HarnessTranscriptBytes } from '@ferretry/core-ferrets/contract';
import type { ConversationIndexFiles } from '../lib/session/conversation-index.ts';
import type { TranscriptImageFiles } from '../lib/session/image-reader.ts';
import { countLines } from '../lib/transcript/sliced.ts';
import type { BoundedTranscriptRead, TranscriptFileInfo, TranscriptFileRuntime } from './file-source.ts';

/** The windowed, unmasked bytes of one ferret's proved transcript: Ferrets' contract type, owned there. */
export type TranscriptBytesHandle = HarnessTranscriptBytes;

/** The most bytes one `read` of a handle is asked for: a handle clamps its windows, so the runtime loops. */
export const BYTES_WINDOW = 4 * 1024 * 1024;

/** The most handles kept by token; the oldest is forgotten first (a forgotten token reads as a missing file). */
export const MAX_REGISTERED = 256;

const SCAN_CHUNK_BYTES = 64 * 1024;

/** The file is not there (any more): the source reads `code: 'ENOENT'` as `source-missing`. */
class TranscriptFileGone extends Error {
  readonly code = 'ENOENT';
  constructor() {
    super('the transcript is not available');
  }
}

const isReplaced = (error: unknown): boolean => error instanceof Error && error.name === 'HarnessTranscriptReplaced';

/**
 * Exact-token transcript IO over harness byte handles. A token is `TranscriptBytesHandle.file`: it names a proved
 * file and never a path. It is the one file runtime of the reader: the transcript source, the conversation index,
 * the image reader and the record scanner all read the same bytes through it.
 */
export class HarnessBytesRuntime implements TranscriptFileRuntime, ConversationIndexFiles, TranscriptImageFiles {
  readonly #handles = new Map<string, TranscriptBytesHandle>();

  /** Remembers `handle` under its token and returns the token. */
  adopt(handle: TranscriptBytesHandle): string {
    this.#handles.delete(handle.file);
    this.#handles.set(handle.file, handle);
    while (this.#handles.size > MAX_REGISTERED) {
      const oldest = this.#handles.keys().next();
      if (oldest.done === true) break;
      this.#handles.delete(oldest.value);
    }
    return handle.file;
  }

  /** The handle a token names, or `undefined` once it was forgotten. */
  handle(token: string): TranscriptBytesHandle | undefined {
    return this.#handles.get(token);
  }

  async info(token: string): Promise<TranscriptFileInfo | undefined> {
    const handle = this.#handles.get(token);
    if (handle === undefined) return undefined;
    const stat = await handle.stat();
    return stat === undefined
      ? undefined
      : { identity: token, size: stat.size, modifiedMs: stat.mtimeMs, isFile: true };
  }

  async fingerprint(token: string): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined> {
    const info = await this.info(token);
    return info === undefined ? undefined : { size: info.size, mtimeMs: info.modifiedMs };
  }

  async countNewlines(token: string, byteLength: number): Promise<number> {
    let position = 0;
    let lines = 0;
    while (position < byteLength) {
      const chunk = await this.#window(token, position, Math.min(SCAN_CHUNK_BYTES, byteLength - position));
      if (chunk.byteLength === 0) break;
      lines += countLines(chunk);
      position += chunk.byteLength;
    }
    return lines;
  }

  async readTrailingLine(token: string, byteLength: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    if (byteLength === 0) return { bytes: new Uint8Array(), truncated: false };
    if (byteLimit < 1) return { bytes: new Uint8Array(), truncated: true };
    const chunks: Uint8Array[] = [];
    let position = byteLength;
    let total = 0;
    let bounded = false;
    while (position > 0) {
      if (total >= byteLimit) {
        bounded = true;
        break;
      }
      const length = Math.min(SCAN_CHUNK_BYTES, position, byteLimit - total);
      position -= length;
      const bytes = await this.#window(token, position, length);
      const newline = bytes.lastIndexOf(0x0a);
      chunks.unshift(newline >= 0 ? bytes.subarray(newline + 1) : bytes);
      total += bytes.byteLength;
      // A short read means the file shrank underneath us; the bytes in hand start the line.
      if (newline >= 0 || bytes.byteLength < length) return { bytes: join(chunks), truncated: false };
    }
    // Reaching offset zero found the line's true start; stopping at the limit did not.
    return { bytes: join(chunks), truncated: bounded };
  }

  async readRange(token: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    if (byteLength <= 0) return new Uint8Array();
    const first = await this.#window(token, byteOffset, Math.min(BYTES_WINDOW, byteLength));
    if (first.byteLength >= byteLength || first.byteLength < BYTES_WINDOW) return first;
    const parts: Uint8Array[] = [first];
    let total = first.byteLength;
    while (total < byteLength) {
      const part = await this.#window(token, byteOffset + total, Math.min(BYTES_WINDOW, byteLength - total));
      if (part.byteLength === 0) break;
      parts.push(part);
      total += part.byteLength;
    }
    return join(parts);
  }

  async readFrom(token: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    if (byteLimit < 1) return { bytes: new Uint8Array(), truncated: true };
    const info = await this.info(token);
    if (info === undefined) throw new TranscriptFileGone();
    // Sized from the file once: bytes appended after this measurement are left for the next read.
    const bytes = await this.readRange(token, byteOffset, Math.max(0, Math.min(byteLimit, info.size - byteOffset)));
    let truncated = false;
    if (bytes.byteLength === byteLimit) {
      // One byte past the limit separates "the file ends here" from "the cap stopped us".
      truncated = (await this.#window(token, byteOffset + bytes.byteLength, 1)).byteLength > 0;
    }
    return { bytes, truncated };
  }

  /** One handle read, with the failures of a vanished file all spelled as the one the source understands. */
  async #window(token: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = this.#handles.get(token);
    if (handle === undefined) throw new TranscriptFileGone();
    try {
      return await handle.read(offset, length);
    } catch (error) {
      if (isReplaced(error)) throw new TranscriptFileGone();
      throw error;
    }
  }
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
