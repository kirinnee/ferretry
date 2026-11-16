/**
 * A minimal, REAL DOCX, built byte by byte.
 *
 * Stored (compression method 0) rather than deflated, so a fixture proves the archive walk and the
 * Word parse without also depending on a compressor: the inflater is exercised by its own adapter
 * test. Everything the extractor validates is genuine — the end-of-central-directory record, the
 * central headers, the CRCs, the OOXML content-type override — because a fixture the extractor would
 * refuse proves nothing about a start that carries one.
 */

const encoder = new TextEncoder();

interface ZipInput {
  readonly name: string;
  readonly text: string;
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

function concat(...parts: readonly Uint8Array[]): Uint8Array {
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
    const crc = crc32(data);
    const local = concat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.byteLength),
      u32(data.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      data,
    );
    locals.push(local);
    directories.push(
      concat(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.byteLength),
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
  const directory = concat(...directories);
  return concat(
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

const CONTENT_TYPES =
  '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" /></Types>';

/** A DOCX whose single paragraph holds exactly `text`. */
export function docxBytes(text: string): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    {
      name: 'word/document.xml',
      text: `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
}

/** A container that opens like a DOCX and holds no Word document at all. */
export function notADocxBytes(): Uint8Array {
  return zip([{ name: 'readme.txt', text: 'this archive is not a Word document' }]);
}
