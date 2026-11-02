import { z } from 'zod';
import { isLoopbackHost, isWildcardHost } from './address.ts';
import { ADVERTISEMENT_REFUSALS, type AdvertisementRefusal } from './advertisement.ts';
import { PublishedCarriersSchema, SocketEndpointSchema } from './carriers.ts';
import { durationWords, InstantSchema } from './common.ts';
import { DAEMON_CAPABILITIES, type DaemonCapability, ReadCapabilityGrantsSchema } from './grants.ts';

/** Pairing codes are deliberately short-lived and have a small online-attempt budget. */
export const PAIRING_CODE_TTL_SECONDS = 120 as const;
/** How long a pairing code lives, in words ("two minutes"): every screen and help text that says it. */
export const PAIRING_CODE_LIFETIME_WORDS = durationWords(PAIRING_CODE_TTL_SECONDS);
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

/**
 * The redemption's own fields. The one-time code is the credential for this exchange; it now travels
 * only inside a sealed `pair` record (`docs/relay-protocol.md` §14) beside the device key it registers.
 */
export const PairingRequestSchema = z.strictObject({
  code: PairingCodeSchema,
  deviceName: PairingDeviceNameSchema,
});
export type PairingRequest = z.infer<typeof PairingRequestSchema>;

/**
 * A device identity, as minted for one grant on one daemon. Not a credential and never derived from one.
 *
 * THERE IS NO DEVICE TOKEN ANY MORE, AND NO SCHEMA FOR ONE. A paired device proves itself by signing
 * each session's transcript with a key it cannot export; the daemon holds only the public half. A
 * token schema left here would be the first line of a bearer path somebody could rebuild.
 */
export const PairedDeviceIdSchema = z.string().regex(/^fy_device_id_[A-Za-z0-9_-]{22}$/u, 'invalid device id');
export type PairedDeviceId = z.infer<typeof PairedDeviceIdSchema>;

/** How long a device may go unused before it must pair again. */
export const DEVICE_IDLE_EXPIRY_DAYS = 30 as const;

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

/**
 * THE PAIRING LINK FRAGMENT, in the one codec both ends read and write.
 *
 * The link a mint hands out carries its facts in the URL FRAGMENT — never a query — because a
 * fragment is not sent in an HTTP request, so the live code cannot reach an access log. There is
 * exactly ONE form:
 *
 * - `v1;url=…;code=…;fp=…` — byte-identical to what every daemon has ever written.
 *
 * A SECOND VERSION WAS BUILT HERE AND IS WITHDRAWN, and the reasoning is recorded rather than
 * deleted, because the version number it would have spent is the thing being preserved. A `v2`
 * form carried `relay=<rendezvous>` so a device that cannot reach `url` had somewhere to dial. The
 * fact it was solving is real and is still solved — a phone that cannot reach the daemon pairs
 * through a rendezvous (`docs/relay-protocol.md` §14) — but the phone finds that rendezvous FOR
 * ITSELF, from the hosted directory advertisement its own build discovers, so nothing has to be
 * named in the link. Naming an arbitrary rendezvous is a strictly larger question (which addresses
 * may a QR send a device to?) and is deferred with the self-hosted first-contact GAP §13 declares.
 * So no fragment version was consumed and a future one may still land parser-and-pattern together.
 *
 * READERS ARE TOLERANT WHERE TOLERANCE IS SAFE AND STRICT WHERE IT IS NOT. A reader requires `url`,
 * `code` and `fp`, IGNORES an unrecognised field name — an unknown name is the next version
 * arriving, and a stray `relay=` is exactly that: ignored, never honoured — and REFUSES a duplicated
 * one, because two values for one name is a real ambiguity.
 */
export interface PairingLinkSeed {
  /** The daemon's direct address, verbatim as the mint advertised it. */
  readonly daemonUrl: string;
  readonly code: PairingCode;
  /** The fingerprint the reading device pins before it trusts anything else. */
  readonly daemonId: DaemonId;
}

/**
 * Recognises a pairing fragment, for surfaces that gate before parsing.
 *
 * IT ADMITS EXACTLY THE VERSION THE PARSER BELOW UNDERSTANDS. A gate that accepted a version the
 * parser cannot interpret would convert a loud `unreadable` into a silent cold screen — the failure
 * the PWA's own reader comment warns about — so the pattern and the parser move together or not at
 * all.
 */
