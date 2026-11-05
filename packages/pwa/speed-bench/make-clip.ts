/**
 * Makes `clip-5s.wav`, the fixed clip every speed benchmark decodes: a SYNTHETIC voice (eSpeak NG, no
 * real person) saying one ordinary instruction, resampled to 16 kHz mono 16-bit and padded or trimmed to
 * exactly 5.000 s.
 *
 *   nix shell nixpkgs#espeak-ng -c espeak-ng -v en-us -s 125 -w /tmp/say.wav \
 *     "Please fix the login redirect and run the tests again."
 *   bun speed-bench/make-clip.ts /tmp/say.wav speed-bench/clip-5s.wav
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) throw new Error('usage: bun make-clip.ts <in.wav> <out.wav>');

const bytes = readFileSync(input);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const rate = view.getUint32(24, true);
if (view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16) throw new Error('expected 16-bit mono PCM');
const dataAt = bytes.indexOf(Buffer.from('data')) + 8;
const source = new Int16Array(bytes.buffer, bytes.byteOffset + dataAt, (bytes.byteLength - dataAt) / 2);

const TARGET_RATE = 16_000;
const TARGET_SAMPLES = TARGET_RATE * 5;
const out = new Int16Array(TARGET_SAMPLES);
for (let index = 0; index < Math.min(TARGET_SAMPLES, Math.floor((source.length * TARGET_RATE) / rate)); index += 1) {
  const position = (index * rate) / TARGET_RATE;
  const before = Math.floor(position);
  const mix = position - before;
  out[index] = Math.round((source[before] ?? 0) * (1 - mix) + (source[before + 1] ?? source[before] ?? 0) * mix);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + out.byteLength, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(TARGET_RATE, 24);
header.writeUInt32LE(TARGET_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(out.byteLength, 40);
writeFileSync(output, Buffer.concat([header, Buffer.from(out.buffer)]));
console.log(`wrote ${output}: ${TARGET_SAMPLES} samples, ${(TARGET_SAMPLES / TARGET_RATE).toFixed(3)} s`);
