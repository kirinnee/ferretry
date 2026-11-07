/**
 * A QR encoder, in this bundle, on purpose.
 *
 * ## WHY THIS IS NOT A DEPENDENCY AND NEVER AN IMAGE SERVICE
 *
 * What goes into this function is a PAIRING URL, and that URL carries a live single-use credential for
 * somebody's machine. Handing it to `api.qrserver.com` — or to any encoder that fetches — would hand a
 * stranger the credential, and the reader would have no way to know. There is no such thing as a
 * trusted third party for this input, so the encoding happens here, offline, in the tab that already
 * legitimately holds the code.
 *
 * A published package would have been the ordinary choice, and it is refused for a narrower reason:
 * every visitor downloads the whole bundle, this needs one mode and one error level, and a QR encoder
 * is a finite, closed, testable algorithm from a published standard. So it is ~200 lines that never
 * change rather than a dependency this product has to keep trusting.
 *
 * ## WHAT IT IS AND IS NOT
 *
 * BYTE MODE ONLY, error level M. A pairing URL is mixed-case with punctuation, so alphanumeric mode
 * cannot carry it and numeric mode is irrelevant; and M is the level printed QR codes use — 15%
 * recoverable, which is what survives a phone camera at an angle in bad light. Neither is a parameter,
 * because a caller choosing between them would be choosing without knowing.
 *
 * VERSIONS 1 THROUGH 20, which carries 666 bytes at level M — four times what the ~160-character
 * pairing URL needs, and the ceiling is there because a bigger symbol is a denser symbol and a phone
 * has to read this one off a screen. Anything longer is refused rather than silently truncated: half a
 * credential encodes perfectly and scans into nonsense.
 *
 * PURE AND TOTAL, and there is no module-scope state of any kind — the two Galois-field tables are
 * built per call, which costs 512 iterations and buys a function whose output depends on nothing but
 * its argument. Nothing here reads a clock, a global, or the DOM, so the matrix a test asserts on is
 * the matrix a phone reads.
 *
 * THE CODE IS NEVER RETAINED. This module holds nothing: no cache keyed by input, no last-result
 * memo. A memo would be a copy of a live credential living in module scope for the rest of the tab's
 * life, which is precisely what the pairing surface is careful not to do.
 */

/** Error level M: 15% of the symbol recoverable, the level printed codes use. */
const ERROR_LEVEL_M = 0;

/** How many data codewords level M leaves for versions 1…20, and how error correction is grouped. */
interface VersionSpec {
  /** Total error-correction codewords per block. */
  readonly eccPerBlock: number;
  /** Blocks in group 1, then group 2; group 2's blocks each hold one extra data codeword. */
  readonly blocks: readonly [number, number];
}

/**
 * The level-M block structure per version, straight from ISO/IEC 18004 table 13-22.
 *
 * A TABLE AND NOT A DERIVATION, because there is no formula: these counts are chosen by the standard.
 * Copying them is the only correct implementation, and getting one wrong produces a symbol that
 * encodes cleanly and cannot be read — which is why the tests assert against decoded fixtures rather
 * than against this table.
 */
const VERSION_SPECS: readonly VersionSpec[] = [
  { eccPerBlock: 10, blocks: [1, 0] },
  { eccPerBlock: 16, blocks: [1, 0] },
  { eccPerBlock: 26, blocks: [1, 0] },
  { eccPerBlock: 18, blocks: [2, 0] },
  { eccPerBlock: 24, blocks: [2, 0] },
  { eccPerBlock: 16, blocks: [4, 0] },
  { eccPerBlock: 18, blocks: [4, 0] },
  { eccPerBlock: 22, blocks: [2, 2] },
  { eccPerBlock: 22, blocks: [3, 2] },
  { eccPerBlock: 26, blocks: [4, 1] },
  { eccPerBlock: 30, blocks: [1, 4] },
  { eccPerBlock: 22, blocks: [6, 2] },
  { eccPerBlock: 22, blocks: [8, 1] },
  { eccPerBlock: 24, blocks: [4, 5] },
  { eccPerBlock: 24, blocks: [5, 5] },
  { eccPerBlock: 28, blocks: [7, 3] },
  { eccPerBlock: 28, blocks: [10, 1] },
  { eccPerBlock: 26, blocks: [9, 4] },
  { eccPerBlock: 26, blocks: [3, 11] },
  { eccPerBlock: 26, blocks: [3, 13] },
];

