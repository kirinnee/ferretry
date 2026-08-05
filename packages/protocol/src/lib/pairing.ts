import { z } from 'zod';
import { InstantSchema } from './common.ts';

/** Pairing codes are deliberately short-lived and have a small online-attempt budget. */
export const PAIRING_CODE_TTL_SECONDS = 120 as const;
export const PAIRING_CODE_MAX_ATTEMPTS = 5 as const;
export const PAIRING_DEVICE_NAME_MAX_LENGTH = 100 as const;

/** Crockford-like symbols with the visually ambiguous 0, 1, I, L, O and U removed. */
export const PAIRING_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/u;

export const PairingCodeSchema = z
  .string()
  .transform(value => {
    const compact = value.trim().toUpperCase().replaceAll(/[\s-]/gu, '');
    return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
  })
  .pipe(z.string().regex(PAIRING_CODE_PATTERN, 'invalid pairing code'));
export type PairingCode = z.infer<typeof PairingCodeSchema>;

/** A non-secret handle used only by the authenticated local CLI to observe one mint. */
export const PairingIdSchema = z.string().regex(/^fy_pair_[A-Za-z0-9_-]{22}$/u, 'invalid pairing id');
export type PairingId = z.infer<typeof PairingIdSchema>;

/** Human-visible but attacker-influenced text. Consumers must render it as text, never markup. */
export const PairingDeviceNameSchema = z
  .string()
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'device name contains a control character')
  .transform(value => value.trim())
  .pipe(z.string().min(1).max(PAIRING_DEVICE_NAME_MAX_LENGTH));

/** The unauthenticated exchange. The one-time code is the credential for this request. */
export const PairingRequestSchema = z.strictObject({
  code: PairingCodeSchema,
  deviceName: PairingDeviceNameSchema,
});
export type PairingRequest = z.infer<typeof PairingRequestSchema>;

/** Device credentials are visibly typed and carry 256 random bits encoded as base64url. */
export const DeviceTokenSchema = z.string().regex(/^fy_device_[A-Za-z0-9_-]{43}$/u, 'invalid device token');
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;

/** A daemon id is the SHA-256 fingerprint of its persisted Ed25519 public key. */
export const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id');
export type DaemonId = z.infer<typeof DaemonIdSchema>;

/** A daemon name is also rendered into remote browser UI, so it obeys the same text safety bound. */
export const DaemonNameSchema = z
  .string()
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'daemon name contains a control character')
  .transform(value => value.trim())
  .pipe(z.string().min(1).max(PAIRING_DEVICE_NAME_MAX_LENGTH));

/** Capability names are opaque and forward-compatible; empty means no remote surface is granted. */
export const PairingCapabilitySchema = z.string().trim().min(1).max(64);

export const PairingResponseSchema = z.strictObject({
  deviceToken: DeviceTokenSchema,
  daemonId: DaemonIdSchema,
  daemonName: DaemonNameSchema,
  capabilities: z.array(PairingCapabilitySchema).max(64).readonly(),
});
export type PairingResponse = z.infer<typeof PairingResponseSchema>;

/** Minting is intentionally bodyless: the redeeming device supplies its own bounded name. */
export const PairingCodeMintRequestSchema = z.strictObject({});
export type PairingCodeMintRequest = z.infer<typeof PairingCodeMintRequestSchema>;

export const PairingCodeMintResponseSchema = z
  .strictObject({
    pairingId: PairingIdSchema,
    code: PairingCodeSchema,
    ttlSeconds: z.literal(PAIRING_CODE_TTL_SECONDS),
    expiresAt: InstantSchema,
    daemonId: DaemonIdSchema,
    daemonName: DaemonNameSchema,
    daemonUrl: z.url(),
    /** Public-PWA URL with the code in its fragment, where it cannot reach an HTTP access log. */
    pairUrl: z.url(),
  })
  .superRefine((value, context) => {
    const url = new URL(value.pairUrl);
    const expectedFragment = `#v1;url=${encodeURIComponent(value.daemonUrl)};code=${value.code};fp=${encodeURIComponent(value.daemonId)}`;
    if (url.search !== '' || url.hash !== expectedFragment) {
      context.addIssue({
        code: 'custom',
        path: ['pairUrl'],
        message: 'pairing URL must carry only the matching daemon, code and fingerprint in its fragment',
      });
    }
  });
