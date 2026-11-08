import { z } from 'zod';

/**
 * THE ONE PUSH ENVELOPE: `title`, `body`, `url` — the only fields of a push the shell's signed service worker reads, and
 * the fields every plugin's push payload carries. Declared once, here, so the worker (which runs no plugin code) and a
 * plugin's contract (Access's `PushNotificationPayloadSchema`) cannot disagree about a cap.
 *
 * - `title` and `body` are the notification's words, composed by the daemon. They carry no secret, token or pairing code.
 * - `url` is a page NAMED RELATIVE TO THE MACHINE'S OWN PAGES (`/ferrets/<id>/chat?ask=A3`). It is a request, not an
 *   address: the shell opens it only after its own route parse accepts it. THE SCHEMA BOUNDS ONLY ITS LENGTH; the grammar
 *   belongs to the shell's route parse (`PUSH_TAP_SCREENS`), and an address it refuses opens the app, so it is deliberately
 *   not checked here (that would turn "opens the app" into "unreadable push").
 *
 * The caps count UTF-16 code units and are a safety bound, not a size budget: a push service accepts roughly 4 KiB of
 * encrypted payload, and the sender owns fitting that.
 *
 * Strict and length-capped: a field that is missing, not a string, or over its cap makes the whole envelope unreadable,
 * and an unreadable push is shown plainly with no page. A push payload is not trusted input.
 *
 * BEYOND THE THREE (ruling #53), declarative data only, because the worker runs no plugin code: a show may carry a
 * `tag` to replace and clear by, a `kind` to filter on, a `count` to group by and an `urgency`; a `clear` names
 * tags and nothing else; and the push-service table says where a push may show nothing. {@link readPushMessage} is what
 * the worker reads. All of it is optional, so an older daemon's three-field push still reads as a show.
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

/**
 * ONE DAEMON TAG, un-namespaced (`attention-<session>:<item>`, `agenda-<ferret>:<ask>`, `pa-<id>`). A show carries one so
 * a later show REPLACES its line and a clear can TAKE IT DOWN; the worker namespaces it per machine
 * (`fy-push:<daemon>:<tag>`), so one machine's tag can never name another machine's line.
 *
 * The charset is the one a notification tag, a URL component and a log line all carry without escaping: ASCII letters,
 * digits and `.`, `_`, `:`, `-`. No space, no `/`, no `#`, no control or non-ASCII character. A sender composes tags
 * through this schema, so a tag outside it is refused WHERE IT IS SENT, never silently unreadable at the worker.
 */
export const PUSH_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const PushTagSchema = z.string().regex(PUSH_TAG_PATTERN);

/** The kind a clear carries. No show may carry it: a payload naming it is read as a clear. */
const CLEAR_KIND = 'clear';

/**
 * A SHOW'S FILTER KEY (Access's `PushNotificationKind` values today: `agenda`, `question`, `failed`, `completed`,
 * `device-paired`). The worker matches it against the device's filter document (`./notification-filter.ts`), so it is a
 * key, never words. `clear` is reserved for the clear kind.
 */
export const PUSH_KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const PushKindSchema = z
  .string()
  .regex(PUSH_KIND_PATTERN)
  .refine(kind => kind !== CLEAR_KIND, 'reserved');

/** The most one grouped line may say it holds: a safety bound, never a size budget. */
export const PUSH_COUNT_MAX = 999;
/** The most tags one clear may name. A sender may bound itself tighter (Access sends at most 8). */
export const PUSH_CLEAR_MAX_TAGS = 32;

/**
 * The fields a SHOW may carry beyond the three. All optional: absent is today's behaviour (an untagged show gets no tag,
 * a kind-less show is never hidden by kind, no count is no grouping, no urgency is an ordinary push).
 */
export const PushShowFields = {
  ...PushEnvelopeFields,
  tag: PushTagSchema.optional(),
  kind: PushKindSchema.optional(),
  count: z.number().int().min(1).max(PUSH_COUNT_MAX).optional(),
  urgency: z.literal('high').optional(),
};
export const PushShowSchema = z.strictObject(PushShowFields);

/**
 * A CLEAR: which of this machine's tags are no longer true. NO TEXT FIELD EXISTS, so none can be read: a clear never
 * shows its own words, and the worker's quiet "Handled on another device" line is the worker's own.
 */
export const PushClearSchema = z.strictObject({
  kind: z.literal(CLEAR_KIND),
  tags: z.array(PushTagSchema).min(1).max(PUSH_CLEAR_MAX_TAGS),
});

export type PushShow = z.infer<typeof PushShowSchema>;
export type PushClear = z.infer<typeof PushClearSchema>;
export type PushMessage =
  | { readonly type: 'show'; readonly show: PushShow }
  | { readonly type: 'clear'; readonly clear: PushClear };