/** The highest version this module builds. See the header for why the ceiling is where it is. */
export const QR_MAX_VERSION = VERSION_SPECS.length;

/** One encoded symbol: a square of modules, dark where `true`. */
export interface QrMatrix {
  /** Modules per side, `4 * version + 17`. */
  readonly size: number;
  readonly version: number;
  /** Row-major, `size` rows of `size` modules. Dark is `true`. */
  readonly modules: readonly (readonly boolean[])[];
}

export class QrEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrEncodeError';
  }
}

const size = (version: number): number => version * 4 + 17;

/** Total codewords a version holds, data and error correction together. */
function totalCodewords(version: number): number {
  const spec = VERSION_SPECS[version - 1];
  if (spec === undefined) throw new QrEncodeError('unsupported QR version');
  const blocks = spec.blocks[0] + spec.blocks[1];
  return dataCodewords(version) + blocks * spec.eccPerBlock;
}

/**
 * The number of 8-bit codewords a version's symbol holds in total, from the module count.
 *
 * Derived rather than tabulated: the symbol's capacity is its area minus the function patterns, which
 * is arithmetic the standard also states as a table. One of the two has to be the source, and the
 * derivation cannot be mis-transcribed.
 */
function rawCodewords(version: number): number {
  const modules = size(version) * size(version);
  const alignment = alignmentCentres(version).length;
  // Finder patterns with their separators (3 × 64), timing rows, format and version areas.
  const functionModules =
    3 * 64 +
    (size(version) - 16) * 2 +
    (alignment === 0 ? 0 : alignment * alignment * 25 - 3 * 25 - (alignment - 2) * 2 * 5) +
    31 +
    (version >= 7 ? 36 : 0);
  return Math.floor((modules - functionModules) / 8);
}

function dataCodewords(version: number): number {
  const spec = VERSION_SPECS[version - 1];
  if (spec === undefined) throw new QrEncodeError('unsupported QR version');
  const blocks = spec.blocks[0] + spec.blocks[1];
  return rawCodewords(version) - blocks * spec.eccPerBlock;
}

/**
 * Where the alignment patterns sit, by the standard's own rule.
 *
 * The 6, the step and the descent from `size - 7` are the specified construction; version 32 is the
 * one case the formula does not cover and it is above this module's ceiling.
 */
function alignmentCentres(version: number): readonly number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((size(version) - 13) / (2 * count - 2)) * 2;
  const centres = [6];
  for (let position = size(version) - 7; centres.length < count; position -= step) centres.unshift(position);
  return centres;
}

// ─── Galois field GF(256) ─────────────────────────────────────────────────────────────────────────

interface GaloisTables {
  readonly exponent: readonly number[];
  readonly logarithm: readonly number[];
}

/** The field QR error correction is computed in: GF(2^8) with the standard 0x11d primitive. */
function galoisTables(): GaloisTables {
  const exponent = new Array<number>(512).fill(0);
  const logarithm = new Array<number>(256).fill(0);
  let value = 1;
  for (let power = 0; power < 255; power += 1) {
    exponent[power] = value;
    logarithm[value] = power;
    value <<= 1;
    if (value >= 256) value ^= 0x11d;
  }
  for (let power = 255; power < 512; power += 1) exponent[power] = exponent[power - 255] ?? 0;
  return { exponent, logarithm };
}

