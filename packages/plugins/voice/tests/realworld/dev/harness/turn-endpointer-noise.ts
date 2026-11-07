/**
 * THE TURN ENDPOINTER, MEASURED AGAINST NOISE — a dev harness, never in CI (it takes a minute).
 *
 *   cd packages/pwa && bun harness/turn-endpointer-noise.ts [--turns 150] [--seed 7] [--max-quiet 0.015]
 *
 * It GENERATES its audio, so there is nothing to download and no recording of any person anywhere:
 *
 *   - SPEECH is synthetic: harmonic "voices" with vowel formants, syllable envelopes with shallow
 *     valleys, fricative bursts, breaths between words, phrase pauses and — in a share of turns — a
 *     last word that trails off. Each turn is scripted, so the true start and end of every word is
 *     known. Talkers are 75 % normal (voiced RMS 0.05–0.12) and 25 % soft (0.025–0.05).
 *   - NOISE BEDS are generated too: an empty room, a FAN (low-passed noise, a 100/200/300 Hz hum and
 *     a slow wobble), a CAFÉ (distant babble and clinks) and a TV (a competing news voice and a
 *     steady chord) at several levels.
 *
 * Every turn is 1.5 s of bed, the scripted turn mixed into it, then 6 s of bed. The mixed audio is
 * cut into 20 ms frames by the SAME `lib/stt/energy.ts` the shipped code uses and fed to the real
 * `turn-endpointer.ts` with all three presets at once. What it reports, per bed and level:
 *
 *   - FALSE SENDS (noise): the turn ended although the person had been quiet for LESS than the
 *     pause — speech lost under the noise threshold, or a floor that rose. This is the endpointer's
 *     own error and the number the 2 % target is about. Scored STRICTLY against the configured
 *     pause (see src/lib/voice-chat/turn-endpointer-scoring.ts); a second column forgives gaps within 150 ms of it
 *     (word onsets and tails under the threshold), so both rates are published.
 *   - CUT-OFFS (by design): the turn ended after the person really was quiet for at least the
 *     pause, and then said more. Nothing is wrong with the endpointer; it is what a setting costs a
 *     person who pauses longer than it. This depends ONLY on the invented pause lengths below, so
 *     it is a property of this script, not a measurement of people.
 *   - LATE SENDS: the turn ended more than 1 s after the last word + the pause. MISSED: it never
 *     ended in the 6 s after the last word (the noise itself reads as speech).
 *   - FALSE STARTS per hour: bed with nobody speaking, how often speech "starts" anyway.
 *
 * Synthetic speech is not people. These numbers prove the RULES against modelled signals and beds,
 * not a real fan, café or accent: that stays a manual on-device check (docs/voice.md).
 */

import { FRAME_MS, frameLevels } from '../../../../app/lib/stt/energy.ts';
import {
  ENDPOINTER_MAX_QUIET_RMS,
  endpointerFeed,
  endpointerStart,
  PAUSE_PRESETS,
  type PausePreset,
} from '../../../../app/lib/voice-chat/turn-endpointer.ts';
import { judge, NEAR_MISS_MS, type Word } from '../../../../app/lib/voice-chat/turn-endpointer-scoring.ts';

const RATE = 16_000;
const FRAME_SAMPLES = (RATE * FRAME_MS) / 1_000;
const LEAD_MS = 1_500;
const TRAIL_MS = 6_000;

// ───────────────────────────── arguments ─────────────────────────────

const argument = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? Number.NaN : Number(process.argv[at + 1]);
  return Number.isFinite(value) ? value : fallback;
};
const TURNS = argument('turns', 150);
const SEED = argument('seed', 7);
const MAX_QUIET = argument('max-quiet', ENDPOINTER_MAX_QUIET_RMS);
const EXPLAIN = process.argv.includes('--explain');
/** `--beds room,fan` keeps only those beds (default: all). `--no-fixtures` skips the script table. */
const BEDS = process.argv.includes('--beds') ? (process.argv[process.argv.indexOf('--beds') + 1] ?? '').split(',') : [];
const FIXTURES = !process.argv.includes('--no-fixtures');
const NOISE_ONLY_MINUTES = argument('noise-minutes', 10);

