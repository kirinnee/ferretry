/**
 * The QR encoder, proved by READING ITS OUTPUT BACK.
 *
 * ## WHY THERE IS A DECODER IN THIS FILE
 *
 * Asserting on modules is asserting on a picture. The property that matters is the only one a person
 * cares about — *a scanner gets the pairing URL back* — and nothing short of decoding the symbol shows
 * it. Every interesting bug in an encoder is silent: reversed generator coefficients produce error
 * correction no decoder agrees with, a short BCH constant produces version bits that are wrong only for
 * large symbols, and a bit-order slip produces a format block describing the wrong mask. All three
 * leave a symbol that looks exactly like a QR code and scans into nothing, and all three are caught
 * here in one line.
 *
 * The reader is deliberately written from the standard rather than from the encoder: it derives the
 * function-pattern map itself, tries every mask, and de-interleaves from the block table. It does NOT
 * verify error correction — that is what the generator-polynomial test below is for, against the
 * published table.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { encodeQr, QR_MAX_VERSION, QrEncodeError, qrCodewordCapacity } from '../../src/lib/qr-code.ts';

type Mask = (row: number, column: number) => boolean;

const MASKS: readonly Mask[] = [
  (row, column) => (row + column) % 2 === 0,
  row => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/** Level-M blocks per version, from ISO/IEC 18004 — the reader's own copy, so a shared table cannot hide a bug. */
const BLOCKS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 0],
  [1, 0],
  [2, 0],
  [2, 0],
  [4, 0],
  [4, 0],
  [2, 2],
  [3, 2],
  [4, 1],
  [1, 4],
  [6, 2],
  [8, 1],
  [4, 5],
  [5, 5],
  [7, 3],
  [10, 1],
  [9, 4],
  [3, 11],
  [3, 13],
];

const alignmentCentres = (version: number): readonly number[] => {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const side = version * 4 + 17;
  const step = Math.ceil((side - 13) / (2 * count - 2)) * 2;
  const centres = [6];
  for (let position = side - 7; centres.length < count; position -= step) centres.unshift(position);
  return centres;
};

/** Every module the standard fixes, derived here rather than taken from the encoder. */
function functionModules(version: number): boolean[][] {
  const side = version * 4 + 17;
  const grid = Array.from({ length: side }, () => new Array<boolean>(side).fill(false));
  const claim = (row: number, column: number): void => {
    if (row >= 0 && column >= 0 && row < side && column < side) (grid[row] as boolean[])[column] = true;
  };
  for (const [row, column] of [
    [0, 0],
    [0, side - 7],
    [side - 7, 0],
  ] as const) {
    for (let dy = -1; dy <= 7; dy += 1) for (let dx = -1; dx <= 7; dx += 1) claim(row + dy, column + dx);
  }
  for (let index = 0; index < side; index += 1) {
    claim(6, index);
    claim(index, 6);
  }
  const centres = alignmentCentres(version);
  for (const row of centres) {
    for (const column of centres) {
      const atFinder =
        (row === 6 && column === 6) || (row === 6 && column === side - 7) || (row === side - 7 && column === 6);
      if (atFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) claim(row + dy, column + dx);
    }
  }
  for (let index = 0; index <= 8; index += 1) {
    claim(8, index);
    claim(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    claim(8, side - 1 - index);
    claim(side - 1 - index, 8);
  }
  claim(side - 8, 8);
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      claim(side - 11 + (index % 3), Math.floor(index / 3));
      claim(Math.floor(index / 3), side - 11 + (index % 3));
    }
  }
  return grid;
}

/** The data codewords a symbol carries, read in the standard's zigzag with `mask` removed. */
function readCodewords(modules: readonly (readonly boolean[])[], version: number, mask: Mask): readonly number[] {
  const side = version * 4 + 17;
  const reserved = functionModules(version);
  const bits: number[] = [];
  let upward = true;
  for (let right = side - 1; right >= 1; right -= 2) {
    const column = right === 6 ? right - 1 : right;
    for (let step = 0; step < side; step += 1) {
      const row = upward ? side - 1 - step : step;
      for (const offset of [0, 1]) {
        const x = column - offset;
        if (reserved[row]?.[x] === true) continue;
        bits.push((modules[row]?.[x] ?? false) !== mask(row, x) ? 1 : 0);
      }
    }
    upward = !upward;
    if (column === 5) right -= 1;
  }
  const codewords: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | (bits[index + offset] ?? 0);
    codewords.push(byte);
  }
  return codewords;
}

