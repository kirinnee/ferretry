import { describe, it } from 'bun:test';
import should from 'should';
import {
  DocumentExtractionError,
  extractDocxText,
  normalizeExtractedText,
  type RawDeflatePort,
} from '../../../src/lib/index.ts';

const encoder = new TextEncoder();

interface ZipInput {
  readonly name: string;
  readonly text: string;
  readonly flags?: number;
  readonly method?: number;
  /** Bytes stored in the archive when they differ from the plaintext the entry declares. */
  readonly stored?: Uint8Array;
  readonly crc?: number;
}

const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function join(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function zip(entries: readonly ZipInput[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const directories: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const crc = entry.crc ?? crc32(data);
    const flags = entry.flags ?? 0;
    const method = entry.method ?? 0;
    const stored = entry.stored ?? data;
    const local = join(
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(stored.byteLength),
      u32(data.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      stored,
    );
    locals.push(local);
    directories.push(
      join(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(stored.byteLength),
        u32(data.byteLength),
        u16(name.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ),
    );
    offset += local.byteLength;
  }
  const directory = join(...directories);
  return join(
    ...locals,
    directory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.byteLength),
    u32(offset),
    u16(0),
  );
}

const noInflation: RawDeflatePort = {
  inflateRaw(): Uint8Array {
    throw new Error('stored fixture must not need inflation');
  },
};

const contentTypes =
  '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" /></Types>';

describe('DOCX text extraction policy', () => {
  it('should extract normalized Word text and preserve paragraph boundaries', () => {
    // Arrange
    const document = zip([
      { name: '[Content_Types].xml', text: contentTypes },
      {
        name: 'word/document.xml',
        text: '<w:document><w:body><w:p><w:r><w:t> Hello &amp; goodbye </w:t></w:r><w:tab/></w:p><w:p><w:r><w:t>Second</w:t></w:r><w:br/></w:p></w:body></w:document>',
      },
    ]);

    // Act
    const actual = extractDocxText(document, noInflation);

    // Assert
    should(actual).deepEqual({
      method: 'docx-xml',
      text: 'Hello & goodbye\nSecond',
      characters: 22,
      truncated: false,
    });
  });

  it('should bound text without splitting a Unicode surrogate pair', () => {
    // Arrange
    const document = zip([
      { name: '[Content_Types].xml', text: contentTypes },
      {
        name: 'word/document.xml',
        text: '<w:document><w:body><w:p><w:r><w:t>A😀B</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);

    // Act
    const actual = extractDocxText(document, noInflation, { maxCharacters: 2 });

    // Assert
    should(actual).deepEqual({ method: 'docx-xml', text: 'A', characters: 1, truncated: true });
  });

  it('should distinguish locked, empty, and malformed documents', () => {
    // Arrange
    const locked = zip([
      { name: '[Content_Types].xml', text: contentTypes, flags: 1 },
      { name: 'word/document.xml', text: '<w:document><w:body><w:p /></w:body></w:document>' },
    ]);
    const empty = zip([
      { name: '[Content_Types].xml', text: contentTypes },
      { name: 'word/document.xml', text: '<w:document><w:body><w:p /></w:body></w:document>' },
    ]);

    // Act + Assert
    should(() => extractDocxText(locked, noInflation)).throw(DocumentExtractionError, {
      code: 'password_protected_document',
    });
    should(() => extractDocxText(empty, noInflation)).throw(DocumentExtractionError, { code: 'no_extractable_text' });
    should(() => extractDocxText(encoder.encode('not a zip'), noInflation)).throw(DocumentExtractionError, {
      code: 'unreadable_document',
    });
    should(() => extractDocxText(empty, noInflation, { maxCharacters: 0 })).throw(RangeError);
  });

  it('should normalize hostile control characters consistently', () => {
    // Act
    const actual = normalizeExtractedText('  first\r\n\u0000 second \n\n\n third  ');

    // Assert
    should(actual).equal('first\nsecond\n\nthird');
  });
});

const wordDocument = (body: string): string => `<w:document><w:body>${body}</w:body></w:document>`;

function validDocument(
  extra: Partial<ZipInput> = {},
  documentText = wordDocument('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>'),
): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', text: contentTypes, ...extra },
    { name: 'word/document.xml', text: documentText },
  ]);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The fixture archive has no comment, so its end record is always the last 22 bytes. */
function endRecord(bytes: Uint8Array): number {
  return bytes.byteLength - 22;
}

function firstCentralHeader(bytes: Uint8Array): number {
  return view(bytes).getUint32(endRecord(bytes) + 16, true);
}

function expectUnreadable(document: Uint8Array): void {
  should(() => extractDocxText(document, noInflation)).throw(DocumentExtractionError, {
    code: 'unreadable_document',
  });
}

describe('DOCX archive structure policy', () => {
  it('should refuse a multi-disk archive', () => {
    // Arrange
    const document = validDocument();
    view(document).setUint16(endRecord(document) + 4, 1, true);

    // Act + Assert
    expectUnreadable(document);
  });

  it('should refuse a directory whose entry counts disagree', () => {
    // Arrange
    const document = validDocument();
    view(document).setUint16(endRecord(document) + 8, 3, true);

    // Act + Assert
    expectUnreadable(document);
  });

  it('should refuse a ZIP64 entry', () => {
    // Arrange
    const document = validDocument();
    view(document).setUint32(firstCentralHeader(document) + 20, 0xffffffff, true);

    // Act + Assert
    expectUnreadable(document);
  });

  it('should refuse a central header whose comment runs past the directory', () => {
    // Arrange
    const document = validDocument();
    view(document).setUint16(firstCentralHeader(document) + 32, 0xffff, true);

    // Act + Assert
    expectUnreadable(document);
  });

  it('should report an entry that declares more than the extraction limit as too complex', () => {
    // Arrange
    const document = validDocument();
    view(document).setUint32(firstCentralHeader(document) + 24, 2 * 1024 * 1024, true);

    // Act + Assert
    should(() => extractDocxText(document, noInflation)).throw(DocumentExtractionError, {
      code: 'document_too_complex',
    });
  });

  it('should refuse an entry whose checksum does not match its bytes', () => {
    // Arrange
    const document = validDocument({ crc: 1 });

    // Act + Assert
    expectUnreadable(document);
  });

  it('should refuse an entry compressed with an unsupported method', () => {
    // Arrange
    const document = validDocument({ method: 99 });

    // Act + Assert
    expectUnreadable(document);
  });

  it('should hand a deflated entry to the raw-deflate port bounded by the entry limit', () => {
    // Arrange
    const reversed = (text: string): Uint8Array => encoder.encode(text).reverse();
    const document = validDocument({ method: 8, stored: reversed(contentTypes) });
    const calls: { readonly input: readonly number[]; readonly maxOutputBytes: number }[] = [];
    const deflater: RawDeflatePort = {
      inflateRaw(input, maxOutputBytes) {
        calls.push({ input: [...input], maxOutputBytes });
        return input.slice().reverse();
      },
    };

    // Act
    const actual = extractDocxText(document, deflater);

    // Assert
    should(actual.text).equal('Hello');
    should(calls).deepEqual([{ input: [...reversed(contentTypes)], maxOutputBytes: 1024 * 1024 }]);
  });

  it('should refuse a deflated entry whose inflated size is not the declared size', () => {
    // Arrange
    const document = validDocument({ method: 8, stored: new Uint8Array([1, 2, 3]) });
    const deflater: RawDeflatePort = { inflateRaw: () => encoder.encode('short') };

    // Act + Assert
    should(() => extractDocxText(document, deflater)).throw(DocumentExtractionError, {
      code: 'unreadable_document',
    });
  });
});

describe('DOCX XML entity decoding', () => {
  it('should decode named, decimal, and hexadecimal character references', () => {
    // Arrange
    const document = validDocument(
      {},
      wordDocument('<w:p><w:r><w:t>&lt;a&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42; &#x1F600;</w:t></w:r></w:p>'),
    );

    // Act
    const actual = extractDocxText(document, noInflation);

    // Assert
    should(actual.text).equal('<a> "q" \'s\' AB \u{1F600}');
  });

  it('should drop a character reference that is not a Unicode code point', () => {
    // Arrange
    const document = validDocument(
      {},
      wordDocument('<w:p><w:r><w:t>a&#x110000;b&#99999999999999999999;c</w:t></w:r></w:p>'),
    );

    // Act
    const actual = extractDocxText(document, noInflation);

    // Assert
    should(actual.text).equal('abc');
  });
});
