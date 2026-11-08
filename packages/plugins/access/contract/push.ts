import { PushEnvelopeFields } from '@ferretry/kernel/contract';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

const MAX_AGENDA_PER_SESSION = 20;
const MAX_AGENDA_RESOLUTIONS = 100;

/**
 * `device-paired` is the one kind a payload about NO session may carry (see
 * `PushNotificationPayloadSchema`): every other kind narrates a session's own transition and is
 * meaningless without one.
 */
export const PushNotificationKindSchema = z.enum(['agenda', 'question', 'failed', 'completed', 'device-paired']);
export type PushNotificationKind = z.infer<typeof PushNotificationKindSchema>;

/**
 * The push services a subscription may point at: the hosts every major browser's push service runs on.
 *
 * WHY AN ALLOWLIST. The daemon POSTs to the endpoint — at once, as an enrolment confirmation, and on every
 * later notification — from the host's own network position. An endpoint that could be any HTTPS URL
 * would make every paired device a way to send requests to the host's LAN, tailnet or cloud metadata
 * address. A browser only ever hands out an endpoint on its vendor's push service, so nothing a real
 * browser produces is refused. A browser whose push service is not here cannot enrol, which is the
 * declared cost.
 */
export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'] as const;
/** Push services that shard by subdomain: Apple's (Safari) and Microsoft's WNS (Edge). */
export const PUSH_SERVICE_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'] as const;

/**
 * Whether each push service above lets a site's push show nothing (docs/notifications.md § When an alert is cleared).
 * FCM and WNS do; Apple's revokes a subscription whose push shows nothing, and Mozilla's does once a small quota of
 * such pushes is spent. Keyed by the allowlist itself, so a service added there must be classified here.
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

const PushEndpointSchema = z
  .url()
  .max(4_096)
  .superRefine((value, context) => {
    if (!URL.canParse(value)) return;
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint must be an HTTPS URL without credentials' });
      return;
    }
    // The default port only: a push service listens on 443, and any other port is somebody else's server.
    if (endpoint.port !== '' || !isPushServiceHost(endpoint.hostname))
      context.addIssue({ code: 'custom', message: 'endpoint must be a browser push service' });
  });

const P256dhSchema = z.base64url().length(87);
const AuthSecretSchema = z.base64url().length(22);

const PushDeviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u);

export const BrowserPushSubscriptionSchema = z.strictObject({
  endpoint: PushEndpointSchema,
  expirationTime: NonNegativeFiniteSchema.nullable(),
  keys: z.strictObject({
    p256dh: P256dhSchema,
    auth: AuthSecretSchema,
  }),
});
export type BrowserPushSubscription = z.infer<typeof BrowserPushSubscriptionSchema>;

export const RegisterPushDeviceRequestSchema = z.strictObject({
  deviceName: PushDeviceNameSchema,
  subscription: BrowserPushSubscriptionSchema,
});
export type RegisterPushDeviceRequest = z.infer<typeof RegisterPushDeviceRequestSchema>;

export const PushDeviceViewSchema = z.object({
  id: z.string().regex(/^push-[0-9a-f-]{36}$/u),
  deviceName: PushDeviceNameSchema,
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  expirationTime: NonNegativeFiniteSchema.nullable(),
});
export type PushDeviceView = z.infer<typeof PushDeviceViewSchema>;

export const PushDeviceListResponseSchema = z.object({
  devices: z.array(PushDeviceViewSchema),
});
export type PushDeviceListResponse = z.infer<typeof PushDeviceListResponseSchema>;

export const VapidPublicKeyResponseSchema = z.object({
  publicKey: z.string().min(1),
});
export type VapidPublicKeyResponse = z.infer<typeof VapidPublicKeyResponseSchema>;

/**
 * HOW URGENTLY A PUSH SERVICE SHOULD DELIVER A MESSAGE (RFC 8030 §5.3, the `Urgency` header). A push service may
 * hold a `normal` message while a phone saves battery; `high` asks it not to. Whether a service honours it is its own
 * choice (docs/notifications.md, "High priority").
 */
export const PUSH_URGENCIES = ['very-low', 'low', 'normal', 'high'] as const;
export const PushUrgencySchema = z.enum(PUSH_URGENCIES);
export type PushUrgency = z.infer<typeof PushUrgencySchema>;

/**
 * What a push is about, as far as how fast it must reach a phone. A one-time code is waited on for minutes, not
 * hours (the owner's ask: "for 2FA notification, please make it high priority"), and so is a push the owner approves
 * on their phone (`approve-on-phone`, docs/input-requests.md "Approve on your phone"): the sign-in gives up on it in a
 * minute or two.
 */
export type PushSubject = 'one-time-code' | 'approve-on-phone' | 'other';
const URGENT_SUBJECTS: ReadonlySet<PushSubject> = new Set(['one-time-code', 'approve-on-phone']);

/** THE ONE RULE: which pushes are high priority. Everything else stays `normal`, which is also what an absent header means. */
export function pushUrgencyFor(subject: PushSubject): PushUrgency {
  return URGENT_SUBJECTS.has(subject) ? 'high' : 'normal';
}

/**
 * How long a push service holds a HIGH push it could not deliver: a one-time code card lives ten minutes by default
 * (`INPUT_DEFAULT_EXPIRY_SECONDS`), so a buzz later than that is about a code that has expired.
 */
export const PUSH_URGENT_TTL_SECONDS = 600;

