/**
 * Access's wire (§2.1): ids and the views other subsystems and the app read, copied field for field from today's
 * `packages/protocol/src/lib/{pairing,push}.ts`. The rest of each route body's schema is copied by the port.
 *
 * THERE IS NO DEVICE TOKEN, AND NO SCHEMA FOR ONE. A paired device proves itself by signing each session's
 * transcript with a key it cannot export; the daemon holds only the public half, and no view here carries it.
 */
import { durationWords, InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import { CAPABILITY_NAMES, CapabilityGrantsSchema, type CapabilityName } from '@ferretry/core-gate/contract';

// ─── pairing ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const PAIRING_CODE_TTL_SECONDS = 120 as const;
/** How long an invite lives, in words ("two minutes"): every screen and help text that says it. */
export const PAIRING_CODE_LIFETIME_WORDS = durationWords(PAIRING_CODE_TTL_SECONDS);
export const PAIRING_CODE_MAX_ATTEMPTS = 5 as const;
export const PAIRING_DEVICE_NAME_MAX_LENGTH = 100 as const;
/** How long a device may go unused before it must pair again. */
export const DEVICE_IDLE_EXPIRY_DAYS = 30 as const;

/** Crockford-like symbols with the visually ambiguous 0, 1, I, L, O and U removed. A live credential: never logged. */
export const PAIRING_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/u;

export const PairingCodeSchema = z
  .string()
  .transform(value => {
    const compact = value.trim().toUpperCase().replaceAll(/[\s-]/gu, '');
    return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
  })
  .pipe(z.string().regex(PAIRING_CODE_PATTERN, 'invalid pairing code'));
export type PairingCode = z.infer<typeof PairingCodeSchema>;

/** A non-secret handle used to observe one mint. The ID and never the code goes in a URL. */
export const PairingIdSchema = z.string().regex(/^fy_pair_[A-Za-z0-9_-]{22}$/u, 'invalid pairing id');
export type PairingId = z.infer<typeof PairingIdSchema>;

/** Human-visible but attacker-influenced text. Consumers render it as text, never markup. */
export const PairingDeviceNameSchema = z
  .string()
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'device name contains a control character')
  .transform(value => value.trim())
  .pipe(z.string().min(1).max(PAIRING_DEVICE_NAME_MAX_LENGTH));

/** The redemption's own fields; travels only inside a sealed `pair` record beside the device key it registers. */
export const PairingRequestSchema = z.strictObject({
  code: PairingCodeSchema,
  deviceName: PairingDeviceNameSchema,
});
export type PairingRequest = z.infer<typeof PairingRequestSchema>;

/** A device identity, as minted for one grant on one daemon. Not a credential and never derived from one. */
export const PairedDeviceIdSchema = z.string().regex(/^fy_device_id_[A-Za-z0-9_-]{22}$/u, 'invalid device id');
export type PairedDeviceId = z.infer<typeof PairedDeviceIdSchema>;

/** A daemon id is the SHA-256 fingerprint of its persisted Ed25519 public key. */
export const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id');
export type DaemonId = z.infer<typeof DaemonIdSchema>;

export const PAIRING_GRANT_SETS = ['full', 'limited'] as const;
export type PairingGrantSet = (typeof PAIRING_GRANT_SETS)[number];
export const PairingGrantSetSchema = z.enum(PAIRING_GRANT_SETS);

/** `POST /v1/pair/code`: minting names no device, only what it will hold. */
export const PairingCodeMintRequestSchema = z.strictObject({ grants: PairingGrantSetSchema.optional() });
export type PairingCodeMintRequest = z.infer<typeof PairingCodeMintRequestSchema>;

/** `GET|DELETE /v1/pair/code/:pairingId`. */
export const PairingCodeStatusResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ pairingId: PairingIdSchema, status: z.literal('pending'), expiresAt: InstantSchema }),
  z.strictObject({
    pairingId: PairingIdSchema,
    status: z.literal('redeemed'),
    expiresAt: InstantSchema,
    redeemedAt: InstantSchema,
    /** Untrusted text: render as text content only. */
    deviceName: PairingDeviceNameSchema,
  }),
  z.strictObject({ pairingId: PairingIdSchema, status: z.literal('expired'), expiresAt: InstantSchema }),
]);
export type PairingCodeStatusResponse = z.infer<typeof PairingCodeStatusResponseSchema>;