function multiply(tables: GaloisTables, left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return tables.exponent[(tables.logarithm[left] ?? 0) + (tables.logarithm[right] ?? 0)] ?? 0;
}

/**
 * The generator polynomial for `degree` error-correction codewords: ∏ (x − α^i).
 *
 * HIGHEST POWER FIRST, which is the order the division below reads it in. The other order produces the
 * same polynomial with its coefficients reversed, and reversed coefficients divide perfectly happily —
 * they just produce error correction no decoder agrees with, and the symbol still scans as a valid QR
 * containing the right data with a checksum that fails. That failure looks exactly like a camera
 * problem, which is why the tests check this against the standard's published table.
 */
function generator(tables: GaloisTables, degree: number): readonly number[] {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (const [position, coefficient] of polynomial.entries()) {
      next[position] = (next[position] ?? 0) ^ coefficient;
      next[position + 1] = (next[position + 1] ?? 0) ^ multiply(tables, coefficient, tables.exponent[index] ?? 0);
    }
    polynomial = next;
  }
  return polynomial;
}

/** One block's error-correction codewords: the remainder of its data divided by the generator. */
function errorCorrection(tables: GaloisTables, data: readonly number[], count: number): readonly number[] {
  const divisor = generator(tables, count);
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (const [position, coefficient] of divisor.slice(1).entries()) {
      remainder[position] = (remainder[position] ?? 0) ^ multiply(tables, coefficient, factor);
    }
  }
  return remainder;
}

// ─── data encoding ───────────────────────────────────────────────────────────────────────────────

/** The smallest version whose level-M capacity holds `byteLength` bytes in byte mode. */
function smallestVersion(byteLength: number): number {
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    // Mode indicator (4 bits) plus the length field, which widens at version 10.
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (dataCodewords(version) * 8 >= headerBits + byteLength * 8) return version;
  }
  throw new QrEncodeError(
    `this value needs a QR symbol larger than version ${String(QR_MAX_VERSION)}; refusing rather than truncating it`,
  );
}

/** The bit stream: mode, length, the bytes, the terminator, and the standard pad bytes. */
function dataBits(bytes: readonly number[], version: number): readonly number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let shift = width - 1; shift >= 0; shift -= 1) bits.push((value >> shift) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  // The terminator is up to four zero bits, and only as many as still fit.
  for (let index = 0; index < 4 && bits.length < capacity; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  // 0xec / 0x11 alternating: the standard's pad, so the unused capacity is a known pattern rather
  // than a run of zeros the mask evaluation would then have to fight.
  for (let index = 0; bits.length < capacity; index += 1) push(index % 2 === 0 ? 0xec : 0x11, 8);
  return bits;
}

function codewordsFrom(bits: readonly number[]): readonly number[] {
  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | (bits[index + offset] ?? 0);
    codewords.push(byte);
  }
  return codewords;
}

/**
 * The final codeword sequence: blocks interleaved data-first, then all error correction.
 *
 * INTERLEAVING IS WHAT MAKES ERROR CORRECTION WORTH HAVING. A coffee ring over one corner destroys
 * consecutive codewords; spreading each block through the symbol turns that into a few recoverable
 * errors per block instead of one unrecoverable block.
 */
function interleave(codewords: readonly number[], version: number): readonly number[] {
  const spec = VERSION_SPECS[version - 1];
  if (spec === undefined) throw new QrEncodeError('unsupported QR version');
  const tables = galoisTables();
  const shortBlocks = spec.blocks[0];
  const longBlocks = spec.blocks[1];
  const shortLength = Math.floor(dataCodewords(version) / (shortBlocks + longBlocks));
  const blocks: Array<{ readonly data: readonly number[]; readonly ecc: readonly number[] }> = [];
  let cursor = 0;
  for (let index = 0; index < shortBlocks + longBlocks; index += 1) {
    const length = index < shortBlocks ? shortLength : shortLength + 1;
    const data = codewords.slice(cursor, cursor + length);
    cursor += length;
    blocks.push({ data, ecc: errorCorrection(tables, data, spec.eccPerBlock) });
  }
  const result: number[] = [];
  for (let position = 0; position < shortLength + 1; position += 1) {
    for (const block of blocks) {
      const byte = block.data[position];
      if (byte !== undefined) result.push(byte);
    }
  }
  for (let position = 0; position < spec.eccPerBlock; position += 1) {
    for (const block of blocks) result.push(block.ecc[position] ?? 0);
  }
  return result;
}