// ───────────────────────────── random ─────────────────────────────

class Rng {
  #state: number;
  constructor(seed: number) {
    this.#state = seed >>> 0 || 1;
  }
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }
  range(low: number, high: number): number {
    return low + (high - low) * this.next();
  }
  logRange(low: number, high: number): number {
    return Math.exp(this.range(Math.log(low), Math.log(high)));
  }
  int(low: number, high: number): number {
    return Math.floor(this.range(low, high + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }
  gauss(): number {
    return Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next());
  }
}

const samplesOf = (ms: number): number => Math.round((ms * RATE) / 1_000);

const rmsOf = (samples: Float32Array): number => {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length));
};

const scale = (samples: Float32Array, factor: number): void => {
  for (let index = 0; index < samples.length; index += 1) samples[index] = (samples[index] as number) * factor;
};

/** Scale `samples` so their overall RMS is `level`. */
const normalise = (samples: Float32Array, level: number): Float32Array => {
  const current = rmsOf(samples);
  if (current > 0) scale(samples, level / current);
  return samples;
};

// ───────────────────────────── speech ─────────────────────────────

/** Formants of a few vowels (Hz): F1, F2, F3. */
const VOWELS: readonly (readonly [number, number, number])[] = [
  [730, 1090, 2440],
  [270, 2290, 3010],
  [300, 870, 2240],
  [530, 1840, 2480],
  [660, 1720, 2410],
  [570, 840, 2410],
];
const HARMONICS = 14;

/** One syllable of voiced speech, peak amplitude about 1. */
function syllable(rng: Rng, durationMs: number, f0: number, valley: number): Float32Array {
  const length = samplesOf(durationMs);
  const out = new Float32Array(length);
  const formants = rng.pick(VOWELS);
  const weights: number[] = [];
  for (let h = 1; h <= HARMONICS; h += 1) {
    const hz = h * f0;
    let gain = 0;
    for (const [index, formant] of formants.entries())
      gain += Math.exp(-(((hz - formant) / (110 + 40 * index)) ** 2)) / (1 + index);
    weights.push((gain + 0.04) / h);
  }
  const vibrato = rng.range(0, 0.04);
  const wobble = rng.range(4, 6);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const t = index / RATE;
    const envelope = valley + (1 - valley) * Math.sin((Math.PI * index) / length) ** 2;
    phase += (2 * Math.PI * f0 * (1 + vibrato * Math.sin(2 * Math.PI * wobble * t))) / RATE;
    let value = 0;
    for (let h = 1; h <= HARMONICS; h += 1) value += (weights[h - 1] as number) * Math.sin(h * phase);
    out[index] = (value + 0.06 * rng.gauss()) * envelope;
  }
  return out;
}

/** A burst of high-passed noise: the "s" at the edge of a word. */
function fricative(rng: Rng, durationMs: number): Float32Array {
  const length = samplesOf(durationMs);
  const out = new Float32Array(length);
  let previous = 0;
  for (let index = 0; index < length; index += 1) {
    const white = rng.gauss();
    out[index] = (white - previous) * 0.5 * Math.sin((Math.PI * index) / length);
    previous = white;
  }
  return out;
}

interface Speech {
  readonly samples: Float32Array;
  readonly words: readonly Word[];
}

