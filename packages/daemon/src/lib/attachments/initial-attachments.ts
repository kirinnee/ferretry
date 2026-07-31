import { basename, join } from 'node:path';
import {
  DocumentExtractionError,
  extractDocxText,
  type ExtractedDocumentText,
  type RawDeflatePort,
} from './document-extraction.ts';

/**
 * The attachments a START carries, decided before anything touches a disk.
 *
 * `initialAttachments` arrives INLINE as base64 inside the start body — it is not the multipart
 * upload route, and it needs neither a byte reader on the transport nor an attachment id, because
 * the bytes are already in the request and the only place they are spent is the turn-one document
 * this start is about to write. That is what makes the extractor reachable from a mounted route:
 * `fy start -f report.docx` describes the file as part of the OPENING MESSAGE, so the agent has to
 * be handed it at the same moment it is handed its task.
 *
 * The bounds here are the daemon's, not the protocol's: `StartSessionRequestSchema` puts no ceiling
 * on how many attachments a start may carry or how large one may be, and the start body is buffered
 * in memory before it is parsed. A refusal naming the limit is the honest answer; silently truncating
 * would start an agent whose task refers to a file that is not there.
 */

/** More files than this in one opening message is a caller mistake, not a large task. */
export const MAX_INITIAL_ATTACHMENTS = 16;

/** Per file, decoded. Comfortably above any document a human attaches and far below the point at
 *  which buffering the start body threatens the daemon. */
export const MAX_INITIAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** The local ZIP signature every OOXML container begins with. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;

export type InitialAttachmentRefusal =
  /** More attachments than one opening message may carry. */
  | 'too_many'
  /** One attachment is larger than the decoded ceiling. */
  | 'too_large'
  /** The filename would escape the attachment directory, or names nothing. */
  | 'unsafe_filename'
  /** The payload is not decodable base64, or decodes to nothing. */
  | 'undecodable';

/** A start that cannot be served as asked, in a taxonomy the mount restates as HTTP. */
export class InitialAttachmentError extends Error {
  constructor(
    readonly refusal: InitialAttachmentRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'InitialAttachmentError';
  }
}

/**
 * The ceilings, overridable.
 *
 * Injected the same way `extractDocxText` takes `maxCharacters`: the numbers are this deployment's
 * answer rather than the domain's, and a test that had to allocate 32 MiB to prove the refusal would
 * be measuring the machine it runs on.
 */
export interface InitialAttachmentLimits {
  readonly maxAttachments?: number;
  readonly maxBytes?: number;
}

/** One attachment exactly as the protocol states it. */
export interface InitialAttachmentRequest {
  readonly filename: string;
  readonly mime?: string | undefined;
  readonly base64: string;
}

/** One attachment as this daemon will store it. */
export interface DecodedInitialAttachment {
  /** A bare filename, safe to join onto a directory. */
  readonly filename: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
  /**
   * Whether text extraction is worth attempting. The CLI states a mime only for images — "a
   * document's type is decided by the daemon's extractor" — so the decision is made from the bytes
   * and the name rather than from a type the caller may never have sent.
   */
  readonly extractable: boolean;
}

/** What the caller is told when no mime was stated and the bytes are not an image. */
const DEFAULT_MIME = 'application/octet-stream';

/** A filename that cannot leave the directory it is written into, or a refusal. */
export function safeAttachmentFilename(filename: string): string {
  const trimmed = filename.trim();
  const bare = basename(trimmed.replaceAll('\\', '/'));
  if (bare === '' || bare === '.' || bare === '..' || bare.includes('/') || bare.includes('\0')) {
    throw new InitialAttachmentError(
      'unsafe_filename',
      `attachment filename ${JSON.stringify(filename)} is not a plain file name`,
    );
  }
  return bare;
}

