/**
 * AN IMAGE OF A SESSION'S TRANSCRIPT, FOUND FROM A HANDLE AND PROVED BEFORE IT IS SERVED.
 *
 * The log renderer prints `[fy-image <handle> <type>]` where an image was, and a chat asks for that
 * handle back (`@ferretry/protocol`'s `transcript-images.ts`). A handle is only a record's offset and
 * length plus an ordinal, written by whoever asks — so nothing in it is trusted. This reader turns it
 * back into bytes in the one order that never lets a caller point at arbitrary bytes of the file:
 *
 * 1. the handle parses (a 400 otherwise);
 * 2. the record's own bytes are read — with the byte before and the byte after — and the offset must be
 *    a record START (file start or after a `\n`) and the end a record END (a `\n`), inside the file;
 * 3. ONLY that record is parsed, by the session's own harness parser, which is the one owner of what a
 *    record's events are; the handle must name exactly one record that parser emitted, and the image is
 *    the one `recordImages` numbers at that ordinal — the same call the log renderer made;
 * 4. the image's base64 is the parser's `data`, or a `dataRef` that must lie INSIDE that record (a
 *    transcript can forge the placeholder a reference is made from), and its real type is read from its
 *    first bytes: whatever the transcript called it, only a PNG, JPEG, GIF or WebP is served.
 *
 * Every refusal is a code and a sentence with no path in it.
 *
 * WHAT IS REMEMBERED is only the proof, never the bytes: where the base64 lies, what it is and how
 * large, under the transcript file's fingerprint (size and modification time, as `TranscriptTailCache`
 * does). A re-read of a handle skips steps 2 and 3, and a rewritten file never matches the old proof.
 */
import { createHash } from 'node:crypto';
import {
  formatTranscriptImageHandle,
  parseTranscriptImageHandle,
  type TranscriptImageDownload,
  type TranscriptImageHandle,
  type TranscriptImageMediaType,
} from '@ferretry/protocol';
import { inspectImageBase64 } from '../../transcript/image-bytes.ts';
import { recordImages } from '../../transcript/images.ts';
import type { SlicedTranscriptInput } from '../../transcript/sliced.ts';
import type { TranscriptBytesRef, TranscriptParseResult } from '../../transcript/types.ts';

export type TranscriptImageFailure =
  | 'invalid_image_handle'
  | 'no_transcript'
  | 'transcript_unreadable'
  | 'image_not_found'
  | 'unsupported_image';

/** A refusal with its code; the mount restates it in HTTP. */
export class TranscriptImageError extends Error {
  constructor(
    readonly failure: TranscriptImageFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptImageError';
  }
}

/** The transcript file a session's handles name, and which harness wrote it. */
export interface TranscriptImageTarget {
  readonly file: string;
  readonly harness: 'claude' | 'codex';
}

export interface TranscriptImageLocator {
  /** The proved transcript of `sessionId`, or `undefined` when it has none. */
  locate(sessionId: string): Promise<TranscriptImageTarget | undefined>;
}

export interface TranscriptImageFiles {
  /** The file's size and modification time, or `undefined` when it cannot be read. */
  fingerprint(file: string): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>;
  /** At most `byteLength` bytes from `byteOffset`; fewer only when the file ends first. */
  readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array>;
}

export interface TranscriptImageParser {
  parse(input: SlicedTranscriptInput): Promise<TranscriptParseResult>;
}

export interface TranscriptImageLookup {
  /** A strong validator: this session, this handle, this size. Never the bytes. */
  readonly etag: string;
  readonly image: TranscriptImageDownload['image'];
  download(): Promise<TranscriptImageDownload>;
}

/** Where the proved base64 lies: a byte range of the file, or a short string already in hand. */
type ProvedSource =
  | { readonly kind: 'ref'; readonly ref: TranscriptBytesRef }
  | { readonly kind: 'inline'; readonly base64: string };

interface Proof {
  readonly mediaType: TranscriptImageMediaType;
  readonly byteLength: number;
  readonly source: ProvedSource;
}

/** How many handles' proofs are remembered; the least recently asked-for goes first. */
export const TRANSCRIPT_IMAGE_PROOF_CAPACITY = 128;
/** An inline image longer than this is proved again rather than held: it is not worth the memory. */
export const TRANSCRIPT_IMAGE_INLINE_KEEP_CHARS = 256 * 1024;
/** How many records are read and parsed at once, daemon-wide. */
export const TRANSCRIPT_IMAGE_CONCURRENCY = 2;

const LINE_FEED = 0x0a;

const refuse = (failure: TranscriptImageFailure, message: string): never => {
  throw new TranscriptImageError(failure, message);
};

const NOT_FOUND = 'the session has no image at that handle';

/** A strong validator for one image of one session; it holds no bytes of it. */
const imageTag = (sessionId: string, handle: string, byteLength: number): string =>
  `"${createHash('sha256').update(`${sessionId}\u0000${handle}\u0000${byteLength}`).digest('base64url')}"`;

export class TranscriptImageReader {
  readonly #proofs = new Map<string, Proof>();
  readonly #waiting: Array<() => void> = [];
  #running = 0;

  constructor(
    private readonly locator: TranscriptImageLocator,
    private readonly files: TranscriptImageFiles,
    private readonly parsers: Readonly<Record<'claude' | 'codex', TranscriptImageParser>>,
    private readonly capacity: number = TRANSCRIPT_IMAGE_PROOF_CAPACITY,
    private readonly concurrency: number = TRANSCRIPT_IMAGE_CONCURRENCY,
  ) {}