/** Where speech sits in time, built up word by word. */
class Timeline {
  readonly parts: { at: number; data: Float32Array }[] = [];
  readonly words: Word[] = [];
  atMs = 0;
  addWord(rng: Rng, trailing: boolean): void {
    const syllables = rng.int(1, 3);
    const f0 = rng.range(95, 230);
    const pieces: Float32Array[] = [];
    if (rng.next() < 0.18) pieces.push(fricative(rng, rng.range(40, 90)));
    for (let s = 0; s < syllables; s += 1)
      pieces.push(syllable(rng, rng.range(110, 210), f0 * rng.range(0.92, 1.08), rng.range(0.1, 0.3)));
    if (rng.next() < 0.1) pieces.push(fricative(rng, rng.range(40, 80)));
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const word = new Float32Array(total);
    let at = 0;
    for (const piece of pieces) {
      word.set(piece, at);
      at += piece.length;
    }
    // A last word that trails off is ~6–10 dB quieter and decays.
    if (trailing) scale(word, rng.range(0.32, 0.5));
    this.parts.push({ at: this.atMs, data: word });
    this.words.push({ startMs: this.atMs, endMs: this.atMs + (total * 1_000) / RATE });
    this.atMs += (total * 1_000) / RATE;
  }
  pause(ms: number): void {
    this.atMs += ms;
  }
  finish(level: number): Speech {
    const length = samplesOf(this.atMs) + 1;
    const samples = new Float32Array(length);
    for (const part of this.parts) {
      const start = samplesOf(part.at);
      for (let index = 0; index < part.data.length && start + index < length; index += 1)
        samples[start + index] = (samples[start + index] as number) + (part.data[index] as number);
    }
    // Level is the RMS over the voiced stretches, not over the pauses.
    const voiced = this.words.reduce((sum, word) => sum + (word.endMs - word.startMs), 0);
    const meanSquare = samples.reduce((sum, value) => sum + value * value, 0) / Math.max(1, samplesOf(voiced));
    scale(samples, level / Math.sqrt(Math.max(meanSquare, 1e-12)));
    return { samples, words: this.words };
  }
}

/**
 * The named scripts. Each is a distribution of the pause between phrases of one turn, as the share
 * of pauses under 0.8 s, 0.8–1.4 s, 1.4–2.5 s and 2.5–4 s. They are INVENTED, to span "reads a
 * sentence" to "thinks aloud", so the cut-off column below describes these scripts and nothing
 * about how real people pause.
 */
const SCRIPTS = {
  /** Dictating a prepared sentence: nearly all pauses short. */
  steady: [0.97, 0.03, 0, 0],
  /** Coding talk: mostly short, some thinking pauses. The default fixture. */
  coding: [0.7, 0.22, 0.06, 0.02],
  /** Thinking out loud: long hesitations are common. */
  hesitant: [0.5, 0.25, 0.17, 0.08],
} as const;
type ScriptName = keyof typeof SCRIPTS;

const phrasePauseMs = (rng: Rng, script: ScriptName): number => {
  const [short, medium, long] = SCRIPTS[script];
  const roll = rng.next();
  if (roll < short) return rng.range(300, 800);
  if (roll < short + medium) return rng.range(800, 1_400);
  if (roll < short + medium + long) return rng.range(1_400, 2_500);
  return rng.range(2_500, 4_000);
};

/** A scripted turn of 2–6 phrases. `level` is the talker's voiced RMS. */
function scriptedTurn(rng: Rng, level: number, script: ScriptName): Speech {
  const line = new Timeline();
  const phrases = rng.int(2, 6);
  for (let phrase = 0; phrase < phrases; phrase += 1) {
    const words = rng.int(3, 7);
    for (let word = 0; word < words; word += 1) {
      const last = phrase === phrases - 1 && word === words - 1;
      line.addWord(rng, last && rng.next() < 0.3);
      if (!last) line.pause(word === words - 1 ? phrasePauseMs(rng, script) : rng.range(30, 220));
    }
  }
  return line.finish(level);
}

// ───────────────────────────── noise beds ─────────────────────────────

const whiteNoise = (rng: Rng, length: number): Float32Array => Float32Array.from({ length }, () => rng.gauss());

