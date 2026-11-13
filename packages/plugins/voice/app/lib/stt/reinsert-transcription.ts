/**
 * The one request a Settings panel makes of a composer: "put these words back in the draft".
 *
 * The transcription log lives in Settings and the composer lives in a conversation, so neither knows
 * the other. The log announces `REINSERT_TRANSCRIPTION_EVENT` on a target with a CANCELABLE event; a
 * composer that takes the words calls `preventDefault()`. `requestReinsert` returns whether one did,
 * so a caller with no composer to hand the words to can fall back to something else (copying them).
 */

import { z } from 'zod';

export const REINSERT_TRANSCRIPTION_EVENT = 'ferretry:reinsert-transcription';

const TranscriptionReinsertSchema = z.object({
  /** The conversation the dictation was for, when it is known. */
  sessionId: z.string().optional(),
  text: z.string().min(1),
});
export type TranscriptionReinsert = z.input<typeof TranscriptionReinsertSchema>;

/** True when a listener took the words (called `preventDefault()`), false when nobody did. */
export function requestReinsert(target: EventTarget, detail: TranscriptionReinsert): boolean {
  const event = new CustomEvent<TranscriptionReinsert>(REINSERT_TRANSCRIPTION_EVENT, { cancelable: true, detail });
  return !target.dispatchEvent(event);
}

/** The words a reinsert event carries; undefined for any other event or a detail that is not words. */
export function reinsertTranscriptionText(event: Event): string | undefined {
  const parsed = TranscriptionReinsertSchema.safeParse(event instanceof CustomEvent ? event.detail : undefined);
  return parsed.success ? parsed.data.text : undefined;
}