  /** The image `handleText` names in `sessionId`'s transcript, proved; every refusal is a {@link TranscriptImageError}. */
  async lookup(sessionId: string, handleText: string): Promise<TranscriptImageLookup> {
    const handle = parseTranscriptImageHandle(handleText);
    if (handle === undefined) return refuse('invalid_image_handle', 'the image handle is not usable');
    const name = formatTranscriptImageHandle(handle);

    const target = await this.locator.locate(sessionId);
    if (target === undefined) return refuse('no_transcript', `session ${sessionId} has no transcript to read`);
    const fingerprint = await this.files.fingerprint(target.file).catch(() => undefined);
    if (fingerprint === undefined)
      return refuse('transcript_unreadable', `session ${sessionId} has a transcript this daemon could not read`);

    const key = `${sessionId}\u0000${target.file}\u0000${fingerprint.size}\u0000${fingerprint.mtimeMs}\u0000${name}`;
    const remembered = this.#proofs.get(key);
    if (remembered !== undefined) {
      this.#proofs.delete(key);
      this.#proofs.set(key, remembered);
      return this.#lookupFor(sessionId, name, target, remembered);
    }

    const proof = await this.#exclusive(async () => await this.#prove(sessionId, handle, target, fingerprint.size));
    // An inline image too large to be worth the memory is served now and proved again if asked again.
    if (proof.source.kind === 'ref' || proof.source.base64.length <= TRANSCRIPT_IMAGE_INLINE_KEEP_CHARS)
      this.#remember(key, proof);
    return this.#lookupFor(sessionId, name, target, proof);
  }

  #lookupFor(sessionId: string, name: string, target: TranscriptImageTarget, proof: Proof): TranscriptImageLookup {
    return {
      etag: imageTag(sessionId, name, proof.byteLength),
      image: { handle: name, mediaType: proof.mediaType, byteLength: proof.byteLength },
      download: async () => ({
        image: { handle: name, mediaType: proof.mediaType, byteLength: proof.byteLength },
        base64: await this.#base64(target, proof),
      }),
    };
  }

  /** The proved base64 again — read from the file for a reference, in hand for an inline image. */
  async #base64(target: TranscriptImageTarget, proof: Proof): Promise<string> {
    if (proof.source.kind === 'inline') return proof.source.base64;
    const { byteOffset, byteLength } = proof.source.ref;
    const bytes = await this.files.readRange(target.file, byteOffset, byteLength).catch(() => undefined);
    const again = bytes === undefined || bytes.byteLength !== byteLength ? undefined : await inspectImageBase64(bytes);
    if (again === undefined || again.byteLength !== proof.byteLength) return refuse('image_not_found', NOT_FOUND);
    return again.base64;
  }

  #remember(key: string, proof: Proof): void {
    this.#proofs.set(key, proof);
    while (this.#proofs.size > this.capacity) {
      const oldest = this.#proofs.keys().next();
      if (oldest.done === true) return;
      this.#proofs.delete(oldest.value);
    }
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= this.concurrency) await new Promise<void>(resolve => this.#waiting.push(resolve));
    this.#running += 1;
    try {
      return await work();
    } finally {
      this.#running -= 1;
      this.#waiting.shift()?.();
    }
  }

  async #prove(
    sessionId: string,
    handle: TranscriptImageHandle,
    target: TranscriptImageTarget,
    fileSize: number,
  ): Promise<Proof> {
    const { recordOffset, recordLength, ordinal } = handle;
    // The record, its newline, and the byte before it — which together prove it is a whole line.
    if (recordOffset + recordLength + 1 > fileSize) return refuse('image_not_found', NOT_FOUND);
    const lead = recordOffset > 0 ? 1 : 0;
    const wanted = lead + recordLength + 1;
    const read = await this.files.readRange(target.file, recordOffset - lead, wanted).catch(() => undefined);
    if (read === undefined)
      return refuse('transcript_unreadable', `session ${sessionId}'s transcript could not be read`);
    if (read.byteLength !== wanted) return refuse('image_not_found', NOT_FOUND);
    if (lead === 1 && read[0] !== LINE_FEED) return refuse('image_not_found', NOT_FOUND);
    if (read[wanted - 1] !== LINE_FEED) return refuse('image_not_found', NOT_FOUND);

    // The record with its terminator: only a terminated record has its big strings referenced.
    const record = read.subarray(lead);
    const parsed = await this.parsers[target.harness]
      .parse({ bytes: record, startByteOffset: recordOffset, endOfInput: true, sessionId })
      .catch(() => undefined);
    if (parsed === undefined || parsed.rawRecords?.length !== 1) return refuse('image_not_found', NOT_FOUND);
    const events = parsed.events.filter(
      event => event.byteOffset === recordOffset && event.byteLength === recordLength,
    );
    const image = recordImages(events).find(candidate => candidate.handle.ordinal === ordinal);
    if (image === undefined) return refuse('image_not_found', NOT_FOUND);

    let inspected: Awaited<ReturnType<typeof inspectImageBase64>>;
    let source: ProvedSource;
    if (image.dataRef !== undefined) {
      const { byteOffset, byteLength } = image.dataRef;
      if (byteOffset < recordOffset || byteOffset + byteLength > recordOffset + recordLength)
        return refuse('image_not_found', NOT_FOUND);
      const start = byteOffset - recordOffset;
      inspected = await inspectImageBase64(record.subarray(start, start + byteLength));
      source = { kind: 'ref', ref: image.dataRef };
    } else {
      inspected = image.data === undefined ? undefined : await inspectImageBase64(image.data);
      source = { kind: 'inline', base64: inspected?.base64 ?? '' };
    }
    if (inspected === undefined)
      return refuse('unsupported_image', 'that part of the transcript is not a supported image');
    return { mediaType: inspected.mediaType, byteLength: inspected.byteLength, source };
  }
}