function lowPass(samples: Float32Array, cutoffHz: number): Float32Array {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / RATE);
  const out = new Float32Array(samples.length);
  let state = 0;
  for (let index = 0; index < samples.length; index += 1) {
    state += alpha * ((samples[index] as number) - state);
    out[index] = state;
  }
  return out;
}

const mixInto = (target: Float32Array, source: Float32Array, at = 0, gain = 1): void => {
  for (let index = 0; index < source.length && at + index < target.length; index += 1)
    target[at + index] = (target[at + index] as number) + (source[index] as number) * gain;
};

/** Distant talkers: continuous speech with short gaps, summed. */
function babble(rng: Rng, seconds: number, voices: number, gapMs: readonly [number, number]): Float32Array {
  const length = samplesOf(seconds * 1_000);
  const out = new Float32Array(length);
  for (let voice = 0; voice < voices; voice += 1) {
    const line = new Timeline();
    line.pause(rng.range(0, 800));
    while (line.atMs < seconds * 1_000) {
      line.addWord(rng, false);
      line.pause(rng.next() < 0.18 ? rng.range(gapMs[0], gapMs[1]) : rng.range(30, 220));
    }
    mixInto(out, line.finish(1).samples.subarray(0, length), 0, rng.range(0.6, 1.4));
  }
  return out;
}

type Bed = 'room' | 'fan' | 'cafe' | 'tv';

/** The noise bed named `kind` at overall RMS `level`, `seconds` long. */
function noiseBed(rng: Rng, kind: Bed, level: number, seconds: number, pool: Map<string, Float32Array>): Float32Array {
  const length = samplesOf(seconds * 1_000);
  if (kind === 'room') return normalise(lowPass(whiteNoise(rng, length), 3_000), level);
  if (kind === 'fan') {
    const out = lowPass(whiteNoise(rng, length), 700);
    normalise(out, 1);
    const hum = rng.range(98, 124);
    const wobbleHz = rng.range(0.15, 0.5);
    for (let index = 0; index < length; index += 1) {
      const t = index / RATE;
      const hums =
        Math.sin(2 * Math.PI * hum * t) +
        0.5 * Math.sin(2 * Math.PI * 2 * hum * t) +
        0.25 * Math.sin(2 * Math.PI * 3 * hum * t);
      out[index] = ((out[index] as number) + 0.35 * hums) * (1 + 0.18 * Math.sin(2 * Math.PI * wobbleHz * t));
    }
    return normalise(out, level);
  }
  // Babble is slow to build: one long loop per kind, read from a random offset.
  const key = kind;
  let loop = pool.get(key);
  if (loop === undefined) {
    if (kind === 'cafe') {
      loop = babble(rng, 90, 6, [200, 700]);
      normalise(loop, 1);
      const clinkRng = new Rng(99);
      for (let at = 1; at < 88; at += clinkRng.range(2, 6)) {
        const clink = new Float32Array(samplesOf(60));
        const hz = clinkRng.range(2_500, 5_000);
        for (let index = 0; index < clink.length; index += 1)
          clink[index] = Math.sin((2 * Math.PI * hz * index) / RATE) * Math.exp(-index / (RATE * 0.012));
        mixInto(loop, clink, samplesOf(at * 1_000), 1.2);
      }
      mixInto(loop, normalise(lowPass(whiteNoise(clinkRng, loop.length), 1_500), 0.25));
    } else {
      loop = babble(rng, 90, 2, [150, 500]);
      normalise(loop, 1);
      const chord = new Float32Array(loop.length);
      for (const hz of [220, 277.2, 329.6])
        for (let index = 0; index < chord.length; index += 1)
          chord[index] = (chord[index] as number) + Math.sin((2 * Math.PI * hz * index) / RATE);
      mixInto(loop, normalise(chord, 0.35));
    }
    pool.set(key, loop);
  }
  const offset = rng.int(0, loop.length - length - 1);
  return normalise(loop.slice(offset, offset + length), level);
}

// ───────────────────────────── scoring ─────────────────────────────

