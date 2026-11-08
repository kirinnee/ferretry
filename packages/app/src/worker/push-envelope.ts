import { z } from 'zod';

/**
 * THE ONE PUSH ENVELOPE THE SHELL'S WORKER MAY READ. The worker runs no plugin code and imports no plugin contract, so
 * the few words it shows and the one page it may open are declared HERE, as strict data. A plugin's own push payload
 * (Access's `PushNotificationPayloadSchema`) carries these three fields with the same caps (a contract may not import the
 * app, so a unit test pins the two together) and adds fields only the plugin and the daemon read.
 *
 * - `title` and `body` are the notification's words — the same text today's worker shows (rebuild reference
 *   `lib/notify.ts` `showGroupedNotification`: `payload.title`, `payload.body`), composed by the daemon. They carry no
 *   secret, token or pairing code; a pairing code is never pushed.
 * - `url` is a page NAMED RELATIVE TO THE MACHINE'S OWN PAGES (`/ferrets/<id>/chat?ask=A3`). It is a request, not an
 *   address: the worker opens it only after its route parse accepts it (`notificationUrl`).
 *
 * Strict and length-capped: a field that is missing, not a string, or over its cap makes the whole payload unreadable,
 * and an unreadable push is shown plainly with no page. A push payload is not trusted input.
 */
export const PUSH_TITLE_MAX = 200;
export const PUSH_BODY_MAX = 1_000;
export const PUSH_URL_MAX = 1_024;

const PushEnvelopeShape = {
  title: z.string().min(1).max(PUSH_TITLE_MAX),
  body: z.string().max(PUSH_BODY_MAX),
  url: z.string().min(1).max(PUSH_URL_MAX),
};

export const PushEnvelopeSchema = z.strictObject(PushEnvelopeShape);
export type PushEnvelope = z.infer<typeof PushEnvelopeSchema>;

/**
 * The envelope inside a push's JSON, or `null` when the push carries none. A real payload also names an event key, a
 * tag, a count and more, which are the plugin's to read and not the worker's: only `title`, `body` and `url` are
 * taken from it, by name, and the envelope is then parsed strictly. Total — it never throws.
 */
export const readPushEnvelope = (json: unknown): PushEnvelope | null => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const parsed = PushEnvelopeSchema.safeParse({ title: record.title, body: record.body, url: record.url });
  return parsed.success ? parsed.data : null;
};
