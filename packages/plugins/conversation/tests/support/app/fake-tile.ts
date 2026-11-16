import { deflateSync } from 'node:zlib';

/**
 * A 256x256 map tile made in memory, so a test that draws a map never reaches a real tile server. It is a
 * pale land colour with a soft grid and a lighter "water" band, which is enough to tell a drawn map from a
 * blank one in a screenshot. Nothing here is a copy of any provider's artwork.
 */

const TILE_SIZE = 256;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

const pixel = (x: number, y: number): readonly [number, number, number] => {
  if (x % 64 === 32 || y % 64 === 32) return [214, 207, 192];
  if (y > 150 && y < 200) return [170, 205, 232];
  return [236, 232, 220];
};

export const fakeTilePng = (): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, TILE_SIZE);
  view.setUint32(4, TILE_SIZE);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = new Uint8Array(TILE_SIZE * (1 + TILE_SIZE * 3));
  for (let y = 0; y < TILE_SIZE; y += 1) {
    const at = y * (1 + TILE_SIZE * 3);
    for (let x = 0; x < TILE_SIZE; x += 1) rows.set(pixel(x, y), at + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
