import { STREAM_SAMPLE_RATE } from '../../../contract/index.ts';

/** One second of audio, in samples. */
export const SECOND = STREAM_SAMPLE_RATE;

/**
 * The stream's audio, as 16 kHz floats in [-1, 1]. It only ever holds one turn plus a short lead-in, so it is bounded
 * by the turn cap; it grows by doubling and gives samples back from the front (`dropBefore`) as turns end.
 */
export class SampleBuffer {
  private data = new Float32Array(SECOND * 10);
  private used = 0;

  get length(): number {
    return this.used;
  }

  append(pcm: Int16Array): void {
    if (this.used + pcm.length > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, this.used + pcm.length));
      grown.set(this.data.subarray(0, this.used));
      this.data = grown;
    }
    for (let index = 0; index < pcm.length; index += 1) this.data[this.used + index] = (pcm[index] ?? 0) / 32768;
    this.used += pcm.length;
  }

  /** A copy of `[from, to)`. */
  slice(from: number, to: number = this.used): Float32Array {
    return this.data.slice(Math.max(0, from), Math.min(this.used, to));
  }

  /** Forgets everything before `index`; every offset the caller kept moves down by the same amount. */
  dropBefore(index: number): number {
    const cut = Math.max(0, Math.min(this.used, index));
    this.data.copyWithin(0, cut, this.used);
    this.used -= cut;
    return cut;
  }
}