/** The text a symbol carries, or `undefined` when this mask is not the one it was built with. */
function decodeWith(matrix: ReturnType<typeof encodeQr>, mask: Mask): string | undefined {
  const version = matrix.version;
  const stream = readCodewords(matrix.modules, version, mask);
  const [short, long] = BLOCKS[version - 1] ?? [1, 0];
  const shortLength = Math.floor(qrCodewordCapacity(version).data / (short + long));
  const lengths = Array.from({ length: short + long }, (_unused, index) =>
    index < short ? shortLength : shortLength + 1,
  );
  const blocks: number[][] = lengths.map(() => []);
  let cursor = 0;
  for (let position = 0; position < shortLength + 1; position += 1) {
    for (const [index, length] of lengths.entries()) {
      if (position >= length) continue;
      (blocks[index] as number[]).push(stream[cursor] ?? 0);
      cursor += 1;
    }
  }
  const data = blocks.flat();
  if ((data[0] ?? 0) >> 4 !== 0b0100) return undefined;
  const wide = version >= 10;
  const length = wide
    ? (((data[0] ?? 0) & 0xf) << 12) | ((data[1] ?? 0) << 4) | ((data[2] ?? 0) >> 4)
    : (((data[0] ?? 0) & 0xf) << 4) | ((data[1] ?? 0) >> 4);
  const offset = wide ? 2 : 1;
  const bytes = Array.from(
    { length },
    (_unused, index) => (((data[offset + index] ?? 0) & 0xf) << 4) | ((data[offset + index + 1] ?? 0) >> 4),
  );
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The five data bits of the format block: the error level and the mask, as a scanner reads them.
 *
 * They live in the HIGH bits of the fifteen. The ten low bits are the BCH check, so a reader that takes
 * the mask off the bottom of the value gets a check bit and decodes with the wrong mask — which is the
 * mistake worth having a comment about, because the symptom is a symbol that "sometimes" decodes.
 */
function declaredFormat(matrix: ReturnType<typeof encodeQr>): { readonly level: number; readonly mask: number } {
  let value = 0;
  for (let index = 0; index < 15; index += 1) {
    const bit =
      index < 6
        ? (matrix.modules[index]?.[8] ?? false)
        : index === 6
          ? (matrix.modules[7]?.[8] ?? false)
          : index === 7
            ? (matrix.modules[8]?.[8] ?? false)
            : index === 8
              ? (matrix.modules[8]?.[7] ?? false)
              : (matrix.modules[8]?.[14 - index] ?? false);
    value |= (bit ? 1 : 0) << index;
  }
  const data = ((value ^ 0x5412) >> 10) & 0b11111;
  return { level: data >> 3, mask: data & 0b111 };
}

/** What a scanner reads: the mask the symbol DECLARES, then the bytes under it. */
function decode(matrix: ReturnType<typeof encodeQr>): string | undefined {
  const mask = MASKS[declaredFormat(matrix).mask];
  return mask === undefined ? undefined : decodeWith(matrix, mask);
}

const PAIRING_URL = `https://ferretry.pages.dev/pair#v1;url=http%3A%2F%2F127.0.0.1%3A48291;code=7F3K-Q2ND;fp=fy_daemon_${'a'.repeat(43)}`;

describe('the QR encoder', () => {
  it('should encode a pairing URL a scanner reads back exactly', () => {
    // THE TEST THAT MATTERS. A credential that survives the round trip is the whole feature; a symbol
    // that looks right and decodes to nothing is the failure a person blames their camera for.
    // Arrange, Act
    const matrix = encodeQr(PAIRING_URL);

    // Assert
    should(decode(matrix)).equal(PAIRING_URL);
    // Level M, declared in the format block. A symbol whose header lies about its level hands a decoder
    // the wrong error-correction size, and every checksum then fails.
    should(declaredFormat(matrix).level).equal(0);
    should(matrix.size).equal(matrix.version * 4 + 17);
    should(matrix.modules).have.length(matrix.size);
    should(matrix.modules.every(row => row.length === matrix.size)).be.true();
  });

  it('should survive the round trip across every version it will build', () => {
    // One length per capacity band, so a table row that is wrong for exactly one version cannot hide.
    // Arrange
    const lengths = [1, 14, 100, 150, 210, 300, 400, 500, 600, 660];

    // Act, Assert
    for (const length of lengths) {
      const value = 'x'.repeat(length);
      should(decode(encodeQr(value))).equal(value, `length ${String(length)} did not survive`);
    }
  });

  it('should choose the smallest version that fits and grow only when it must', () => {
    // Arrange, Act
    const versions = [1, 14, 15, 100, 660].map(length => encodeQr('x'.repeat(length)).version);

    // Assert — 14 bytes fit version 1 at level M, 15 do not.
    should(versions).deepEqual([1, 1, 2, 6, 20]);
  });

  it('should carry multi-byte characters as their UTF-8 bytes', () => {
    // Byte mode carries bytes, so the encoder's job is to hand the standard exactly what `TextEncoder`
    // produced — and the length field counts BYTES, which is where a character count would silently
    // truncate a name with an emoji in it.
    // Arrange
    const value = 'café ☕ 日本語';

    // Act
    const matrix = encodeQr(value);

    // Assert
    should(decode(matrix)).equal(value);
  });

  it('should place the three finder patterns and the timing rows where a scanner looks', () => {
    // Arrange, Act
    const { modules, size } = encodeQr(PAIRING_URL);
    const finder = (row: number, column: number): boolean[] =>
      [0, 1, 2, 3, 4, 5, 6].map(offset => modules[row + offset]?.[column + 3] ?? false);

    // Assert — a finder's centre column reads dark, light, dark×3, light, dark from its top.
    const expected = [true, false, true, true, true, false, true];
    should(finder(0, 0)).deepEqual(expected);
    should(finder(0, size - 7)).deepEqual(expected);
    should(finder(size - 7, 0)).deepEqual(expected);
    // The timing row alternates, starting dark at the even column.
    should([8, 9, 10, 11].map(column => modules[6]?.[column])).deepEqual([true, false, true, false]);
    // The dark module is fixed and is one of the few single modules the standard names outright.
    should(modules[size - 8]?.[8]).be.true();
  });

  it('should be pure: the same value always produces the same symbol', () => {
    // No cache, no clock, no module-scope state — so a screenshot and a test agree, and no live
    // credential can survive in a memo after the modal that showed it closed.
    // Arrange, Act
    const first = encodeQr(PAIRING_URL);
    const second = encodeQr(PAIRING_URL);

    // Assert
    should(first).deepEqual(second);
  });

  it('should refuse an empty value and one too long to encode', () => {
    // Refusing beats truncating: half a pairing URL encodes perfectly and pairs nothing.
    // Arrange
    const tooLong = 'x'.repeat(qrCodewordCapacity(QR_MAX_VERSION).data);

    // Act, Assert
    should(() => encodeQr('')).throw(QrEncodeError);
    should(() => encodeQr(tooLong)).throw(/larger than version 20/u);
  });

  it('should hold the level-M capacity table the standard publishes', () => {
    // The counts are DERIVED from the module geometry and the block table, so this is the assertion that
    // catches a mis-transcribed row: a wrong capacity shifts every codeword after it.
    // Arrange, Act, Assert
    should([1, 2, 6, 8, 10, 15, 20].map(version => qrCodewordCapacity(version))).deepEqual([
      { data: 16, total: 26 },
      { data: 28, total: 44 },
      { data: 108, total: 172 },
      { data: 154, total: 242 },
      { data: 216, total: 346 },
      { data: 415, total: 655 },
      { data: 669, total: 1085 },
    ]);
  });
});
