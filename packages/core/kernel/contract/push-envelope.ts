import { z } from 'zod';

/**
 * THE ONE PUSH ENVELOPE: `title`, `body`, `url` — the only fields of a push the shell's signed service worker reads, and
 * the fields every plugin's push payload carries. Declared once, here, so the worker (which runs no plugin code) and a
 * plugin's contract (Access's `PushNotificationPayloadSchema`) cannot disagree about a cap.
 *
 * - `title` and `body` are the notification's words, composed by the daemon. They carry no secret, token or pairing code.
 * - `url` is a page NAMED RELATIVE TO THE MACHINE'S OWN PAGES (`/ferrets/<id>/chat?ask=A3`). It is a request, not an
 *   address: the shell opens it only after its own route parse accepts it.
 *
 * Strict and length-capped: a field that is missing, not a string, or over its cap makes the whole envelope unreadable,
 * and an unreadable push is shown plainly with no page. A push payload is not trusted input.
 */
export const PUSH_TITLE_MAX = 200;
export const PUSH_BODY_MAX = 1_000;
export const PUSH_URL_MAX = 1_024;

/** The three fields, as a shape, for a payload that adds fields of its own. */
export const PushEnvelopeFields = {
  title: z.string().min(1).max(PUSH_TITLE_MAX),
  body: z.string().max(PUSH_BODY_MAX),
  url: z.string().min(1).max(PUSH_URL_MAX),
};

export const PushEnvelopeSchema = z.strictObject(PushEnvelopeFields);
export type PushEnvelope = z.infer<typeof PushEnvelopeSchema>;
