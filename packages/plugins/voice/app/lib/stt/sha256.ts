/**
 * A streaming SHA-256 whose state can be saved and resumed.
 *
 * WHY NOT `crypto.subtle.digest`. WebCrypto hashes one complete buffer. The Parakeet encoder is
 * 652 MB, and holding it whole on the main thread to hash it — while it is also being written to
 * Cache Storage — is an out-of-memory kill on a phone long before the download finishes. A resumable
 * download also needs to stop part-way and carry on in another page load, which a one-shot digest
 * cannot do at all. So the bytes are hashed as they arrive, a network chunk at a time, and the
 * running state is written down beside every stored part (`parakeet-store.ts`): a resumed download
 * starts hashing exactly where the previous one stopped, without reading back what it already has.
 *
 * FIPS 180-4, written for clarity over speed; it hashes well over 100 MB/s in a modern engine, which
 * is far faster than the network delivering it.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** A hash in progress, as plain JSON: the eight words, the bytes hashed, and the unfinished block. */
export interface Sha256State {
  readonly h: readonly number[];
  readonly length: number;
  /** Hex of the bytes waiting for a full 64-byte block (always under 64). */
  readonly pending: string;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

/** Whether `value` is a state this module wrote: anything else is refused rather than resumed from. */
export const isSha256State = (value: unknown): value is Sha256State => {
  if (typeof value !== 'object' || value === null) return false;
  const { h, length, pending } = value as Record<string, unknown>;
  return (
    Array.isArray(h) &&
    h.length === 8 &&
    h.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffffffff) &&
    Number.isSafeInteger(length) &&
    (length as number) >= 0 &&
    typeof pending === 'string' &&
    /^(?:[0-9a-f]{2}){0,63}$/u.test(pending) &&
    pending.length / 2 === (length as number) % 64
  );
};

export class Sha256 {
  readonly #h = new Uint32Array(8);
  readonly #block = new Uint8Array(64);
  readonly #words = new Uint32Array(64);
  #blockLength = 0;
  #length = 0;

  constructor(state?: Sha256State) {
    this.#h.set(state?.h ?? INITIAL);
    this.#length = state?.length ?? 0;
    const pending = fromHex(state?.pending ?? '');
    this.#block.set(pending);
    this.#blockLength = pending.length;
  }

  /** Bytes hashed so far. */
  get length(): number {
    return this.#length;
  }

  update(bytes: Uint8Array): this {
    let offset = 0;
    this.#length += bytes.length;
    while (offset < bytes.length) {
      const take = Math.min(64 - this.#blockLength, bytes.length - offset);
      this.#block.set(bytes.subarray(offset, offset + take), this.#blockLength);
      this.#blockLength += take;
      offset += take;
      if (this.#blockLength === 64) {
        this.#compress();
        this.#blockLength = 0;
      }
    }
    return this;
  }

  /** The state to resume from later. */
  state(): Sha256State {
    return { h: Array.from(this.#h), length: this.#length, pending: toHex(this.#block.subarray(0, this.#blockLength)) };
  }

  /** The finished hash as lowercase hex. Finishes a COPY, so this hasher can keep going. */
  hex(): string {
    const copy = new Sha256(this.state());
    const bits = this.#length * 8;
    const padding = new Uint8Array((this.#blockLength < 56 ? 56 : 120) - this.#blockLength + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    // The length in bits as a 64-bit big-endian integer: high word, then low word.
    view.setUint32(padding.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padding.length - 4, bits >>> 0);
    copy.update(padding);
    const digest = new Uint8Array(32);
    const out = new DataView(digest.buffer);
    for (let index = 0; index < 8; index += 1) out.setUint32(index * 4, copy.#h[index] as number);
    return toHex(digest);
  }

  #compress(): void {
    const w = this.#words;
    const block = this.#block;
    for (let index = 0; index < 16; index += 1) {
      const at = index * 4;
      w[index] =
        ((block[at] as number) << 24) |
        ((block[at + 1] as number) << 16) |
        ((block[at + 2] as number) << 8) |
        (block[at + 3] as number);
    }
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) | 0;
    }
    const h = this.#h;
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + choose + (K[index] as number) + (w[index] as number)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }
}