// ─── symbol construction ─────────────────────────────────────────────────────────────────────────

type Grid = (boolean | undefined)[][];

/** `undefined` marks a module no function pattern has claimed, which is where data may go. */
function blankGrid(version: number): Grid {
  return Array.from({ length: size(version) }, () => new Array<boolean | undefined>(size(version)).fill(undefined));
}

function drawFinder(grid: Grid, row: number, column: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const y = row + dy;
      const x = column + dx;
      if (y < 0 || x < 0 || y >= grid.length || x >= grid.length) continue;
      const distance = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
      (grid[y] ?? [])[x] = distance !== 2 && distance <= 3;
    }
  }
}

function drawAlignment(grid: Grid, row: number, column: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      (grid[row + dy] ?? [])[column + dx] = Math.max(Math.abs(dy), Math.abs(dx)) !== 1;
    }
  }
}

/** Every module the standard fixes: finders, timing, alignment, the dark module and the reserved areas. */
function drawFunctionPatterns(grid: Grid, version: number): void {
  const side = size(version);
  drawFinder(grid, 0, 0);
  drawFinder(grid, 0, side - 7);
  drawFinder(grid, side - 7, 0);
  for (let position = 8; position < side - 8; position += 1) {
    const dark = position % 2 === 0;
    (grid[6] ?? [])[position] = dark;
    (grid[position] ?? [])[6] = dark;
  }
  const centres = alignmentCentres(version);
  for (const row of centres) {
    for (const column of centres) {
      // The three finder corners already own their neighbourhoods.
      const atFinder =
        (row === 6 && column === 6) || (row === 6 && column === side - 7) || (row === side - 7 && column === 6);
      if (!atFinder) drawAlignment(grid, row, column);
    }
  }
  // The format areas, reserved so the data walk skips them; the values are written later.
  for (let index = 0; index <= 8; index += 1) {
    if (index !== 6) {
      (grid[8] ?? [])[index] = false;
      (grid[index] ?? [])[8] = false;
    }
  }
  for (let index = 0; index < 8; index += 1) {
    (grid[8] ?? [])[side - 1 - index] = false;
    (grid[side - 1 - index] ?? [])[8] = false;
  }
  // The dark module: fixed, and one of the few single modules the standard names outright.
  (grid[side - 8] ?? [])[8] = true;
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const row = Math.floor(index / 3);
      const column = index % 3;
      (grid[side - 11 + column] ?? [])[row] = false;
      (grid[row] ?? [])[side - 11 + column] = false;
    }
  }
}

/** The two-column zigzag from the bottom-right, skipping the timing column and every claimed module. */
function placeData(grid: Grid, codewords: readonly number[], version: number): void {
  const side = size(version);
  let bit = 0;
  const nextBit = (): boolean => {
    const codeword = codewords[bit >> 3] ?? 0;
    const value = ((codeword >> (7 - (bit & 7))) & 1) === 1;
    bit += 1;
    return value;
  };
  let upward = true;
  for (let right = side - 1; right >= 1; right -= 2) {
    const column = right === 6 ? right - 1 : right;
    for (let step = 0; step < side; step += 1) {
      const row = upward ? side - 1 - step : step;
      for (const offset of [0, 1]) {
        const x = column - offset;
        if ((grid[row] ?? [])[x] !== undefined) continue;
        (grid[row] ?? [])[x] = bit < codewords.length * 8 ? nextBit() : false;
      }
    }
    upward = !upward;
    if (column === 5) right -= 1;
  }
}

