/**
 * 24 kHz to 16 kHz, mono: the model speaks at 24 kHz and the stream carries 16 kHz. Three input samples become two, so
 * an output sample sits at every 1.5th input sample: alternately ON an input sample and HALF-WAY between two. Each is
 * a windowed-sinc low-pass (cutoff 7.2 kHz, so nothing above the output's own 8 kHz folds back) evaluated at that
 * position, which is both the filter and the resampler in one pass. Speech has nothing above 8 kHz to lose.
 *
 * Pure and total: any length, including none.
 */
const RADIUS = 24;
const FROM = 24_000;
const TO = 16_000;
const CUTOFF = 7_200 / FROM;

/** The weights for an output sample whose centre is `offset` input samples past an input sample (0 or 0.5). */
function weights(offset: number): Float64Array {
  const table = new Float64Array(2 * RADIUS + 2);
  let sum = 0;
  for (let tap = -RADIUS; tap <= RADIUS + 1; tap += 1) {
    const t = tap - offset;
    const x = 2 * Math.PI * CUTOFF * t;
    const sinc = t === 0 ? 2 * CUTOFF : (2 * CUTOFF * Math.sin(x)) / x;
    const window = Math.abs(t) > RADIUS + 0.5 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * t) / (RADIUS + 0.5));
    const weight = sinc * window;
    table[tap + RADIUS] = weight;
    sum += weight;
  }
  // Unit gain at DC, so a steady level comes out as the same level.
  for (let index = 0; index < table.length; index += 1) table[index] = (table[index] ?? 0) / sum;
  return table;
}

const ON_SAMPLE = weights(0);
const HALF_WAY = weights(0.5);

export function resample24to16(input: Float32Array): Float32Array {
  const outLength = Math.floor((input.length * TO) / FROM);
  const out = new Float32Array(outLength);
  for (let index = 0; index < outLength; index += 1) {
    const base = Math.floor((index * FROM) / TO);
    const table = (index * FROM) % TO === 0 ? ON_SAMPLE : HALF_WAY;
    let acc = 0;
    for (let tap = -RADIUS; tap <= RADIUS + 1; tap += 1) {
      const at = base + tap;
      if (at >= 0 && at < input.length) acc += (input[at] ?? 0) * (table[tap + RADIUS] ?? 0);
    }
    out[index] = acc;
  }
  return out;
}
