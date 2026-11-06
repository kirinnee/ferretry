/**
 * WHICH VOICE, AND HOW FAST. Pure.
 *
 * Ferretry reads with the voices already built into the device, and a voice that sends the text to its
 * maker (Chrome's "Google …", Edge's "Microsoft … Online") is NEVER chosen automatically. The browser says
 * which voices keep the text on the device (`localService`); the order is: a local voice in the reply's
 * language, then any local voice, then NONE — the reading is then unavailable and the reply stays text.
 * A remote voice speaks only when the person has explicitly picked it in the voice picker, and every place
 * that voice is shown says in words where the text goes (`voiceLabel`, `voiceNote`).
 */

import type { SpeakerVoice } from './ports.ts';

const MIN_SPEECH_RATE = 0.8;
const MAX_SPEECH_RATE = 2;
export const DEFAULT_SPEECH_RATE = 1.1;

export const clampSpeechRate = (rate: number): number =>
  Number.isFinite(rate) ? Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate)) : DEFAULT_SPEECH_RATE;

const primary = (lang: string): string => lang.toLowerCase().replace('_', '-').split('-')[0] ?? '';
const same = (a: string, b: string): boolean => a.toLowerCase().replace('_', '-') === b.toLowerCase().replace('_', '-');

/** A lower number is a better voice. Only called for local voices in the language. */
const rank = (voice: SpeakerVoice, language: string): number =>
  (same(voice.lang, language) ? 0 : 2) + (voice.isDefault ? 0 : 1);

/** Used only when no local voice speaks the language: the device's own pick first. */
const fallbackRank = (voice: SpeakerVoice): number => (voice.isDefault ? 0 : 1);

/**
 * The voice to speak `language` with. Never "whatever the browser would pick" — an unset voice can be a
 * remote one (Chrome's "Google …" default) and would send the reply away unannounced, so a voice is always
 * named. `pickedId` is the voice the person chose in the voice picker: it is used as it is, remote or not,
 * while it is still on the device. Otherwise only voices that stay on the device are considered — the best
 * one in the language, else the device's own pick among the others (it reads with a foreign accent, but in
 * private). Null when there is none: the caller then says "no on-device voice" and does not speak.
 */
export const chooseVoice = (
  voices: readonly SpeakerVoice[],
  language: string,
  pickedId?: string,
): SpeakerVoice | null => {
  const picked = voices.find(voice => voice.id === pickedId);
  if (picked !== undefined) return picked;
  let best: SpeakerVoice | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const voice of voices) {
    if (!voice.local || primary(voice.lang) !== primary(language)) continue;
    const score = rank(voice, language);
    if (score < bestRank) {
      best = voice;
      bestRank = score;
    }
  }
  if (best !== null) return best;
  for (const voice of voices) {
    if (!voice.local) continue;
    const score = fallbackRank(voice);
    if (score < bestRank) {
      best = voice;
      bestRank = score;
    }
  }
  return best;
};

const VENDORS = ['Google', 'Microsoft', 'Amazon', 'Apple', 'IBM'] as const;

/** Who gets the text when a voice sends it away: a well-known maker named by the voice, else "its maker". */
const vendorOf = (voice: SpeakerVoice): string => {
  const name = voice.name.toLowerCase();
  return VENDORS.find(vendor => name.startsWith(vendor.toLowerCase())) ?? 'its maker';
};

/** What to say next to a voice that sends the text away; null for a voice that stays on the device. */
export const voiceNote = (voice: SpeakerVoice | null): string | null =>
  voice !== null && !voice.local ? `${voice.name} sends text to ${vendorOf(voice)} to be spoken.` : null;

/** How a voice is named in a list: remote ones say where the text goes. */
export const voiceLabel = (voice: SpeakerVoice): string =>
  voice.local ? voice.name : `${voice.name} (sends text to ${vendorOf(voice)})`;

/**
 * The short line a voice picker puts UNDER a voice's name, so the name is never lengthened (and never clipped)
 * by it: remote voices say who gets the text, on-device ones say the text stays.
 */
export const voiceWhere = (voice: SpeakerVoice): string =>
  voice.local ? 'Speaks on this device' : `Sends text to ${vendorOf(voice)}`;