/** The eight mask patterns, as the standard numbers them. */
const MASKS: readonly ((row: number, column: number) => boolean)[] = [
  (row, column) => (row + column) % 2 === 0,
  row => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/**
 * BCH(15,5) format information: the error level, the mask, ten check bits and the standard 0x5412 mask.
 *
 * RETURNED LEAST-SIGNIFICANT BIT FIRST, because that is the order the standard's module positions are
 * enumerated in and `writeFormat` walks them in that enumeration. Returning it the other way round
 * writes a well-formed format block describing a different mask, so the symbol decodes to noise while
 * looking perfect.
 */
function formatBits(mask: number): readonly boolean[] {
  const data = (ERROR_LEVEL_M << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >> 9) * 0b10100110111);
  const value = (((data << 10) | (remainder & 0x3ff)) ^ 0x5412) & 0x7fff;
  return Array.from({ length: 15 }, (_unused, index) => ((value >> index) & 1) === 1);
}

/**
 * BCH(18,6) version information, written only from version 7 up, least-significant bit first.
 *
 * The generator is x¹²+x¹¹+x¹⁰+x⁹+x⁸+x⁵+x²+1 — a THIRTEEN-bit constant. A shorter one divides happily
 * and produces check bits that are wrong for every large symbol, which is invisible until a phone
 * refuses a version-10 code and reads a version-6 one fine.
 */
function versionBits(version: number): readonly boolean[] {
  let remainder = version;
  for (let index = 0; index < 12; index += 1) remainder = (remainder << 1) ^ ((remainder >> 11) * 0b1111100100101);
  const value = ((version << 12) | (remainder & 0xfff)) & 0x3ffff;
  return Array.from({ length: 18 }, (_unused, index) => ((value >> index) & 1) === 1);
}

function writeFormat(grid: Grid, mask: number, version: number): void {
  const side = size(version);
  const bits = formatBits(mask);
  for (const [index, bit] of bits.entries()) {
    // First copy: down column 8, then along row 8, skipping the timing module.
    if (index < 6) (grid[index] ?? [])[8] = bit;
    else if (index < 8) (grid[index + 1] ?? [])[8] = bit;
    else if (index === 8) (grid[8] ?? [])[7] = bit;
    else (grid[8] ?? [])[14 - index] = bit;
    // Second copy, so a damaged corner does not cost the reader the whole symbol.
    if (index < 8) (grid[8] ?? [])[side - 1 - index] = bit;
    else (grid[side - 15 + index] ?? [])[8] = bit;
  }
  if (version < 7) return;
  const version_ = versionBits(version);
  for (const [index, bit] of version_.entries()) {
    const row = Math.floor(index / 3);
    const column = index % 3;
    (grid[side - 11 + column] ?? [])[row] = bit;
    (grid[row] ?? [])[side - 11 + column] = bit;
  }
}

/**
 * The standard's four penalty rules, added up.
 *
 * A LOWER SCORE IS A MORE READABLE SYMBOL. Runs of one colour confuse a scanner's edge detection,
 * 2×2 blocks look like part of a finder, the finder-like 1:1:3:1:1 run is what a decoder hunts for and
 * must not find in the data, and a symbol far from half dark loses contrast headroom. All four are
 * scored because picking a mask on a subset produces symbols that read fine on a good camera and fail
 * on a cheap one — the failure nobody can reproduce.
 */
