import { z } from 'zod';
import { isLoopbackHost, isWildcardHost } from './address.ts';
import { ADVERTISEMENT_REFUSALS, type AdvertisementRefusal } from './advertisement.ts';
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

/**
 * WHO CAN REDEEM A MINTED LINK, on the wire.
 *
 * The wire's vocabulary, not the decision's: `decideAdvertisement` answers in three kinds and the
 * third one has no address at all, which this response expresses by ABSENCE rather than by a third
 * value. So there are two reaches and a `refusal`, and the presence invariant below keeps them from
 * ever describing two different states at once.
 */
export const PAIRING_REACHES = ['any-device', 'local-only'] as const;
export type PairingReach = (typeof PAIRING_REACHES)[number];

/**
 * A minted code, and — SEPARATELY — whether there is an address to hand out with it.
 *
 * ## THE CODE IS MINTED EVEN WHEN THE LINK CANNOT BE
 *
 * A daemon with no advertisable address is still a working daemon, and its code is still redeemable
 * by a browser somebody points at it themselves. So a refusal withholds the LINK, never the code:
 * refusing the mint would break every default single-machine install, and that is the outcome this
 * response shape exists to avoid.
 *
 * ## TWO INVARIANTS, AND THE SECOND ONE IS NEW
 *
 * A LINK MAY NOT DISAGREE WITH THE DAEMON IT NAMES: when there is a link, its fragment must carry
 * exactly the daemon, code and fingerprint it was minted with, and no query string. That is what
 * stops any layer below the configuration from advertising a different address.
 *
 * A LINK MAY NOT ARRIVE WITHOUT SAYING WHO CAN REDEEM IT, and after this schema none does.
 * `superRefine` enforces all four presence relationships together: `pairUrl` and `reach` are present
 * exactly when `daemonUrl` is, while `refusal` is present exactly when it is not. A link with no
 * `reach` is how a QR nothing off the host could dial reached a phone in the first place — and the
 * one writer that can still emit one is a daemon older than the question, whose response
 * `withDeclaredReach` answers from its own address BEFORE the invariant is checked. So the invariant
 * holds over every parsed value while the wire stays readable in both directions.
 */
/** What every mint carries, link or no link: the code, its clock, and the daemon that minted it. */
const mintedCode = {
  pairingId: PairingIdSchema,
  code: PairingCodeSchema,
  ttlSeconds: z.literal(PAIRING_CODE_TTL_SECONDS),
  expiresAt: InstantSchema,
  daemonId: DaemonIdSchema,
  daemonName: DaemonNameSchema,
} as const;

/** The fields as they arrive, before the compatibility answer below fills in what an old writer omitted. */
const mintedFields = z.strictObject({
  ...mintedCode,
  daemonUrl: z.url().optional(),
  /** Public-PWA URL with the code in its fragment, where it cannot reach an HTTP access log. */
  pairUrl: z.url().optional(),
  reach: z.enum(PAIRING_REACHES).optional(),
  refusal: z.enum(ADVERTISEMENT_REFUSALS).optional(),
});
type MintedFields = z.infer<typeof mintedFields>;

/**
 * WHO CAN REDEEM A LINK THAT PREDATES THE QUESTION, read off the only evidence an old mint left.
 *
 * A daemon from before this decision existed welded WHERE I LISTEN and WHERE I CAN BE REACHED into
 * the single address it handed out — so that address IS the classification, and reading it back is
 * the closest thing to the answer that daemon would give if it could be asked. Loopback is the
 * address only a browser on that machine can use; anything routed is one another device can dial.
 *
 * A WILDCARD IS NOT AN ADDRESS, so there is nothing to classify and `undefined` says so.
 * `decideAdvertisement` refuses that bind outright, and this agrees with it rather than inventing a
 * third answer about a value no device can dial.
 */
function legacyReach(daemonUrl: string): PairingReach | undefined {
  // Already a parsed URL by the time this runs. An IPv6 authority keeps its brackets here, which is
  // one of the spellings both single-sourced predicates recognise.
  const { hostname } = new URL(daemonUrl);
  if (isWildcardHost(hostname)) return undefined;
  return isLoopbackHost(hostname) ? 'local-only' : 'any-device';
}

