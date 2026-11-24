/**
 * WHAT THE ENGINES MEASURED — the numbers Settings › Voice shows on each engine card, from one benchmark
 * so they can be compared: the on-device speech research of 2026-10-22, which ran every candidate in
 * headless Chrome with its CPU slowed four times to stand in for a mid-range phone.
 *
 *   - accuracy: word error rate on 20 LibriSpeech test-clean clips, then on 10 synthesised technical
 *     dictations, with how many of their 33 key terms (`kubectl`, `useEffect`, `onnxruntime`…) came out;
 *   - speed: the wait from Stop to the text for a ~5 s take, single-threaded at that 4× slowdown, and
 *     the peak memory of the tab while it loads and listens.
 *
 * The technical clips are clean synthetic speech, so their numbers rank engines; they do not promise
 * what a real voice in a real room will get. Moonshine was measured on the transformers.js build of the
 * same weights, and Vosk on vosk-browser 0.0.8 with the same model.
 *
 * The Google live transcriber (`googleAudioTranscriber`) was measured later and differently, and says so: the 4× CPU
 * throttle does not reach a worker (Chrome answers "only supported for pages"), so it ran with the whole browser held to a
 * quarter of one core, on the 5 s bench clip (`tests/realworld/google-transcriber.realworld.test.ts`). It has no figure for
 * the 33 key terms: that technical set is not in this repository.
 */

import type { MeasuredNumbers } from './model-catalog.ts';

const PHONE = 'research benchmark, Chrome with a 4× slower CPU';

const measured = (
  where: string,
  general: string,
  technical: string,
  keyTerms: number,
  stopToText: string,
  memory: string,
): MeasuredNumbers => ({
  where,
  accuracy: `${general} WER on everyday speech; ${technical} on technical speech, ${keyTerms} of 33 key terms`,
  speed: `${stopToText} from Stop to text; ${memory} of memory`,
});

export const RESEARCH = {
  zipformerEn: measured(PHONE, '3.4%', '35.2%', 17, 'words live, keeps up; 0.4 s', '0.45 GB'),
  moonshineTiny: measured(`${PHONE}, transformers.js build`, '4.0%', '21.3%', 23, '2.0 s', '0.75 GB'),
  moonshineBase: measured(`${PHONE}, transformers.js build`, '3.4%', '15.6%', 29, '3.4 s', '0.91 GB'),
  whisperTinyEn: measured(PHONE, '6.8%', '13.9%', 30, '7.6 s', '0.61 GB'),
  whisperBaseEn: measured(PHONE, '4.8%', '16.4%', 28, '14.3 s', '0.76 GB'),
  parakeetTdt110m: measured(PHONE, '2.0%', '18.9%', 27, '1.7 s', '0.87 GB'),
  parakeet06b: measured(PHONE, '2.0%', '17.2%', 29, '7.1 s', '1.6–2.3 GB'),
  voskSmallEn: measured(`${PHONE}, vosk-browser 0.0.8`, '11.6%', '38.5%', 19, 'words live; 2.7 s', '0.45 GB'),
  googleAudioTranscriber: {
    where: 'Chrome with the whole browser held to a quarter of one core, the 5 s bench clip',
    accuracy:
      'the bench clip word for word (0% WER), the same weights as Parakeet 0.6B; Google reports 5.1% WER on its own English streaming test; the 33 key terms were not run',
    speed:
      '8.2 s from Stop to text, with live words only on a faster machine (1.2 s from Stop at full speed, first words 3.9 s into the take); about 3 GB of memory',
  },
} as const satisfies Readonly<Record<string, MeasuredNumbers>>;