function decodeBase64(text: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function looksLikeOoxml(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * One stated attachment, decoded and bounded.
 *
 * An image is never handed to the extractor: `extractDocxText` would refuse it as an unreadable
 * document, and reporting "this PNG is not a valid DOCX" beside a file the agent can open perfectly
 * well is noise dressed as a failure.
 */
export function decodeInitialAttachment(
  request: InitialAttachmentRequest,
  limits: InitialAttachmentLimits = {},
): DecodedInitialAttachment {
  const maxBytes = limits.maxBytes ?? MAX_INITIAL_ATTACHMENT_BYTES;
  const filename = safeAttachmentFilename(request.filename);
  const bytes = decodeBase64(request.base64);
  if (bytes === undefined || bytes.byteLength === 0) {
    throw new InitialAttachmentError('undecodable', `attachment ${filename} is not decodable base64 content`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new InitialAttachmentError(
      'too_large',
      `attachment ${filename} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit`,
    );
  }
  const stated = request.mime?.trim() ?? '';
  const mime = stated === '' ? DEFAULT_MIME : stated;
  const image = mime.startsWith('image/');
  return {
    filename,
    mime,
    bytes,
    extractable: !image && (filename.toLowerCase().endsWith('.docx') || looksLikeOoxml(bytes)),
  };
}

/** Every stated attachment, decoded, or the first refusal among them. */
export function decodeInitialAttachments(
  requests: readonly InitialAttachmentRequest[],
  limits: InitialAttachmentLimits = {},
): readonly DecodedInitialAttachment[] {
  const maxAttachments = limits.maxAttachments ?? MAX_INITIAL_ATTACHMENTS;
  if (requests.length > maxAttachments) {
    throw new InitialAttachmentError(
      'too_many',
      `a start may carry at most ${maxAttachments} attachments; this one carries ${requests.length}`,
    );
  }
  return requests.map(request => decodeInitialAttachment(request, limits));
}

/** Text lifted out of an attachment, and where it will be written. */
export interface AttachmentExtractionDelivery {
  readonly file: string;
  readonly characters: number;
  readonly truncated: boolean;
}

/** Why an attachment the daemon tried to read yielded no text. */
export interface AttachmentExtractionRefusal {
  readonly code: string;
  readonly message: string;
}

/** One attachment as the agent will find it: on disk, at an absolute path. */
export interface StoredInitialAttachment {
  readonly filename: string;
  readonly mime: string;
  readonly bytes: number;
  readonly file: string;
  readonly extraction?: AttachmentExtractionDelivery | undefined;
  readonly extractionFailure?: AttachmentExtractionRefusal | undefined;
}

function attachmentLines(attachment: StoredInitialAttachment): readonly string[] {
  const head = `- \`${attachment.filename}\` — ${attachment.mime}, ${attachment.bytes} bytes — ${attachment.file}`;
  if (attachment.extraction !== undefined) {
    const truncation = attachment.extraction.truncated ? ', truncated at the extraction limit' : '';
    return [
      head,
      `  - extracted text: ${attachment.extraction.file} (${attachment.extraction.characters} characters${truncation})`,
    ];
  }
  if (attachment.extractionFailure !== undefined) {
    const { code, message } = attachment.extractionFailure;
    return [head, `  - no text could be extracted (${code}): ${message}`];
  }
  return [head];
}

/** One file the start must put on disk before it hands the agent a document that names it. */
export interface PlannedAttachmentFile {
  readonly file: string;
  readonly contents: Uint8Array | string;
}

/** Everything an opening message's attachments amount to: what the agent is told, and what must
 *  exist by the time it is told it. */
export interface PlannedInitialAttachments {
  readonly delivered: readonly StoredInitialAttachment[];
  readonly files: readonly PlannedAttachmentFile[];
}

/**
 * The whole attachment decision, taken in memory.
 *
 * NOTHING HERE TOUCHES A DISK, and that is what makes the ordering work. A session's directory
 * belongs to storage — it refuses to adopt one that already holds files it did not put there — so
 * the start cannot write an attachment until the session record exists, and it cannot write the
 * session record until it knows the opening message, which names the attachments. Deciding
 * everything first breaks the cycle: extraction is a pure function over bytes already in the request,
 * so the paths, the character counts and the refusals are all knowable before the first write.
 */
export function planInitialAttachments(
  attachments: readonly DecodedInitialAttachment[],
  directory: string,
  deflater: RawDeflatePort,
): PlannedInitialAttachments {
  const delivered: StoredInitialAttachment[] = [];
  const files: PlannedAttachmentFile[] = [];
  for (const attachment of attachments) {
    const file = join(directory, attachment.filename);
    files.push({ file, contents: attachment.bytes });
    const base = { filename: attachment.filename, mime: attachment.mime, bytes: attachment.bytes.byteLength, file };
    if (!attachment.extractable) {
      delivered.push(base);
      continue;
    }
    const extracted = extractText(attachment.bytes, deflater);
    if ('code' in extracted) {
      delivered.push({ ...base, extractionFailure: extracted });
      continue;
    }
    const textFile = `${file}.txt`;
    files.push({ file: textFile, contents: extracted.text });
    delivered.push({
      ...base,
      extraction: { file: textFile, characters: extracted.characters, truncated: extracted.truncated },
    });
  }
  return { delivered, files };
}

/**
 * The text in a document, or why there is none.
 *
 * A refusal is never a failed start: a document this daemon cannot read is still a document the
 * agent can open, so the reason travels into the opening message beside the file rather than
 * replacing it. `extractDocxText` states every refusal it makes in its own taxonomy; the fallback
 * covers a throw from anywhere else and keeps the attachment deliverable either way.
 */
function extractText(bytes: Uint8Array, deflater: RawDeflatePort): ExtractedDocumentText | AttachmentExtractionRefusal {
  try {
    return extractDocxText(bytes, deflater);
  } catch (error) {
    const stated = error instanceof DocumentExtractionError ? error : undefined;
    return { code: stated?.code ?? 'unreadable_document', message: stated?.message ?? String(error) };
  }
}

/**
 * The section appended to the opening message, naming every attachment by absolute path.
 *
 * Paths rather than content, for the same reason turn one is a FILE the agent is told to open rather
 * than a payload typed into a pane: a document of any size survives, and the assignment stays a
 * document instead of becoming a transcript of one. Extracted text is written beside the original
 * so an agent whose harness cannot read a binary still has the words.
 */
export function renderInitialAttachmentSection(attachments: readonly StoredInitialAttachment[]): string {
  if (attachments.length === 0) return '';
  const count = attachments.length === 1 ? 'one file' : `${attachments.length} files`;
  return [
    '',
    '## Attachments',
    '',
    `This assignment came with ${count}, stored beside this document. Open them by path.`,
    '',
    ...attachments.flatMap(attachment => attachmentLines(attachment)),
    '',
  ].join('\n');
}