const SHOW_KEYS = ['title', 'body', 'url', 'tag', 'kind', 'count', 'urgency'] as const;
const CLEAR_KEYS = ['kind', 'tags'] as const;

/** The named keys the record itself holds (never its prototype's), each present key copied, each absent one omitted. */
const pick = (record: object, keys: readonly string[]): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const value: unknown = (record as Record<string, unknown>)[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
};

/**
 * WHAT THE WORKER READS FROM ONE PUSH. Total: it never throws, whatever the JSON (a throwing getter or a proxy included).
 *
 * The payload also carries the plugin's own fields (`version`, `eventKey`, `sessionId`), which are the plugin's and not
 * the worker's, so the worker's fields are PICKED BY NAME, then parsed strictly:
 * - `kind === 'clear'` → only `kind` and `tags` are picked → {@link PushClearSchema}. Any `title` or `body` beside them
 *   is never read, so a clear's value holds no text.
 * - anything else → `title`, `body`, `url`, `tag`, `kind`, `count`, `urgency` (absent keys omitted) →
 *   {@link PushShowSchema}. A three-field push from an older daemon reads as a show with none of the optional fields.
 *
 * `null` is UNREADABLE: one field out of bounds fails the whole message, and the worker shows its plain fallback line,
 * as it does today.
 */
export function readPushMessage(json: unknown): PushMessage | null {
  try {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
    if (Object.hasOwn(json, 'kind') && (json as Record<string, unknown>).kind === CLEAR_KIND) {
      const clear = PushClearSchema.safeParse(pick(json, CLEAR_KEYS));
      return clear.success ? { type: 'clear', clear: clear.data } : null;
    }
    const show = PushShowSchema.safeParse(pick(json, SHOW_KEYS));
    return show.success ? { type: 'show', show: show.data } : null;
  } catch {
    return null;
  }
}

/**
 * The push services a device may enrol with: the hosts every major browser's push service runs on.
 *
 * WHY AN ALLOWLIST. The daemon POSTs to the endpoint — at once, as an enrolment confirmation, and on every later
 * notification — from the host's own network position. An endpoint that could be any HTTPS URL would make every paired
 * device a way to send requests to the host's LAN, tailnet or cloud metadata address. A browser only ever hands out an
 * endpoint on its vendor's push service, so nothing a real browser produces is refused. A browser whose push service is
 * not here cannot enrol, which is the declared cost.
 *
 * Declared here, not in Access, so the signed worker can apply the clear rule ({@link pushServiceAllowsSilent}) without a
 * plugin import. Access re-exports these; it owns no copy.
 */
export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'] as const;
/** Push services that shard by subdomain: Apple's (Safari) and Microsoft's WNS (Edge). */
export const PUSH_SERVICE_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'] as const;

/**
 * Whether each push service above lets a site's push show nothing (owner decision !A324; docs/notifications.md § When
 * an alert is cleared). FCM and WNS do; Apple's revokes a subscription whose push shows nothing, and Mozilla's does once
 * a small quota of such pushes is spent. Keyed by the allowlist itself, so a service added there must be classified here.
 */
export const PUSH_SERVICE_ALLOWS_SILENT: Readonly<
  Record<(typeof PUSH_SERVICE_HOSTS)[number] | (typeof PUSH_SERVICE_HOST_SUFFIXES)[number], boolean>
> = {
  'fcm.googleapis.com': true,
  'updates.push.services.mozilla.com': false,
  '.push.apple.com': false,
  '.notify.windows.com': true,
};

/** Whether a push service's host lets a push show nothing (`PUSH_SERVICE_ALLOWS_SILENT`); a host not listed does not. */
export function pushServiceAllowsSilent(host: string): boolean {
  const name = host.toLowerCase();
  if ((PUSH_SERVICE_HOSTS as readonly string[]).includes(name))
    return PUSH_SERVICE_ALLOWS_SILENT[name as (typeof PUSH_SERVICE_HOSTS)[number]];
  const suffix = PUSH_SERVICE_HOST_SUFFIXES.find(each => name.endsWith(each) && name.length > each.length);
  return suffix === undefined ? false : PUSH_SERVICE_ALLOWS_SILENT[suffix];
}

/** Whether a host is one of the push services above. Exact, lowercased, and never an IP literal. */
export function isPushServiceHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    (PUSH_SERVICE_HOSTS as readonly string[]).includes(name) ||
    PUSH_SERVICE_HOST_SUFFIXES.some(suffix => name.endsWith(suffix) && name.length > suffix.length)
  );
}
