import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

/**
 * `agenda` is the later spelling of `attention`: accepted now, sent only from the agenda removal release, because an
 * older app's worker parses this enum and drops a kind it does not know.
 *
 * `device-paired` is the one kind a payload about NO session may carry (see
 * `PushNotificationPayloadSchema`): every other kind narrates a session's own transition and is
 * meaningless without one.
 */
export const PushNotificationKindSchema = z.enum([
  'attention',
  'agenda',
  'question',
  'failed',
  'completed',
  'device-paired',
]);
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

/**
 * `prefs` is deliberately NOT read or stored any more. Which events a device hears about is a
 * decision this device makes about itself, never one the daemon enforces on its behalf: every
 * daemon sends every event to every live enrolment, and each browser's own local preferences decide
 * what it shows (see the client-side notification filter in
 * `packages/pwa/src/lib/notification-filter.ts`).
 *
 * `prefs` IS STILL NAMED HERE, as the one field this `strictObject` accepts without reading —
 * version skew, not an oversight. The daemon and the PWA upgrade independently, so a browser still
 * running last release's bundle keeps sending the preference bundle this endpoint used to require;
 * refusing that body with the strict rejection every OTHER unexpected field still gets (see
 * `push_device_required` and the mount's own tests) would turn an ordinary rolling deploy into a
 * registration outage. The PWA keeps sending a harmless placeholder for one release for the mirror
 * case — an old, not-yet-upgraded daemon whose schema still REQUIRES `prefs` — see
 * `packages/pwa/src/lib/push-subscriptions.ts`. Remove this field once that compatibility window has
 * passed and every daemon in the field has upgraded past the one that required it.
 */
export const RegisterPushDeviceRequestSchema = z.strictObject({
  deviceName: PushDeviceNameSchema,
  subscription: BrowserPushSubscriptionSchema,
  prefs: z.unknown().optional(),
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
 * hours (the owner's ask: "for 2FA notification, please make it high priority"). The approve-on-phone card adds its
 * own subject here and nothing else changes.
 */
export type PushSubject = 'one-time-code' | 'other';
const URGENT_SUBJECTS: ReadonlySet<PushSubject> = new Set(['one-time-code']);

/** THE ONE RULE: which pushes are high priority. Everything else stays `normal`, which is also what an absent header means. */
export function pushUrgencyFor(subject: PushSubject): PushUrgency {
  return URGENT_SUBJECTS.has(subject) ? 'high' : 'normal';
}

/**
 * How long a push service holds a HIGH push it could not deliver: a one-time code card lives ten minutes by default
 * (`INPUT_DEFAULT_EXPIRY_SECONDS`), so a buzz later than that is about a code that has expired.
 */
export const PUSH_URGENT_TTL_SECONDS = 600;

const PushPayloadBaseShape = {
  version: z.literal(1),
  eventKey: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  tag: z.string().min(1),
  url: z.string().min(1),
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

export const PushDeliveryResultSchema = z.object({
  delivered: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
});
export type PushDeliveryResult = z.infer<typeof PushDeliveryResultSchema>;

export const PushErrorCodeSchema = z.enum(['invalid', 'corrupt_store', 'not_found']);
export type PushErrorCode = z.infer<typeof PushErrorCodeSchema>;