export type PairingCodeMintResponse = z.infer<typeof PairingCodeMintResponseSchema>;

export const PairingCodeStatusResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    pairingId: PairingIdSchema,
    status: z.literal('pending'),
    expiresAt: InstantSchema,
  }),
  z.strictObject({
    pairingId: PairingIdSchema,
    status: z.literal('redeemed'),
    expiresAt: InstantSchema,
    redeemedAt: InstantSchema,
    /** Untrusted text: render as text content only. */
    deviceName: PairingDeviceNameSchema,
  }),
  z.strictObject({
    pairingId: PairingIdSchema,
    status: z.literal('expired'),
    expiresAt: InstantSchema,
  }),
]);
export type PairingCodeStatusResponse = z.infer<typeof PairingCodeStatusResponseSchema>;

/** A device identity, as minted for one grant on one daemon. Not a credential and never derived from one. */
export const PairedDeviceIdSchema = z.string().regex(/^fy_device_id_[A-Za-z0-9_-]{22}$/u, 'invalid device id');
export type PairedDeviceId = z.infer<typeof PairedDeviceIdSchema>;

/**
 * One device that may reach this daemon, as anybody but the daemon may see it.
 *
 * THE DIGEST IS NOT HERE, AND THAT IS THE POINT. A device grant is stored as `{ …, tokenHash }`, and
 * this schema is the projection that crosses the wire — so "no route returns a credential or anything
 * derived from one" is a property of the type rather than a discipline every handler has to remember.
 * A digest is not a token, but it is the only thing standing between a leaked file and a forged one,
 * and a UI has no use for it.
 *
 * `name` is chosen by the redeeming device and is therefore ATTACKER-INFLUENCED TEXT. It is bounded and
 * control-character-free by `PairingDeviceNameSchema`, and consumers must render it as text content.
 */
export const PairedDeviceSchema = z.strictObject({
  id: PairedDeviceIdSchema,
  /** Untrusted text: render as text content only. */
  name: PairingDeviceNameSchema,
  platform: z.literal('browser'),
  createdAt: InstantSchema,
  lastSeenAt: InstantSchema,
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

/**
 * Who may reach one daemon, plus the two facts a UI needs before it offers to change that.
 *
 * ONE READ, NOT A PROBE PER CONTROL. A screen that discovers its own limits by watching calls fail
 * cannot explain anything before somebody presses a button, and explaining before the press is the
 * whole requirement — the same reason `GrantsViewSchema` answers in one call.
 *
 * `hostLocal` is HOW THE REQUEST ARRIVED, decided from the carrier and never from an address, a `Host`
 * header or a URL (see `docs/grants.md`). It is on the view because it is the difference between "this
 * button works and nothing is gating it" and "this button needs the operator's grant", and a browser
 * cannot tell which it is: a relayed hop terminates on the very host it serves, so the address this
 * browser dialled says nothing about how the daemon received it.
 *
 * It is the SAME fact `GrantsView.governed` carries, inverted, and there is one source for both —
 * `ApiRequest.loopback`, which the transport sets and no header can move. Each view spells it from its
 * own screen's point of view: a grant surface talks about whether the operator's answers govern you, a
 * pairing surface talks about whether you are standing at the machine. Neither re-derives it, so they
 * cannot drift; if you are changing one of these, the other is the thing to read first.
 *
 * `thisDeviceId` names the caller's OWN grant when the caller is a paired device, so a list of
 * revocable devices can mark the one whose revocation ends this session. Absent for the host's own
 * admin credential, which is not a paired device and cannot be revoked from here.
 */
export const PairedDevicesViewSchema = z.strictObject({
  devices: z.array(PairedDeviceSchema).readonly(),
  hostLocal: z.boolean(),
  thisDeviceId: PairedDeviceIdSchema.optional(),
});
export type PairedDevicesView = z.infer<typeof PairedDevicesViewSchema>;