export const PAIRING_FRAGMENT_PATTERN = /^#?v1(?:;|$)/u;

/**
 * Writes the one fragment form for one seed.
 *
 * The code and fingerprint are re-proved against their own schemas, because this string becomes a QR
 * of a live credential — a writer that composed one from an unchecked value would hand a phone a
 * link its reader refuses. Throws on any value the schemas refuse; the daemon URL travels verbatim,
 * since its one spelling is decided by the advertisement that produced it.
 *
 * NO RENDEZVOUS REACHES THIS STRING, and that is an invariant with its own test rather than a
 * property of the current call site: `discoveredRelayUrl` on the mint response is host-facing only.
 */
export function formatPairingFragment(seed: PairingLinkSeed): string {
  const code = PairingCodeSchema.parse(seed.code);
  const daemonId = DaemonIdSchema.parse(seed.daemonId);
  return `v1;url=${encodeURIComponent(seed.daemonUrl)};code=${code};fp=${encodeURIComponent(daemonId)}`;
}

/** The hosted app's origin: where a pairing link, a catalog and a plan's card link point unless a machine serves its own. */
export const HOSTED_APP_ORIGIN = 'https://ferretry.pages.dev';

export interface AppOriginChoice {
  /** The address to build links on: the machine's own, or the hosted app when it set none or set one that is refused. */
  readonly origin: string;
  /** Why a set address was not used, in a sentence; absent when none was set or it was used. */
  readonly refused?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The address links to the app are built on, from the machine's own setting (`FY_APP_URL`). A link is handed to a
 * browser launcher, so the setting must be an absolute `https` address (`http` only on this machine), with no
 * credentials and no leading "-" that a launcher would read as an option. It is parsed, and only its origin and path
 * are kept. Anything else is refused and the hosted app stands.
 */
export function appOriginChoice(setting: string | undefined): AppOriginChoice {
  const text = setting?.trim() ?? '';
  if (text === '') return { origin: HOSTED_APP_ORIGIN };
  const refuse = (why: string): AppOriginChoice => ({
    origin: HOSTED_APP_ORIGIN,
    refused: `FY_APP_URL is not used (${why}); links point at ${HOSTED_APP_ORIGIN}.`,
  });
  if (text.startsWith('-')) return refuse('it starts with "-"');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse('it is not an absolute address');
  }
  const local = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !local) return refuse('it is not an https address');
  if (url.username !== '' || url.password !== '') return refuse('it carries a user name or password');
  return { origin: `${url.origin}${url.pathname.replace(/\/+$/u, '')}` };
}

/** The full link a mint hands out: the pairing app's URL with the fragment where a code may live. */
export function pairingLinkUrl(appUrl: string, seed: PairingLinkSeed): string {
  const url = new URL(appUrl);
  url.hash = formatPairingFragment(seed);
  return url.toString();
}

/**
 * The `name=value` fields of a `v1` link fragment, decoded, or the reason the whole fragment is unreadable.
 *
 * ONE READER FOR EVERY LINK THAT CARRIES A CREDENTIAL IN ITS FRAGMENT — a pairing link and a share link
 * (`catalog-member.ts`) — so the two cannot come to hold different opinions about one string. Its rules: the
 * version must be `v1`; a field is `name=value`, percent-decoded; a REPEATED name is refused, because two
 * values for one name is a real ambiguity; an unrecognised name is kept for the caller to ignore. `link`
 * names the link in each sentence ("pairing link", "share link").
 */
export function readLinkFragmentFields(fragment: string, link: string): ReadonlyMap<string, string> {
  const pieces = (fragment.startsWith('#') ? fragment.slice(1) : fragment).split(';');
  if (pieces.shift() !== 'v1') throw new Error(`${link} version is not recognised`);
  const fields = new Map<string, string>();
  for (const piece of pieces) {
    const separator = piece.indexOf('=');
    if (separator <= 0) throw new Error(`${link} field is not name=value`);
    const name = piece.slice(0, separator);
    if (fields.has(name)) throw new Error(`${link} repeats ${name}`);
    try {
      fields.set(name, decodeURIComponent(piece.slice(separator + 1)));
    } catch {
      throw new Error(`${link} field ${name} is not decodable`);
    }
  }
  return fields;
}

