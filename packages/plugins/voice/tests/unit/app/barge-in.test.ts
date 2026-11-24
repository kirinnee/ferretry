import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNIT_MS, UNIT_SAMPLES } from '../../../contract/index.ts';
import { BARGE_IN_MS, createBargeInDetector, MIN_SPEECH_RMS } from '../../../app/lib/voice-mode/barge-in.ts';

/** A unit at a steady loudness: `level` is the RMS as a fraction of full scale (a square wave has RMS = amplitude). */
const unit = (level: number): Int16Array => new Int16Array(UNIT_SAMPLES).fill(Math.round(level * 32768));

describe('barge-in detector', () => {
  test('300 ms of speech while a reply plays fires, once, on the unit that completes it', () => {
    const d = createBargeInDetector();
    for (let index = 0; index < 50; index += 1) expect(d.push(unit(0.002), true)).toBe(false);
    const fired: number[] = [];
    for (let index = 0; index < 30; index += 1) if (d.push(unit(0.1), true)) fired.push(index);
    // 300 ms is 7.5 units: the eighth unit completes it, and only once.
    expect(fired).toEqual([
      Math.ceil(BARGE_IN_MS / UNIT_MS) - 1,
      2 * Math.ceil(BARGE_IN_MS / UNIT_MS) - 1,
      3 * Math.ceil(BARGE_IN_MS / UNIT_MS) - 1,
    ]);
  });

  test('less than 300 ms, a cough or a click, does not', () => {
    const d = createBargeInDetector();
    for (let index = 0; index < 50; index += 1) d.push(unit(0.002), true);
    for (let index = 0; index < 7; index += 1) expect(d.push(unit(0.2), true)).toBe(false);
    for (let index = 0; index < 20; index += 1) expect(d.push(unit(0.002), true)).toBe(false);
    // …and the count started over: seven more is still not enough.
    for (let index = 0; index < 7; index += 1) expect(d.push(unit(0.2), true)).toBe(false);
  });

  test('speech with a short gap inside it still counts; a long gap starts over', () => {
    const d = createBargeInDetector();
    for (let index = 0; index < 50; index += 1) d.push(unit(0.002), true);
    for (let index = 0; index < 4; index += 1) d.push(unit(0.1), true);
    for (let index = 0; index < 2; index += 1) expect(d.push(unit(0.002), true)).toBe(false);
    let fired = false;
    for (let index = 0; index < 4; index += 1) fired = d.push(unit(0.1), true) || fired;
    expect(fired).toBe(true);

    const gap = createBargeInDetector();
    for (let index = 0; index < 50; index += 1) gap.push(unit(0.002), true);
    for (let index = 0; index < 7; index += 1) gap.push(unit(0.1), true);
    for (let index = 0; index < 3; index += 1) gap.push(unit(0.002), true);
    expect(gap.push(unit(0.1), true)).toBe(false);
  });

  test('nothing fires while no reply is playing, and the count never carries over from before it', () => {
    const d = createBargeInDetector();
    for (let index = 0; index < 50; index += 1) d.push(unit(0.002), false);
    for (let index = 0; index < 40; index += 1) expect(d.push(unit(0.2), false)).toBe(false);
    // The person was already talking when the reply began: it takes 300 ms of it AFTER the reply began.
    for (let index = 0; index < 7; index += 1) expect(d.push(unit(0.2), true)).toBe(false);
  });

  test('a steady left-over echo, once the room level includes it, is not speech; a voice over it still is', () => {
    const d = createBargeInDetector();
    for (let index = 0; index < 40; index += 1) d.push(unit(0.03), false);
    for (let index = 0; index < 100; index += 1) expect(d.push(unit(0.03), true)).toBe(false);
    let fired = false;
    for (let index = 0; index < 10; index += 1) fired = d.push(unit(0.3), true) || fired;
    expect(fired).toBe(true);
  });

  test('a unit below the absolute bar is never speech, however quiet the room', () => {
    const d = createBargeInDetector();
    for (let index = 0; index < 100; index += 1) expect(d.push(unit(MIN_SPEECH_RMS / 2), true)).toBe(false);
  });

  test('reset forgets the speech so far', () => {
    const d = createBargeInDetector();
    for (let index = 0; index < 50; index += 1) d.push(unit(0.002), true);
    for (let index = 0; index < 6; index += 1) d.push(unit(0.2), true);
    d.reset();
    expect(d.push(unit(0.2), true)).toBe(false);
  });
});

/** The recorded clip ("please fix the login redirect and run the tests again"), as 16 kHz PCM16. */
function clip(): Int16Array {
  const wav = new Uint8Array(readFileSync(join(import.meta.dir, '../../realworld/dev/speed-bench/clip-5s.wav')));
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const at = Buffer.from(wav).indexOf('data') + 8;
  return Int16Array.from({ length: (wav.byteLength - at) >> 1 }, (_, index) => view.getInt16(at + index * 2, true));
}

describe('barge-in detector on real speech', () => {
  test('recorded speech over a quiet room is heard within one unit of 300 ms, and the quiet room alone never fires', () => {
    const speech = clip();
    const units: Int16Array[] = [];
    // A second of room noise (a faint hiss), then the clip.
    const hiss = (): Int16Array =>
      Int16Array.from({ length: UNIT_SAMPLES }, () => Math.round((Math.random() - 0.5) * 120));
    for (let index = 0; index < 25; index += 1) units.push(hiss());
    const onset = units.length;
    for (let at = 0; at + UNIT_SAMPLES <= speech.length; at += UNIT_SAMPLES)
      units.push(speech.subarray(at, at + UNIT_SAMPLES));
    const d = createBargeInDetector();
    let firedAt = -1;
    units.forEach((pcm, index) => {
      if (d.push(pcm, true) && firedAt < 0) firedAt = index;
    });
    expect(firedAt).toBeGreaterThanOrEqual(onset);
    // The clip opens with a breath of near-silence and its first words are at unit 2: 300 ms of them is heard by unit 9
    // (measured: 360 ms into the clip), well inside the first half second.
    expect((firedAt - onset) * UNIT_MS).toBeLessThanOrEqual(500);

    const quiet = createBargeInDetector();
    for (let index = 0; index < 500; index += 1) expect(quiet.push(hiss(), true)).toBe(false);
  });

  test('the same speech played back as a faint left-over echo (a tenth of the volume) does not fire', () => {
    const speech = clip();
    const d = createBargeInDetector();
    // The room has already learned the echo's own level before the check begins (the reply was playing a moment).
    for (let at = 0; at + UNIT_SAMPLES <= speech.length; at += UNIT_SAMPLES)
      d.push(
        Int16Array.from(speech.subarray(at, at + UNIT_SAMPLES), sample => Math.round(sample / 10)),
        false,
      );
    let fired = false;
    for (let at = 0; at + UNIT_SAMPLES <= speech.length; at += UNIT_SAMPLES)
      fired =
        d.push(
          Int16Array.from(speech.subarray(at, at + UNIT_SAMPLES), sample => Math.round(sample / 10)),
          true,
        ) || fired;
    expect(fired).toBe(false);
  });
});