/**
 * Every payload is the SHELL WORKER's push envelope (`title`, `body`, `url`, declared once in the kernel contract, where
 * the signed service worker reads it too) plus the fields only this plugin and the daemon read. The title and body carry
 * no secret, token or pairing code.
 */
const PushPayloadBaseShape = {
  version: z.literal(1),
  eventKey: z.string().min(1),
  ...PushEnvelopeFields,
  tag: z.string().min(1),
  count: PositiveIntegerSchema,
  /**
   * A high-priority push: the service worker asks the platform to keep it on screen and to sound again. Only `high`
   * travels; an absent key is every other push. A service worker older than this field reads the payload as one it
   * did not compose and still shows a plain "something is waiting" notification, never nothing.
   */
  urgency: z.literal('high').optional(),
};

/**
 * Every kind but `device-paired` narrates one session's own transition and is meaningless without
 * one, so it is confined to the session-scoped variant below. `device-paired` is the one event that
 * is never about a session — a new browser reached this machine — so it is the only kind the
 * no-session variant may carry, and carrying it is what lets the client-side filter (see
 * `packages/pwa/src/lib/notification-filter.ts`) tell it apart from an unclassified payload such as
 * `enrolmentConfirmation`, which has no kind at all and is always shown.
 */
export const PushNotificationPayloadSchema = z.union([
  z.strictObject({
    ...PushPayloadBaseShape,
    sessionId: z.string().min(1),
    kind: PushNotificationKindSchema.exclude(['device-paired']),
  }),
  z.strictObject({
    ...PushPayloadBaseShape,
    kind: z.literal('device-paired').optional(),
  }),
]);
export type PushNotificationPayload = z.infer<typeof PushNotificationPayloadSchema>;

/** The most tags one clear may name: an item's own tag, its approval's, the ferret's stop tag, and room to spare. */
export const PUSH_CLEAR_MAX_TAGS = 8;

/** One un-namespaced daemon tag a clear names (`attention-<sessionId>:<itemId>`, `pa-<id>`): printable, bounded. */
const PushTagSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}\s]+$/u);

/**
 * A CLEAR: the item these alerts were about was handled — answered, resolved, resting, snoozed, on the ferret's turn,
 * or opened in the app on another device — so every device takes its alerts down (docs/notifications.md § When an
 * alert is cleared).
 *
 * IT CARRIES NO CONTENT, and that is the parser's job, not a convention: no title, no body, no url, no count, no item
 * words — only which of this machine's own tags to take down. The worker keeps each tag inside the machine's
 * namespace, so a clear can never touch another machine's notifications. It is not a {@link PushNotificationPayload}:
 * a clear is never shown as itself, so the type that every notification is composed from cannot hold one.
 *
 * A service worker older than this kind reads it as a payload it did not compose and shows its plain fallback line;
 * the hosted app ships before a daemon release does, so that window is one app open long (docs/notifications.md).
 */
export const PushClearPayloadSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('clear'),
  eventKey: z.string().min(1).max(400),
  sessionId: z.string().min(1).max(200),
  tags: z.array(PushTagSchema).min(1).max(PUSH_CLEAR_MAX_TAGS),
});
export type PushClearPayload = z.infer<typeof PushClearPayloadSchema>;

/** Everything a daemon's push may carry: a notification to show, or a clear of ones already shown. */
export const PushPayloadSchema = z.union([PushNotificationPayloadSchema, PushClearPayloadSchema]);
export type PushPayload = z.infer<typeof PushPayloadSchema>;

export const PushDeliveryResultSchema = z.object({
  delivered: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
});
export type PushDeliveryResult = z.infer<typeof PushDeliveryResultSchema>;

export const PushErrorCodeSchema = z.enum(['invalid', 'corrupt_store', 'not_found']);
export type PushErrorCode = z.infer<typeof PushErrorCodeSchema>;

/**
 * The most tags one `seen` answers: as many as one board can name — the ferret's own, and an item's and its approval's
 * for each open and retained resolved item. A daemon answers no more than this: a clear past it goes to every device,
 * the caller's too (`AgendaAlertClearer.seen`).
 */
export const PUSH_SEEN_MAX_TAGS = 1 + 2 * (MAX_AGENDA_PER_SESSION + MAX_AGENDA_RESOLUTIONS);

/**
 * Whether a clear went out, and the tags it named (`PushClearPayloadSchema`'s), empty when nothing of that item's was
 * still up. The clear skipped the caller's own device, so its page takes these tags down there itself.
 */
export const PushSeenResponseSchema = z.strictObject({
  cleared: z.boolean(),
  tags: z.array(PushTagSchema).max(PUSH_SEEN_MAX_TAGS),
});
export type PushSeenResponse = z.infer<typeof PushSeenResponseSchema>;

/**
 * THE TAG ONE AGENDA ITEM'S PUSH GOES OUT UNDER: its own, so a clear can take down exactly that item's line on every
 * device (docs/notifications.md § When an alert is cleared). A ferret with two pushed items therefore shows two lines.
 * The daemon composes it and the app's page names it when the owner opens the item, so it is spelled once, here.
 */
export const agendaItemPushTag = (sessionId: string, itemId: string): string => `attention-${sessionId}:${itemId}`;

/**
 * The tag a STOP's push goes out under: it is about the ferret, not one item. Every agenda push used it before items
 * had their own, so a push the ledger records without a tag was shown under it.
 */
export const agendaSessionPushTag = (sessionId: string): string => `attention-${sessionId}`;