/**
 * Whether a link's daemon address is one this app may dial: a parseable `http:` or `https:` URL. Any other
 * scheme (`javascript:`, `file:`, `ws:`) is refused, because the address came from whoever made the link.
 */
export function isDialableLinkAddress(address: string): boolean {
  try {
    const protocol = new URL(address).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Reads a fragment back into a seed, or throws the reason it cannot be one.
 *
 * The tolerance rules in the codec comment above are implemented by {@link readLinkFragmentFields}, so the
 * daemon that writes a link and the browser that reads one cannot come to hold different opinions about
 * the same string. An unrecognised field name — `relay=` included — is IGNORED rather than honoured: the
 * writer emits none, and a reader that dialled one would be trusting an address the daemon never authored.
 * One name is refused rather than ignored: `share`, which only a catalog share link carries, so a link
 * holding both a pairing code and a share code is read by neither reader.
 */
export function parsePairingFragment(fragment: string): PairingLinkSeed {
  const fields = readLinkFragmentFields(fragment, 'pairing link');
  if (fields.has('share')) throw new Error('this is a share link, not a pairing link');
  const daemonUrl = fields.get('url');
  const code = fields.get('code');
  const fingerprint = fields.get('fp');
  if (daemonUrl === undefined || code === undefined || fingerprint === undefined)
    throw new Error('pairing link must include url, code, and fp');
  if (!isDialableLinkAddress(daemonUrl)) throw new Error('pairing link daemon address is not an http or https URL');
  const parsedCode = PairingCodeSchema.safeParse(code);
  if (!parsedCode.success) throw new Error('pairing link carries an invalid code');
  const parsedDaemonId = DaemonIdSchema.safeParse(fingerprint);
  if (!parsedDaemonId.success) throw new Error('pairing link carries an invalid fingerprint');
  return { daemonUrl, code: parsedCode.data, daemonId: parsedDaemonId.data };
}

/**
 * What a device is handed the one moment it has just proved it may reach this daemon at all.
 *
 * THE CARRIER SET IS ON THE REDEMPTION RESPONSE RATHER THAN ON THE MINT, and the two are read by
 * different parties: the mint response is read by the HOST's own UI, which already has the daemon in
 * front of it, while this one is read by the DEVICE — the party that has to know where to look next
 * time. No rendezvous has an opportunity to edit this answer on any carrier: a direct redemption
 * never crosses one, and a relayed redemption (`docs/relay-protocol.md` §14) carries this exact
 * object inside the sealed `paired` record, under a channel keyed to the Ed25519 identity the QR
 * fingerprint pinned — so what makes it trustworthy is the seal to a pinned identity, not the
 * absence of a relay.
 *
 * A KEY ADDED TO A DEVICE-FACING `strictObject` IS A BREAKING CHANGE — see the rule recorded in
 * `version-skew.ts`. `carriers` defaults to the empty list so a NEWER client reading an OLDER daemon
 * degrades to direct-only, which is exactly what an older daemon offers; the other direction is the
 * one the rule governs.
 */
export const PairingResponseSchema = z.strictObject({
  /** Which grant this device now holds. An identity, not a credential: the device KEY is what proves it. */
  deviceId: PairedDeviceIdSchema,
  daemonId: DaemonIdSchema,
  daemonName: DaemonNameSchema,
  capabilities: z.array(PairingCapabilitySchema).max(64).readonly(),
  carriers: PublishedCarriersSchema.default([]),
  /** Days of disuse after which this device must pair again (`docs/design/zero-trust.md` A6). */
  idleExpiryDays: z.number().int().positive().max(3650),
});
export type PairingResponse = z.infer<typeof PairingResponseSchema>;

/**
 * What a device that redeems this code will hold (`docs/pairing.md`, "What a new device may do").
 *
 * - `full` — the DEFAULT (owner decision 2026-10-14): every capability on both axes, behind the unlock,
 *   which a device needs before it can do anything. The daemon-wide document still applies on top.
 *   Minting one remotely needs a device that holds every capability itself, so no device can mint a
 *   code that gives a new device more than it holds.
 * - `limited` — `LIMITED_DEVICE_GRANTS`, `fleet.use` only (`fy pair --limited`), widened later per device.
 *
 * It travels with the CODE, held by the daemon. The QR and the link carry nothing extra, so the fragment
 * stays the one-version `v1` shape and a code says nothing about what it grants to whoever reads it.
 */
export const PAIRING_GRANT_SETS = ['full', 'limited'] as const;
export type PairingGrantSet = (typeof PAIRING_GRANT_SETS)[number];
export const PairingGrantSetSchema = z.enum(PAIRING_GRANT_SETS);

/** Minting names no device — the redeeming device supplies its own bounded name — only what it will hold. */
export const PairingCodeMintRequestSchema = z.strictObject({
  grants: PairingGrantSetSchema.optional(),
});
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
 * exactly the daemon, code and fingerprint it was minted with — spelled by the one fragment codec
 * above — and no query string. That is what stops any layer below the configuration from advertising
 * a different address. `discoveredRelayUrl` is deliberately NOT among those fields: the fragment has
 * no rendezvous in it, and this invariant is where that stays true.
 *
 * A LINK MAY NOT ARRIVE WITHOUT SAYING WHO CAN REDEEM IT, and after this schema none does.
 * `superRefine` enforces the presence relationships together: `pairUrl` and `reach` are present
 * exactly when `daemonUrl` is, `refusal` is present exactly when it is not, and a
 * `discoveredRelayUrl` only ever rides beside a link. A link with no
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
  /**
   * The rendezvous a device that has never met this daemon can find FOR ITSELF, or nothing.
   *
   * IT IS HOST-FACING AND IT NEVER ENTERS THE LINK. This response is read by the host's own UI —
   * `fy pair`, the Add-a-device panel, `fyd --check` — and its two jobs are both about what to draw
   * on that host's screen: whether another device could redeem this link at all, and what to
   * disclose about the rendezvous that would carry it. The fragment carries no rendezvous, so the
   * scanning phone learns this address from the same hosted directory advertisement the daemon read,
   * never from the QR. The invariant above is what keeps that true.
   *
   * IT IS TRUE ONLY OF A DISCOVERED RENDEZVOUS, which is why it is not called "the relay this daemon
   * dials". The composition root supplies it from relay PROVENANCE: a daemon on an explicitly
   * configured, self-hosted rendezvous has no discoverable address to disclose, so this is absent
   * and the surfaces fail closed to the plain local-only sentence. That is the declared GAP
   * (`docs/relay-protocol.md` §13), arrived at by construction rather than by a check.
   *
   * IT RIDES ONLY BESIDE A LINK — the invariant below refuses one on a refusal — because a refusal
   * has no address to disclose beside and no link to draw. So `reach: "local-only"` PLUS this field
   * is a link another device CAN redeem, and the surfaces draw its QR; a refusal stays a refusal.
   * Adding this key is governed by the `version-skew.ts` rule: the hosted app's reader deploys
   * before any daemon writes it.
   */
  discoveredRelayUrl: SocketEndpointSchema.optional(),
  /**
   * What the device that redeems this code will hold. Host-facing, like the field above, so a screen
   * can say "this code gives a limited device" beside it. Absent means `full`, the default.
   */
  grants: PairingGrantSetSchema.optional(),
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
  // The disclosure goes with the link it rode on. No old writer emits one, so this strip is only
  // ever totality — but a refusal carrying it would disclose a rendezvous beside no address at all,
  // and the invariant below is right to refuse it.
  const { daemonUrl, pairUrl, discoveredRelayUrl, ...codeOnly } = mint;
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
  if (value.discoveredRelayUrl !== undefined && !hasDaemonUrl) {
    context.addIssue({
      code: 'custom',
      path: ['discoveredRelayUrl'],
      message: 'a discovered rendezvous may only accompany a link',
    });
  }
  if (value.daemonUrl !== undefined && value.pairUrl !== undefined) {
    const url = new URL(value.pairUrl);
    // THE DISCLOSED RENDEZVOUS IS ABSENT FROM THIS COMPARISON ON PURPOSE, and its absence is the
    // narrowing's load-bearing assertion: a `pairUrl` whose fragment named one would fail here,
    // whatever a future writer intended, because the expected fragment cannot contain one.
    const expectedFragment = `#${formatPairingFragment({
      daemonUrl: value.daemonUrl,
      code: value.code,
      daemonId: value.daemonId,
    })}`;
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
  /** The rendezvous a fresh device can discover for itself, when this daemon dials a discovered one. */
  readonly discoveredRelayUrl?: string;
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
        ...(mint.discoveredRelayUrl === undefined ? {} : { discoveredRelayUrl: mint.discoveredRelayUrl }),
      };
}

/**
 * WHETHER A DIFFERENT DEVICE CAN REDEEM THIS LINK — the one question a QR is an answer to.
 *
 * `reach` describes the DIRECT address alone, and it used to be the whole answer: `local-only`
 * meant no QR, because loopback on a phone names the phone. A discoverable rendezvous changes that
 * without changing `reach`'s meaning — the direct address is still local-only, and the link is still
 * redeemable from another device, because the scanning phone reads the same hosted advertisement this
 * daemon did and dials the rendezvous itself when loopback fails. Both renderers read this narrowing
 * instead of re-deriving it, for the same reason `pairingMintOutcome` exists: two surfaces deciding
 * drawability for themselves is how a QR nothing could scan reached an owner once already.
 *
 * THE QR IT DECIDES ON CARRIES NO RENDEZVOUS. What makes the link redeemable is a fact about the
 * device's own build, not a field in the fragment, which is why this reads a host-facing field and
 * `formatPairingFragment` reads none.
 */
export function invitationRedeemableByAnotherDevice(link: PairingInvitationLink): boolean {
  return link.reach === 'any-device' || link.discoveredRelayUrl !== undefined;
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

/**
 * One device that may reach this daemon, as anybody but the daemon may see it.
 *
 * THE PUBLIC KEY IS NOT HERE EITHER. A grant is stored as `{ …, publicKey }`, and this schema is the
 * projection that crosses the wire. A public key is not a secret, but a UI has no use for it, and "no
 * route returns key material" is easier to keep as a property of the type than as a habit.
 *
 * `lastSeenAt` is real now: the daemon advances it when the device opens or renews a session (at most
 * once an hour on disk), and `idleExpiresAt` is the instant this grant ends if it is not used again.
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
  idleExpiresAt: InstantSchema,
  /**
   * How the redemption arrived — at the bound address, or over a rendezvous. A fact the person who
   * paired did not choose, shown beside the name they did. Absent for a grant made before it was kept.
   */
  pairedOver: z.enum(['direct', 'relay']).optional(),
  /**
   * What THIS device has been granted, before the daemon-wide document is applied.
   *
   * The effective answer for a governed caller is this AND the daemon-wide grant, axis by axis
   * (`docs/grants.md`, "Per-device grants"). A newly paired device holds `FULL_DEVICE_GRANTS`, behind the
   * unlock, unless its code was minted `--limited`. The owner's admin token at the machine is ungoverned.
   */
  grants: ReadCapabilityGrantsSchema,
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
  /**
   * Which axes THIS caller may turn ON for a device, so a toggle that would be refused says so before
   * it is pressed.
   *
   * Every axis for a caller on the host. For a governed caller: an axis it holds itself, effective,
   * provided it also holds `pairing.configure` — and a passkey step-up is still asked at the change,
   * so `true` here means "allowed after confirming", never "allowed without". Turning an axis OFF is
   * not listed: it needs only a step-up, on any device, including the caller's own.
   */
  mayWiden: ReadCapabilityGrantsSchema,
});
export type PairedDevicesView = z.infer<typeof PairedDevicesViewSchema>;

/**
 * A change to ONE device's grants — `PATCH /v1/pair/devices/:deviceId/grants`.
 *
 * PARTIAL, for the reason `GrantsPatchSchema` is: a stale tab restating answers it never looked at
 * must not revert a decision made elsewhere. Judged field by field and refused WHOLE if any field
 * widens illegally, so a mixed patch never half-applies.
 */
export const DeviceGrantsPatchSchema = z
  .strictObject(
    Object.fromEntries(
      DAEMON_CAPABILITIES.map(capability => [
        capability,
        z.strictObject({ use: z.boolean().optional(), configure: z.boolean().optional() }).optional(),
      ]),
    ) as {
      readonly [K in DaemonCapability]: z.ZodOptional<
        z.ZodObject<{ use: z.ZodOptional<z.ZodBoolean>; configure: z.ZodOptional<z.ZodBoolean> }>
      >;
    },
  )
  .refine(
    patch => Object.values(patch).some(value => value !== undefined),
    'a device grant patch must change something',
  );
export type DeviceGrantsPatch = z.infer<typeof DeviceGrantsPatchSchema>;