const PRESETS: readonly PausePreset[] = ['quick', 'normal', 'thinker'];

// ───────────────────────────── the experiment ─────────────────────────────

interface Row {
  readonly bed: Bed;
  readonly level: number;
}

const ROWS: readonly Row[] = [
  { bed: 'room', level: 0.002 },
  { bed: 'fan', level: 0.004 },
  { bed: 'fan', level: 0.008 },
  { bed: 'fan', level: 0.012 },
  { bed: 'fan', level: 0.02 },
  { bed: 'cafe', level: 0.008 },
  { bed: 'cafe', level: 0.015 },
  { bed: 'cafe', level: 0.025 },
  { bed: 'tv', level: 0.01 },
  { bed: 'tv', level: 0.02 },
];

const percent = (count: number, total: number): string => `${((100 * count) / Math.max(1, total)).toFixed(1)}%`;
const quantile = (values: readonly number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};

interface Tally {
  turns: number;
  falseSends: number;
  /** Of {@link falseSends}: the real gap was within the near-miss tolerance of the pause. */
  nearMisses: number;
  cutOffs: number;
  late: number;
  missed: number;
  falseTurns: number;
  lateBy: number[];
  notes: string[];
}

const emptyTally = (): Tally => ({
  turns: 0,
  falseSends: 0,
  nearMisses: 0,
  cutOffs: 0,
  late: 0,
  missed: 0,
  falseTurns: 0,
  lateBy: [],
  notes: [],
});

function runRow(row: Row, pool: Map<string, Float32Array>, script: ScriptName): Record<PausePreset, Tally> {
  const rng = new Rng(SEED * 1_000 + Math.round(row.level * 10_000) + row.bed.charCodeAt(0));
  const tallies: Record<PausePreset, Tally> = { quick: emptyTally(), normal: emptyTally(), thinker: emptyTally() };
  for (let turn = 0; turn < TURNS; turn += 1) {
    const soft = rng.next() < 0.25;
    const level = soft ? rng.logRange(0.025, 0.05) : rng.logRange(0.05, 0.12);
    const speech = scriptedTurn(rng, level, script);
    const totalMs = LEAD_MS + (speech.words.at(-1) as Word).endMs + TRAIL_MS;
    const audio = noiseBed(rng, row.bed, row.level, totalMs / 1_000 + 0.1, pool);
    mixInto(audio, speech.samples, samplesOf(LEAD_MS));
    const levels = frameLevels(audio, 0, audio.length, FRAME_SAMPLES);
    for (const preset of PRESETS) {
      const outcome = judge(levels, speech.words, LEAD_MS, preset, MAX_QUIET);
      const tally = tallies[preset];
      tally.turns += 1;
      if (outcome.falseSend) {
        tally.falseSends += 1;
        if (outcome.nearMiss) tally.nearMisses += 1;
        tally.notes.push(`turn ${turn} talker ${level.toFixed(3)}: ${outcome.note}`);
      }
      if (outcome.cutOff) tally.cutOffs += 1;
      if (outcome.late) tally.late += 1;
      if (outcome.missed) tally.missed += 1;
      tally.falseTurns += outcome.falseTurns;
      if (outcome.lateByMs !== null) tally.lateBy.push(outcome.lateByMs);
    }
  }
  return tallies;
}

