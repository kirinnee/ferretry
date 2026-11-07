export const DEFAULT_MAX_EXTRACTED_CHARACTERS = 250_000;

const MAX_DOCX_CONTENT_TYPES_BYTES = 1024 * 1024;
const MAX_DOCX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
const DOCX_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const CONTROL_CHARACTERS = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]', 'g');

export type TextExtractionMethod = 'docx-xml';

export interface ExtractedDocumentText {
  readonly method: TextExtractionMethod;
  readonly text: string;
  readonly characters: number;
  readonly truncated: boolean;
}

export type DocumentExtractionErrorCode =
  | 'password_protected_document'
  | 'no_extractable_text'
  | 'unreadable_document'
  | 'document_too_complex';

export class DocumentExtractionError extends Error {
  constructor(
    readonly code: DocumentExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

/** The sole binary-compression seam needed by DOCX parsing. */
export interface RawDeflatePort {
  inflateRaw(input: Uint8Array, maxOutputBytes: number): Uint8Array;
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function safePrefix(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  let end = maxCharacters;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractionResult(rawText: string, maxCharacters: number): ExtractedDocumentText {
  const normalized = normalizeExtractedText(rawText);
  const text = safePrefix(normalized, maxCharacters);
  return { method: 'docx-xml', text, characters: text.length, truncated: text.length < normalized.length };
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error('truncated ZIP field');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error('truncated ZIP field');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const first = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= first; offset -= 1) {
    if (readU32(bytes, offset) !== 0x06054b50) continue;
    if (offset + 22 + readU16(bytes, offset + 20) === bytes.byteLength) return offset;
  }
  throw new Error('ZIP central directory is missing');
}

function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const end = findEndOfCentralDirectory(bytes);
  if (readU16(bytes, end + 4) !== 0 || readU16(bytes, end + 6) !== 0)
    throw new Error('multi-disk ZIP files are not supported');
  const entryCount = readU16(bytes, end + 10);
  const centralSize = readU32(bytes, end + 12);
  const centralOffset = readU32(bytes, end + 16);
  if (readU16(bytes, end + 8) !== entryCount || entryCount > 10_000 || centralOffset + centralSize > end)
    throw new Error('invalid ZIP directory');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) throw new Error('invalid ZIP central header');
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const crc = readU32(bytes, offset + 16);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff))
      throw new Error('ZIP64 DOCX files are not supported');
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > centralOffset + centralSize)
      throw new Error('ZIP entry is out of bounds');
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd)).replaceAll('\\', '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error('unsafe ZIP entry name');
    entries.set(name, { name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP central directory size does not match');
  return entries;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function unzipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number, deflater: RawDeflatePort): Uint8Array {
  if ((entry.flags & 1) !== 0)
    throw new DocumentExtractionError('password_protected_document', 'This DOCX needs a password to open');
  if (entry.uncompressedSize > maxBytes)
    throw new DocumentExtractionError('document_too_complex', `DOCX ${entry.name} exceeds the extraction limit`);
  if (readU32(bytes, entry.localOffset) !== 0x04034b50) throw new Error('invalid ZIP local header');
  const start =
    entry.localOffset + 30 + readU16(bytes, entry.localOffset + 26) + readU16(bytes, entry.localOffset + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new Error('ZIP entry data is out of bounds');
  const compressed = bytes.subarray(start, end);
  const output =
    entry.method === 0
      ? compressed.slice()
      : entry.method === 8
        ? deflater.inflateRaw(compressed, maxBytes)
        : undefined;
  if (!output) throw new Error(`unsupported ZIP compression method ${entry.method}`);
  if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc)
    throw new Error('ZIP entry checksum or size does not match');
  return output;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, entity => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
    const decimal = /^&#(\d+);$/.exec(entity);
    const codePoint = Number.parseInt(hex?.[1] ?? decimal?.[1] ?? '', hex ? 16 : 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : '';
  });
}

function wordDocumentText(xml: string): string {
  const parts: string[] = [];
  const tokens = /<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>|<w:tab\b[^>]*\/\s*>|<w:(?:br|cr)\b[^>]*\/\s*>|<\/w:p\s*>/gi;
  for (const token of xml.matchAll(tokens)) {
    if (token[1] !== undefined) parts.push(decodeXmlEntities(token[1]));
    else if (/^<w:tab/i.test(token[0])) parts.push('\t');
    else parts.push('\n');
  }
  return parts.join('');
}

function hasDocxMainContentType(xml: string): boolean {
  const overrides = xml.match(/<(?:[A-Za-z_][\w.-]*:)?Override\b[^>]*>/g) ?? [];
  return overrides.some(
    tag =>
      /\bPartName\s*=\s*(["'])\/word\/document\.xml\1/.test(tag) &&
      new RegExp(
        `\\bContentType\\s*=\\s*(["'])${DOCX_MAIN_CONTENT_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`,
      ).test(tag),
  );
}

/** Validates an OOXML archive and extracts bounded text from word/document.xml only. */
export function extractDocxText(
  input: Uint8Array,
  deflater: RawDeflatePort,
  options: { readonly maxCharacters?: number } = {},
): ExtractedDocumentText {
  const maxCharacters = positiveLimit(options.maxCharacters, DEFAULT_MAX_EXTRACTED_CHARACTERS, 'maxCharacters');
  try {
    const entries = zipEntries(input);
    const contentTypes = entries.get('[Content_Types].xml');
    const documentXml = entries.get('word/document.xml');
    if (!contentTypes || !documentXml) throw new Error('required OOXML entries are missing');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const typesXml = decoder.decode(unzipEntry(input, contentTypes, MAX_DOCX_CONTENT_TYPES_BYTES, deflater));
    if (!hasDocxMainContentType(typesXml)) throw new Error('OOXML main document content type is missing');
    const xml = decoder.decode(unzipEntry(input, documentXml, MAX_DOCX_DOCUMENT_XML_BYTES, deflater));
    if (!/<w:document\b/i.test(xml)) throw new Error('word/document.xml is not a Word document');
    const result = extractionResult(wordDocumentText(xml), maxCharacters);
    if (!result.text) throw new DocumentExtractionError('no_extractable_text', 'DOCX has no extractable text');
    return result;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError('unreadable_document', 'file is not a valid DOCX document');
  }
}
