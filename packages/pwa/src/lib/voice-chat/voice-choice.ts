/**
 * WHICH VOICE, AND HOW FAST. Pure.
 *
 * Ferretry reads with the voices already built into the device. The browser says which of them keep the
 * text on the device (`localService`), and those win: a voice that sends the text to its maker (Chrome's
 * "Google …" voices) is only used when the device has no local voice in the language, and then the row
 * says so in words (`voiceNote`).
 */

import type { SpeakerVoice } from './ports.ts';

const MIN_SPEECH_RATE = 0.8;
const MAX_SPEECH_RATE = 2;
export const DEFAULT_SPEECH_RATE = 1.1;

export const clampSpeechRate = (rate: number): number =>
  Number.isFinite(rate) ? Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate)) : DEFAULT_SPEECH_RATE;

const primary = (lang: string): string => lang.toLowerCase().replace('_', '-').split('-')[0] ?? '';
const same = (a: string, b: string): boolean => a.toLowerCase().replace('_', '-') === b.toLowerCase().replace('_', '-');

/** A lower number is a better voice. */
const rank = (voice: SpeakerVoice, language: string): number => {
  const exact = same(voice.lang, language);
  const sameLanguage = primary(voice.lang) === primary(language);
  if (!sameLanguage) return 100 + (voice.local ? 0 : 1);
  const closeness = exact ? 0 : 1;
  return (voice.local ? 0 : 4) + closeness * 2 + (voice.isDefault ? 0 : 1);
};

/**
 * The voice to speak `language` with, or null when the device offers none in that language (the speaker
 * then uses the device's own default). The `preferred` voice wins when it is still there and local.
 */
export const chooseVoice = (
  voices: readonly SpeakerVoice[],
  language: string,
  preferredId?: string,
): SpeakerVoice | null => {
  const preferred = voices.find(voice => voice.id === preferredId);
  if (preferred?.local) return preferred;
  let best: SpeakerVoice | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const voice of voices) {
    if (primary(voice.lang) !== primary(language)) continue;
    const score = rank(voice, language);
    if (score < bestRank) {
      best = voice;
      bestRank = score;
    }
  }
  return best;
};

/** What to say next to a voice that sends the text away; null for a voice that stays on the device. */
export const voiceNote = (voice: SpeakerVoice | null): string | null =>
  voice !== null && !voice.local ? `${voice.name} sends this text to its maker to be spoken.` : null;

/** How a voice is named in a list: remote ones say so. */
export const voiceLabel = (voice: SpeakerVoice): string =>
  voice.local ? voice.name : `${voice.name} (sends text away)`;
