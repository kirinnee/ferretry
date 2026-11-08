import { z } from 'zod';
import { PushKindSchema } from './push-envelope.ts';

/**
 * THIS DEVICE'S NOTIFICATION FILTER, AS DATA — the one document the shell's signed service worker evaluates to decide
 * whether a push it received while the app was closed is shown, or replaced by its quiet "filtered" line.
 *
 * - **Agenda writes it.** Agenda owns the categories a person switches (needs you, finished, failed, new device) and
 *   expands them to the push kinds each covers, so the document holds kinds, not categories.
 * - **The worker only evaluates it.** The worker runs no plugin code, so it cannot hold Agenda's kind→category map;
 *   it reads this document and calls {@link shouldShowPush}, and Agenda's in-page filter calls the same function, so the
 *   page and the worker cannot disagree.
 * - **The kernel declares names and shape only.** It does no IndexedDB I/O: the shell worker reads, Agenda writes.
 *
 * Nothing here is trusted: any page on the origin can write IndexedDB. A document that does not parse reads as the
 * default, which shows everything — a worker can never show LESS than an unconfigured device.
 */

/**
 * Where the document lives: the SAME names Agenda's mirror uses today, so the database is not renamed. The value under
 * {@link NOTIFICATION_FILTER_KEY} is the document's JSON TEXT (`JSON.stringify(document)`), as Agenda's mirror writes
 * it today; {@link readNotificationFilterDocument} parses it.
 */
export const NOTIFICATION_FILTER_DB = 'ferretry-notification-filter';
export const NOTIFICATION_FILTER_STORE = 'mirror';
export const NOTIFICATION_FILTER_KEY = 'preferences';
export const NOTIFICATION_FILTER_DB_VERSION = 1;

export const MINUTES_PER_DAY = 1_440;
/** Local minutes since midnight. */
const Minute = z
  .number()
  .int()
  .min(0)
  .max(MINUTES_PER_DAY - 1);

/** The most kinds one document may hide. */
const HIDDEN_KINDS_MAX = 64;
/** The most machines one document may mute: Agenda's `MAX_REMEMBERED_MACHINES`. */
const MUTED_DAEMONS_MAX = 200;
/** The longest daemon id a document may name. */
const DAEMON_ID_MAX = 200;

/**
 * Version 2. Version 1 was Agenda's category-shaped mirror, which a worker could not evaluate without Agenda's
 * kind→category map; a v1 record reads as the default until Agenda rewrites it.
 */
export const NotificationFilterDocumentSchema = z
  .strictObject({
    version: z.literal(2),
    hiddenKinds: z.array(PushKindSchema).max(HIDDEN_KINDS_MAX).readonly(),
    mutedDaemons: z.array(z.string().min(1).max(DAEMON_ID_MAX)).max(MUTED_DAEMONS_MAX).readonly(),
    quietHours: z.strictObject({ enabled: z.boolean(), startMinute: Minute, endMinute: Minute }).readonly(),
  })
  .readonly();
export type NotificationFilterDocument = z.infer<typeof NotificationFilterDocumentSchema>;

/**
 * Everything shown, no quiet hours, nothing muted: what a worker with no or an unreadable document uses. Frozen, as
 * every document {@link readNotificationFilterDocument} answers is.
 */
export const DEFAULT_NOTIFICATION_FILTER_DOCUMENT: NotificationFilterDocument = Object.freeze({
  version: 2,
  hiddenKinds: Object.freeze([]),
  mutedDaemons: Object.freeze([]),
  quietHours: Object.freeze({ enabled: false, startMinute: 0, endMinute: 0 }),
});

/**
 * The document a stored value holds, else the default. Total: it never throws.
 *
 * - The stored value is the document's JSON TEXT, and this parses it. A value that is not a string (a structured record
 *   included) is not the stored encoding and reads as the default, so writer and reader keep one encoding.
 * - Anything else that does not parse — garbage, `null`, a v1 category record, a key the schema does not name — reads as
 *   the default.
 * - ONE OVER-BOUND FIELD RESETS THE WHOLE DOCUMENT to the default (a 201st muted machine, a 65th hidden kind, a minute
 *   past 1439). That is stricter than today's field-by-field parse, which kept the first 200 machines, and it is the safe
 *   direction: the default shows MORE, never less.
 */
export function readNotificationFilterDocument(raw: unknown): NotificationFilterDocument {
  try {
    if (typeof raw !== 'string') return DEFAULT_NOTIFICATION_FILTER_DOCUMENT;
    const parsed = NotificationFilterDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_NOTIFICATION_FILTER_DOCUMENT;
  } catch {
    return DEFAULT_NOTIFICATION_FILTER_DOCUMENT;
  }
}

/**
 * Whether `now` falls inside the quiet window, read in the device's LOCAL time. `start === end` while enabled is quiet
 * all day (a person who set identical bounds asked for quiet always, not for a window that never opens); `start > end`
 * wraps midnight.
 */
const isWithinQuietHours = (quiet: NotificationFilterDocument['quietHours'], now: Date): boolean => {
  if (!quiet.enabled) return false;
  if (quiet.startMinute === quiet.endMinute) return true;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  return quiet.startMinute < quiet.endMinute
    ? minuteOfDay >= quiet.startMinute && minuteOfDay < quiet.endMinute
    : minuteOfDay >= quiet.startMinute || minuteOfDay < quiet.endMinute;
};

/**
 * THE ONE DECISION, pure: show this push or not. Hidden when its `kind` is in `hiddenKinds`, or its `daemon` is in
 * `mutedDaemons`, or `now` is in quiet hours — today's `shouldShowNotification`, exactly. A push with no kind (an
 * enrolment confirmation) is never hidden by kind; a push tied to no machine is never muted.
 */
export function shouldShowPush(
  doc: NotificationFilterDocument,
  push: { readonly kind: string | null; readonly daemon: string | null },
  now: Date,
): boolean {
  if (push.kind !== null && doc.hiddenKinds.includes(push.kind)) return false;
  if (push.daemon !== null && doc.mutedDaemons.includes(push.daemon)) return false;
  return !isWithinQuietHours(doc.quietHours, now);
}