/**
 * THE ONE RESPONSE THAT MAY ARRIVE WITHOUT AN AUDIENCE, and no new writer can produce it.
 *
 * THE TWO ENDS UPGRADE ON DIFFERENT DAYS. The hosted browser ships the moment it is built; the
 * daemons it talks to upgrade whenever their owners get round to it, so every build of this app meets
 * daemons older than itself. An older daemon answers a mint with a link and no `reach` — precisely
 * the shape the invariant refuses — and refusing it outright takes the WHOLE mint from an owner whose
 * daemon is merely a release behind: no link, no code, no reason, on the one screen that exists to
 * add a device. The code is still redeemable; only the field describing its link is missing.
 *
 * So an old response is ANSWERED rather than rejected, and only in the shape an old writer could
 * actually have produced — a link, both halves of it, and neither a `reach` nor a `refusal` beside
 * it. Nothing else is touched: a response that already says who can redeem its link keeps its own
 * word, and every other disagreement between these four fields still fails, so this cannot become the
 * place a new writer's omission goes unnoticed.
 *
 * A WILDCARD LINK LOSES ITS LINK AND KEEPS ITS CODE. Nothing dials `0.0.0.0`, so calling it
 * redeemable would hand a phone exactly the dead QR this change exists to have removed. Failing
 * closed here means the refusal `decideAdvertisement` would itself have made from that bind, which
 * leaves the owner with a working code and the remedy that names the fix.
 */
function withDeclaredReach(mint: MintedFields): MintedFields {
  if (mint.daemonUrl === undefined || mint.pairUrl === undefined) return mint;
  if (mint.reach !== undefined || mint.refusal !== undefined) return mint;
  const reach = legacyReach(mint.daemonUrl);
  if (reach !== undefined) return { ...mint, reach };
  const { daemonUrl, pairUrl, ...codeOnly } = mint;
  return { ...codeOnly, refusal: 'wildcard-bind' };
}

export const PairingCodeMintResponseSchema = mintedFields.transform(withDeclaredReach).superRefine((value, context) => {
  const hasDaemonUrl = value.daemonUrl !== undefined;
  const hasPairUrl = value.pairUrl !== undefined;
  const hasReach = value.reach !== undefined;
  const hasRefusal = value.refusal !== undefined;
  if (hasPairUrl !== hasDaemonUrl) {
    context.addIssue({
      code: 'custom',
      path: ['pairUrl'],
      message: 'pairing URL must be present exactly when the daemon URL is present',
    });
  }
  if (hasReach !== hasDaemonUrl) {
    context.addIssue({
      code: 'custom',
      path: ['reach'],
      message: 'pairing reach must be present exactly when the daemon URL is present',
    });
  }
  if (hasRefusal === hasDaemonUrl) {
    context.addIssue({
      code: 'custom',
      path: ['refusal'],
      message: 'pairing refusal must be present exactly when the daemon URL is absent',
    });
  }
  if (value.daemonUrl !== undefined && value.pairUrl !== undefined) {
    const url = new URL(value.pairUrl);
    const expectedFragment = `#v1;url=${encodeURIComponent(value.daemonUrl)};code=${value.code};fp=${encodeURIComponent(value.daemonId)}`;
    if (url.search === '' && url.hash === expectedFragment) return;
    context.addIssue({
      code: 'custom',
      path: ['pairUrl'],
      message: 'pairing URL must carry only the matching daemon, code and fingerprint in its fragment',
    });
  }
});
export type PairingCodeMintResponse = z.infer<typeof PairingCodeMintResponseSchema>;

/**
 * The mint as a surface must handle it: an invitation with an audience, or a refusal with a reason.
 *
 * ONE NARROWING, NOT ONE PER SURFACE. `fy pair` and the browser's Add-a-device panel are the two
 * readers, and two readers each deciding for themselves whether a link is drawable is how they come to
 * disagree — which is the shape of the defect that put a QR nothing could scan in front of the owner.
 * Both read this.
 */
export interface PairingInvitationLink {
  readonly daemonUrl: string;
  readonly pairUrl: string;
  readonly reach: PairingReach;
}

export type PairingMintOutcome =
  | ({ readonly kind: 'invitation' } & PairingInvitationLink)
  | { readonly kind: 'refusal'; readonly refusal: AdvertisementRefusal };

export function pairingMintOutcome(mint: PairingCodeMintResponse): PairingMintOutcome {
  return mint.daemonUrl === undefined
    ? { kind: 'refusal', refusal: mint.refusal as AdvertisementRefusal }
    : {
        kind: 'invitation',
        daemonUrl: mint.daemonUrl,
        pairUrl: mint.pairUrl as string,
        reach: mint.reach as PairingReach,
      };
}

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