function penalty(modules: readonly (readonly boolean[])[]): number {
  const side = modules.length;
  let score = 0;
  const at = (row: number, column: number): boolean => modules[row]?.[column] ?? false;

  // Rule 1: runs of five or more.
  for (let index = 0; index < side; index += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let position = 1; position < side; position += 1) {
        const current = horizontal ? at(index, position) : at(position, index);
        const previous = horizontal ? at(index, position - 1) : at(position - 1, index);
        if (current === previous) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }
  // Rule 2: 2×2 blocks of one colour.
  for (let row = 0; row < side - 1; row += 1) {
    for (let column = 0; column < side - 1; column += 1) {
      const first = at(row, column);
      if (first === at(row, column + 1) && first === at(row + 1, column) && first === at(row + 1, column + 1)) {
        score += 3;
      }
    }
  }
  // Rule 3: the finder-like pattern, in both directions.
  const finderLike = [true, false, true, true, true, false, true];
  for (let index = 0; index < side; index += 1) {
    for (let position = 0; position + 7 <= side; position += 1) {
      for (const horizontal of [true, false]) {
        const matches = finderLike.every((expected, offset) =>
          horizontal ? at(index, position + offset) === expected : at(position + offset, index) === expected,
        );
        if (!matches) continue;
        const before = Array.from({ length: 4 }, (_unused, offset) =>
          horizontal ? at(index, position - 1 - offset) : at(position - 1 - offset, index),
        );
        const after = Array.from({ length: 4 }, (_unused, offset) =>
          horizontal ? at(index, position + 7 + offset) : at(position + 7 + offset, index),
        );
        // EACH clear side is its own occurrence, so a finder-like run with four light modules on both
        // sides scores twice. It deserves to: that is the shape a decoder is most likely to mistake for
        // a real finder, and halving its penalty is how a mask that hides one gets chosen.
        if (before.every(module => !module)) score += 40;
        if (after.every(module => !module)) score += 40;
      }
    }
  }
  // Rule 4: distance from half dark.
  const dark = modules.reduce((total, row) => total + row.filter(Boolean).length, 0);
  const percent = (dark * 100) / (side * side);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * Encodes `value` as a QR symbol.
 *
 * The MASK IS CHOSEN, not fixed: all eight are built and the least penalised wins, which is what the
 * standard asks for and what makes the difference between a symbol a phone reads instantly and one it
 * reads on the third try. The chosen mask is recorded in the format bits, so every decoder knows which
 * it was.
 *
 * Throws `QrEncodeError` for a value too long for version 20 rather than encoding a truncated one: a
 * truncated credential produces a perfectly valid QR that pairs nothing, which is the failure a reader
 * cannot diagnose.
 */
export function encodeQr(value: string): QrMatrix {
  if (value === '') throw new QrEncodeError('a QR symbol needs something to encode');
  const bytes = [...new TextEncoder().encode(value)];
  const version = smallestVersion(bytes.length);
  const codewords = interleave(codewordsFrom(dataBits(bytes, version)), version);
  // WHICH modules a mask may flip is decided before any of them are, from a grid holding function
  // patterns ALONE. Deciding it from the filled grid is impossible — a data module and a function
  // module are both booleans by then — and flipping a finder pattern produces a symbol nothing reads.
  const reserved = blankGrid(version);
  drawFunctionPatterns(reserved, version);
  const placed = blankGrid(version);
  drawFunctionPatterns(placed, version);
  placeData(placed, codewords, version);

  // Every candidate is a COMPLETE symbol, so the comparison is between what a scanner would see.
  const candidates = MASKS.map((mask, index) => {
    const modules = placed.map((row, y) =>
      row.map((module, x) => (reserved[y]?.[x] === undefined ? (module ?? false) !== mask(y, x) : (module ?? false))),
    );
    writeFormat(modules, index, version);
    const final = modules.map(row => row.map(module => module ?? false));
    return { index, modules: final, score: penalty(final) };
  });
  const best = candidates.reduce((winner, candidate) => (candidate.score < winner.score ? candidate : winner));
  return { size: size(version), version, modules: best.modules };
}

/** How many `total` codewords a version holds, exposed for the tests that check the table's arithmetic. */
export const qrCodewordCapacity = (version: number): { readonly data: number; readonly total: number } => ({
  data: dataCodewords(version),
  total: totalCodewords(version),
});