/** One device that may reach this daemon, as anybody but the daemon may see it. No key material. */
export const PairedDeviceSchema = z.strictObject({
  id: PairedDeviceIdSchema,
  /** Untrusted text: render as text content only. */
  name: PairingDeviceNameSchema,
  platform: z.literal('browser'),
  createdAt: InstantSchema,
  lastSeenAt: InstantSchema,
  idleExpiresAt: InstantSchema,
  /** How the redemption arrived: at the bound address, or over the relay. */
  pairedOver: z.enum(['direct', 'relay']).optional(),
  /** What THIS device has been granted, before the daemon-wide grants are applied. */
  grants: CapabilityGrantsSchema,
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

/** `GET /v1/pair/devices`: who may reach this daemon, plus the facts a screen needs before it offers a change. */
export const PairedDevicesViewSchema = z.strictObject({
  devices: z.array(PairedDeviceSchema).readonly(),
  /** How the request ARRIVED, decided from the carrier, never from an address, a `Host` header or a URL. */
  hostLocal: z.boolean(),
  thisDeviceId: PairedDeviceIdSchema.optional(),
  /** Which axes THIS caller may turn ON for a device (a passkey is still asked at the change). */
  mayWiden: CapabilityGrantsSchema,
});
export type PairedDevicesView = z.infer<typeof PairedDevicesViewSchema>;

/** `GET /v1/pair/identity`: which daemon this is, its public fingerprint and nothing else. */
export const DaemonIdentityViewSchema = z.strictObject({ daemonId: DaemonIdSchema });
export type DaemonIdentityView = z.infer<typeof DaemonIdentityViewSchema>;

/** `PATCH /v1/pair/devices/:deviceId/grants`: partial, judged field by field, refused WHOLE on an illegal widen. */
export const DeviceGrantsPatchSchema = z
  .strictObject(
    Object.fromEntries(
      CAPABILITY_NAMES.map(capability => [
        capability,
        z.strictObject({ use: z.boolean().optional(), configure: z.boolean().optional() }).optional(),
      ]),
    ) as {
      readonly [K in CapabilityName]: z.ZodOptional<
        z.ZodObject<{ use: z.ZodOptional<z.ZodBoolean>; configure: z.ZodOptional<z.ZodBoolean> }>
      >;
    },
  )
  .refine(
    patch => Object.values(patch).some(value => value !== undefined),
    'a device grant patch must change something',
  );
export type DeviceGrantsPatch = z.infer<typeof DeviceGrantsPatchSchema>;

// ─── push ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'] as const;
export const PUSH_SERVICE_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'] as const;

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
    if (endpoint.port !== '' || !isPushServiceHost(endpoint.hostname))
      context.addIssue({ code: 'custom', message: 'endpoint must be a browser push service' });
  });

const PushDeviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u);

export const BrowserPushSubscriptionSchema = z.strictObject({
  endpoint: PushEndpointSchema,
  expirationTime: NonNegativeFiniteSchema.nullable(),
  keys: z.strictObject({ p256dh: z.base64url().length(87), auth: z.base64url().length(22) }),
});
export type BrowserPushSubscription = z.infer<typeof BrowserPushSubscriptionSchema>;

/** `POST /v1/push/subscriptions`. Which events a device shows is the device's own choice, never stored here. */
export const RegisterPushDeviceRequestSchema = z.strictObject({
  deviceName: PushDeviceNameSchema,
  subscription: BrowserPushSubscriptionSchema,
});
export type RegisterPushDeviceRequest = z.infer<typeof RegisterPushDeviceRequestSchema>;

export const PushIdSchema = z.string().regex(/^push-[0-9a-f-]{36}$/u);
export const PushDeviceViewSchema = z.strictObject({
  id: PushIdSchema,
  deviceName: PushDeviceNameSchema,
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  expirationTime: NonNegativeFiniteSchema.nullable(),
});
export type PushDeviceView = z.infer<typeof PushDeviceViewSchema>;

export const PushDeviceListResponseSchema = z.strictObject({ devices: z.array(PushDeviceViewSchema) });
export type PushDeviceListResponse = z.infer<typeof PushDeviceListResponseSchema>;

/** `GET /v1/push/vapid`: the application-server PUBLIC key. Never the private half. */
export const VapidPublicKeyResponseSchema = z.strictObject({ publicKey: z.string().min(1) });
export type VapidPublicKeyResponse = z.infer<typeof VapidPublicKeyResponseSchema>;

export const PushDeliveryResultSchema = z.strictObject({
  delivered: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
});
export type PushDeliveryResult = z.infer<typeof PushDeliveryResultSchema>;

/** One buzz as another plugin hands it to Access (Agenda's `uses`): words only, never a secret. */
export const BuzzSchema = z.strictObject({
  tag: z.string().min(1).max(200),
  title: z.string().min(1),
  body: z.string(),
  url: z.string().min(1),
});
export type Buzz = z.infer<typeof BuzzSchema>;

// ─── state (§9.2: devices.json, passkeys.json, unlocks.json, push.json, push-keys.json) ───────────────────────────

/** `state/access/devices.json`: each device's public key and grants. The public key never crosses the wire. */
export const DevicesFileSchema = z.strictObject({
  format: z.literal(1),
  devices: z.array(
    z.strictObject({
      id: PairedDeviceIdSchema,
      name: PairingDeviceNameSchema,
      /** The device's non-extractable signing key, public half (SPKI, base64url). */
      publicKey: z.base64url().min(1).max(512),
      createdAt: InstantSchema,
      lastSeenAt: InstantSchema,
      pairedOver: z.enum(['direct', 'relay']).optional(),
      grants: CapabilityGrantsSchema,
    }),
  ),
});
export type DevicesFile = z.infer<typeof DevicesFileSchema>;
