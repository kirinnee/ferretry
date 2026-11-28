import { inflate } from 'node:zlib';

const LIMIT = 64 * 1024 * 1024;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
const invalid = (): never => {
  throw new Error('the binary patch could not be inspected safely');
};

/** Git's base85 transport; the first character states the unpadded byte count of each line. */
async function unpack(lines: readonly string[], size: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 0 || size > LIMIT) return invalid();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const line of lines) {
    const prefix = line.charCodeAt(0);
    const length = prefix >= 65 && prefix <= 90 ? prefix - 64 : prefix >= 97 && prefix <= 122 ? prefix - 70 : 0;
    if (length === 0 || line.length !== 1 + Math.ceil(length / 4) * 5) return invalid();
    const bytes = new Uint8Array(Math.ceil(length / 4) * 4);
    for (let i = 1, at = 0; i < line.length; i += 5, at += 4) {
      let word = 0;
      for (let j = 0; j < 5; j++) {
        const digit = ALPHABET.indexOf(line[i + j] ?? '');
        if (digit < 0) return invalid();
        word = word * 85 + digit;
      }
      if (word > 0xffffffff) return invalid();
      new DataView(bytes.buffer).setUint32(at, word, false);
    }
    total += length;
    if (total > LIMIT) return invalid();
    chunks.push(bytes.slice(0, length));
  }
  const packed = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    packed.set(chunk, offset);
    offset += chunk.length;
  }
  const expanded = await new Promise<Uint8Array>((resolve, reject) => {
    inflate(packed, { maxOutputLength: LIMIT }, (error, result) => (error === null ? resolve(result) : reject(error)));
  });
  if (expanded.length !== size) return invalid();
  return expanded;
}

/** The pack-delta instruction set used by `git diff --binary`, applied to the exact indexed base blob. */
function applyDelta(delta: Uint8Array, base: Uint8Array): Uint8Array {
  let pos = 0;
  const byte = (): number => delta[pos++] ?? invalid();
  const variable = (): number => {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 5; i++) {
      const value = byte();
      result += (value & 0x7f) * multiplier;
      if (result > LIMIT) return invalid();
      if ((value & 0x80) === 0) return result;
      multiplier *= 128;
    }
    return invalid();
  };
  if (variable() !== base.length) return invalid();
  const result = new Uint8Array(variable());
  let written = 0;
  while (pos < delta.length) {
    const op = byte();
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if ((op & (1 << i)) !== 0) offset += byte() * 2 ** (i * 8);
      for (let i = 0; i < 3; i++) if ((op & (1 << (i + 4))) !== 0) size += byte() * 2 ** (i * 8);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > result.length) return invalid();
      result.set(base.subarray(offset, offset + size), written);
      written += size;
    } else {
      if (op === 0 || pos + op > delta.length || written + op > result.length) return invalid();
      result.set(delta.subarray(pos, pos + op), written);
      pos += op;
      written += op;
    }
  }
  if (written !== result.length) return invalid();
  return result;
}

function fileName(header: string): string {
  const plain = /^diff --git a\/(.*) b\/\1$/u.exec(header);
  if (plain !== null) return plain[1] as string;
  const quoted = /^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/u.exec(header);
  if (quoted === null) return invalid();
  // Non-JSON C escapes fail closed rather than assigning the decoded bytes to the wrong file.
  const from: unknown = JSON.parse(quoted[1] as string);
  const to: unknown = JSON.parse(quoted[2] as string);
  if (typeof from !== 'string' || typeof to !== 'string' || from !== `a/${to.slice(2)}` || !to.startsWith('b/'))
    return invalid();
  return to.slice(2);
}

/** Inspect BOTH decoded directions of each binary patch. No working-file reread can substitute different bytes. */
export async function inspectBinaryPatch(
  patch: Uint8Array,
  blob: (oid: string) => Promise<Uint8Array>,
  check: (path: string, bytes: Uint8Array) => void,
): Promise<void> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(patch);
  for (const block of text.split(/(?=^diff --git )/mu)) {
    const lines = block.split('\n');
    const marker = lines.indexOf('GIT binary patch');
    if (marker < 0) continue;
    const path = fileName(lines[0] ?? '');
    const index = lines
      .slice(0, marker)
      .map(line => /^index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})(?: |$)/u.exec(line))
      .find(Boolean);
    if (index === undefined || index === null) return invalid();
    let base = /^0+$/u.test(index[1] as string) ? new Uint8Array() : await blob(index[1] as string);
    if (base.length > LIMIT) return invalid();
    let pos = marker + 1;
    let directions = 0;
    while (pos < lines.length && lines[pos] !== '') {
      const part = /^(literal|delta) (\d+)$/u.exec(lines[pos++] ?? '');
      if (part === null || ++directions > 2) return invalid();
      const data: string[] = [];
      while (pos < lines.length && lines[pos] !== '') data.push(lines[pos++] as string);
      const decoded = await unpack(data, Number(part[2]));
      base = part[1] === 'delta' ? applyDelta(decoded, base) : decoded;
      check(path, base);
      pos++;
    }
    if (directions !== 2) return invalid();
  }
}