/** Nobody speaks: how often does the bed alone start (and end) a "turn"? */
function noiseOnly(row: Row, pool: Map<string, Float32Array>): { starts: number; turns: number; perHour: number } {
  if (NOISE_ONLY_MINUTES <= 0) return { starts: 0, turns: 0, perHour: Number.NaN };
  const rng = new Rng(SEED * 77 + Math.round(row.level * 10_000));
  const seconds = NOISE_ONLY_MINUTES * 60;
  const chunk = 90;
  let starts = 0;
  let turns = 0;
  let state = endpointerStart('normal', { maxQuietRms: MAX_QUIET });
  let atFrame = 0;
  for (let at = 0; at < seconds; at += chunk) {
    // The last chunk is trimmed so the run is exactly the minutes asked for.
    const audio = noiseBed(rng, row.bed, row.level, Math.min(chunk, seconds - at), pool);
    for (const rms of frameLevels(audio, 0, audio.length, FRAME_SAMPLES)) {
      atFrame += 1;
      const step = endpointerFeed(state, { atMs: atFrame * FRAME_MS, rms });
      state = step.state;
      for (const event of step.events) {
        if (event.kind === 'speech-start') starts += 1;
        if (event.kind === 'turn-end') {
          turns += 1;
          state = endpointerStart('normal', { maxQuietRms: MAX_QUIET, floorLevels: state.levels });
        }
      }
    }
  }
  // Divide by the audio really fed, not the amount asked for.
  const heardSeconds = (atFrame * FRAME_MS) / 1_000;
  return { starts, turns, perHour: heardSeconds > 0 ? (starts * 3_600) / heardSeconds : Number.NaN };
}

const t0 = Date.now();
const pool = new Map<string, Float32Array>();
console.log(
  `turn endpointer vs noise — ${TURNS} turns per row, seed ${SEED}, max quiet RMS ${MAX_QUIET}, ${NOISE_ONLY_MINUTES} min noise-only per row`,
);
console.log('talkers: 75% normal (voiced RMS 0.05–0.12), 25% soft (0.025–0.05); lead 1.5 s, trail 6 s\n');

const normalResults: { row: Row; tallies: Record<PausePreset, Tally>; quiet: ReturnType<typeof noiseOnly> }[] = [];
for (const row of ROWS.filter(r => BEDS.length === 0 || BEDS.includes(r.bed)))
  normalResults.push({ row, tallies: runRow(row, pool, 'coding'), quiet: noiseOnly(row, pool) });

const rowName = (row: Row): string => `${row.bed} ${row.level}`;
for (const preset of PRESETS) {
  console.log(`## ${preset} (${PAUSE_PRESETS[preset]} ms)`);
  console.log(
    `| bed (RMS) | turns | false sends, strict | false sends, ±${NEAR_MISS_MS} ms forgiven | cut-offs (by design) | late > 1 s | missed | late-by p50 / p95 ms | noise-only false starts / h |`,
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const { row, tallies, quiet } of normalResults) {
    const t = tallies[preset];
    const p50 = quantile(t.lateBy, 0.5);
    const p95 = quantile(t.lateBy, 0.95);
    if (EXPLAIN && t.notes.length > 0) for (const note of t.notes) console.log(`  [${preset} ${rowName(row)}] ${note}`);
    console.log(
      `| ${rowName(row)} | ${t.turns} | ${percent(t.falseSends, t.turns)} | ${percent(t.falseSends - t.nearMisses, t.turns)} | ${percent(t.cutOffs, t.turns)} | ${percent(t.late, t.turns)} | ${percent(t.missed, t.turns)} | ${p50 === null ? '–' : Math.round(p50)} / ${p95 === null ? '–' : Math.round(p95)} | ${Number.isNaN(quiet.perHour) ? '–' : quiet.perHour.toFixed(0)} |`,
    );
  }
  console.log('');
}
if (FIXTURES) {
  console.log('## fixtures: cut-offs by script (fan 0.008)');
  console.log('| script | quick | normal | thinker |');
  console.log('| --- | ---: | ---: | ---: |');
}
for (const script of FIXTURES ? (Object.keys(SCRIPTS) as ScriptName[]) : []) {
  const t = runRow({ bed: 'fan', level: 0.008 }, pool, script);
  console.log(`| ${script} | ${PRESETS.map(p => percent(t[p].cutOffs, t[p].turns)).join(' | ')} |`);
}
if (FIXTURES) console.log('');
console.log(`done in ${((Date.now() - t0) / 1_000).toFixed(0)} s`);
