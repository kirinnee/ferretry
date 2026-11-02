import {
  type Advertisement,
  type CapabilityGrants,
  type AdvertisementRefusal,
  type DaemonCarrier,
  type DaemonId,
  DaemonIdSchema,
  DaemonNameSchema,
  DEVICE_IDLE_EXPIRY_DAYS,
  FULL_DEVICE_GRANTS,
  HOSTED_APP_ORIGIN,
  LIMITED_DEVICE_GRANTS,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_SECONDS,
  type PairedDevice,
  PairedDeviceSchema,
  type PairingCode,
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  PairingCodeSchema,
  type PairingCodeStatusResponse,
  type PairingGrantSet,
  type PairingId,
  PairingIdSchema,
  type PairingReach,
  PairingRequestSchema,
  type PairingResponse,
  PairingResponseSchema,
  PublishedCarriersSchema,
  isReservedActorPhrase,
  pairingLinkUrl,
} from '@ferretry/protocol';
import { DeviceKeySchema } from '@ferretry/relay';
import { secretsMatch } from '../api/authentication.ts';
import type { GrantAuditPort } from '../grants/types.ts';
import type { DeviceConnectionRevoker } from './live-connections.ts';

const FERRETRY_PAIRING_APP_URL = `${HOSTED_APP_ORIGIN}/pair`;
const PAIRING_RATE_LIMIT_ATTEMPTS = 10;
const PAIRING_RATE_LIMIT_WINDOW_MS = 60_000;
const PAIRING_RATE_LIMIT_MAX_KEYS = 4_096;

/**
 * At most this many devices are paired with one daemon at once.
 *
 * A BOUND ON SOMETHING A DEVICE CAN DO. A paired device can mint a code and redeem it itself, so without
 * a ceiling it could pair devices without end — every one a push alert to the owner and, a day later,
 * an idle expiry in the security log. Thirty-two is more phones, tablets and browsers than one person
 * keeps; the thirty-third is refused until one is removed.
 */
export const PAIRING_MAX_DEVICES = 32;

/**
 * At most this many redemptions are GRANTED per hour on each carrier.
 *
 * The per-peer window above bounds GUESSES on the direct carrier; it cannot bound the relay, whose
 * sessions have no peer to key on, and it cannot bound a device that redeems right codes it minted
 * itself. This bounds both: ten new devices an hour over the relay, and ten over the bound address.
 */
export const PAIRING_GRANTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1_000;

const DUMMY_PAIRING_CODE = '2222-2222';
const OBSERVATION_LIMIT = 128;

export interface PairingClock {
  now(): number;
}

export interface PairingCryptography {
  pairingCode(): string;
  pairingId(): string;
  deviceId(): string;
}

/** An hour, in milliseconds: how often a busy device's `lastSeenAt` is written to disk at most. */
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PairingDeviceRecord {
  readonly id: string;
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly platform: 'browser';
  readonly createdAt: string;
  readonly lastSeenAt: string;
  /** How the redemption arrived; absent on a grant persisted before this was kept. */
  readonly pairedOver?: PairingCarrierKind;
  /**
   * The device's Ed25519 public key, as SPKI base64url — the ONLY thing this daemon keeps about it.
   *
   * There is no token and no digest of one. A copy of this file, a backup of the state home or a
   * stolen disk image gives an attacker a list of public keys, and a public key authenticates nothing:
   * every session is opened by the device signing that session's transcript with the private half,
   * which never left the browser that generated it.
   */
  readonly publicKey: string;
  /**
   * What THIS device may do when it is governed, before the daemon-wide document is applied
   * (`docs/grants.md`, "Per-device grants"). A new device holds `FULL_DEVICE_GRANTS` behind the unlock,
   * or `LIMITED_DEVICE_GRANTS` (`fleet.use` only) when its code was minted `--limited`.
   */
  readonly grants: CapabilityGrants;
  /**
   * When `publicKey` replaced an earlier key (`docs/design/zero-trust.md` B6). Absent until the first
   * rotation, when the key's age is counted from `createdAt`.
   */
  readonly keyRotatedAt?: string;
}

export interface PairingDeviceStore {
  add(record: PairingDeviceRecord): Promise<void>;
  /** Every grant this daemon has persisted, in the order it granted them. */
  list(): Promise<readonly PairingDeviceRecord[]>;
  /**
   * Forgets one grant, reporting whether there was one to forget.
   *
   * The BOOLEAN is the contract: revoking a device that is already gone is not an error — two people
   * revoking the same lost phone is the expected way this is used — but a caller that cannot tell
   * "removed" from "was never here" cannot answer honestly either.
   */
  remove(id: string): Promise<boolean>;
  /** Records when a device was last seen. An id that is gone is not an error: it was revoked meanwhile. */
  touch(id: string, lastSeenAt: string): Promise<void>;
  /** Replaces a device's key, reporting whether the device was still there to receive it. */
  rotateKey(id: string, publicKey: string, keyRotatedAt: string): Promise<boolean>;
  /** Replaces one device's grants, reporting whether the device was still there to change. */
  setGrants(id: string, grants: CapabilityGrants): Promise<boolean>;
}

/**
 * The live set of device grants: who holds which public key, this instant.
 *
 * The document on disk decides what comes back after a restart; this decides whether the next session
 * is admitted. A revocation that only rewrote the file would leave a revoked phone working until
 * somebody restarted the daemon, which is precisely when nobody is going to.
 */
export class PairingDeviceRegistry {
  private readonly records = new Map<string, PairingDeviceRecord>();

  constructor(
    private readonly daemonId: DaemonId,
    records: readonly PairingDeviceRecord[] = [],
  ) {
    for (const record of records) this.add(record);
  }

  /** Forgets one grant, so its key stops opening sessions THIS INSTANT. */
  remove(id: string): boolean {
    return this.records.delete(id);
  }

  add(record: PairingDeviceRecord): void {
    if (record.daemonId !== this.daemonId) throw new Error('a device grant belongs to a different daemon');
    // A grant whose key is not an Ed25519 public key is not a grant. It could never verify a proof, so
    // it would sit here as a device that silently cannot authenticate; refuse it loudly instead.
    if (!DeviceKeySchema.safeParse(record.publicKey).success) throw new Error('a device grant carries no usable key');
    this.records.set(record.id, record);
  }

  /** One grant by id. A device id is not a secret — it names a key, and the key is what is checked. */
  get(id: string): PairingDeviceRecord | undefined {
    return this.records.get(id);
  }

  all(): readonly PairingDeviceRecord[] {
    return [...this.records.values()];
  }

  /** Replaces a held grant with a newer copy of itself; a grant revoked meanwhile stays revoked. */
  refresh(record: PairingDeviceRecord): void {
    if (this.records.has(record.id)) this.records.set(record.id, record);
  }
}

/** Fixed-window admission independent of any individual pairing code's attempt counter. */
export class PairingRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly clock: PairingClock,
    private readonly limit = PAIRING_RATE_LIMIT_ATTEMPTS,
    private readonly windowMs = PAIRING_RATE_LIMIT_WINDOW_MS,
    private readonly maxKeys = PAIRING_RATE_LIMIT_MAX_KEYS,
  ) {}

  admit(key: string): boolean {
    const now = this.clock.now();
    const cutoff = now - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter(at => at > cutoff);
    if (recent.length >= this.limit) {
      this.remember(key, recent);
      return false;
    }
    recent.push(now);
    this.remember(key, recent);
    return true;
  }

  /** Keep the hottest peer windows while placing a hard ceiling on public-input state. */
  private remember(key: string, recent: number[]): void {
    this.attempts.delete(key);
    while (this.attempts.size >= Math.max(1, this.maxKeys)) {
      const oldest = this.attempts.keys().next().value ?? key;
      this.attempts.delete(oldest);
    }
    this.attempts.set(key, recent);
  }
}

interface ActivePairing {
  readonly pairingId: PairingId;
  readonly code: PairingCode;
  readonly expiresAtMs: number;
  /**
   * What the device that redeems this code will hold — chosen at the mint and kept HERE, with the code,
   * so the link carries nothing extra and a redemption cannot ask for more than was minted.
   */
  readonly grants: PairingGrantSet;
  attempts: number;
  /**
   * WRONG GUESSES THAT ARRIVED OVER A RENDEZVOUS, counted apart from `attempts` on purpose.
   *
   * Redemption used to be reachable only from the daemon's own network; a relayed carrier makes it
   * reachable by anybody on the internet who knows a public fingerprint, which is public — it is in
   * the QR. What such a caller can buy is not the code (32^8 of them, two minutes, a constant-time
   * compare) but the code's AVAILABILITY: on one shared counter, five junk guesses from anywhere
   * would kill a code sitting on somebody's desk before its owner finished walking to their phone.
   *
   * So a relayed miss spends this and never `attempts`, and exhausting it closes the relay path for
   * this code alone — see {@link ActivePairing.relayClosed}. The code stays alive for a device on
   * the LAN with its five direct guesses untouched.
   */
  relayAttempts: number;
  /** Set when the relay budget is spent. The code lives on; only the relayed carrier is refused. */
  relayClosed: boolean;
}

/**
 * What one sealed `pair` record presents, on either carrier.
 *
 * Typed at the boundary because the session layer already parsed a record to reach here — the code and
 * name are still checked below against the pairing API's own schema, which owns their bounds.
 *
 * `prove` is the session layer's check of the record's PROOF: whether the device signed this session's
 * transcript with the private half of `deviceKey`. It is the session's because only the session holds
 * the transcript, and it is a CALLBACK rather than a verdict so that it runs here, AFTER the cheap
 * per-peer admission: an Ed25519 verify is the expensive part of an unauthenticated attempt, and a
 * stranger refused by the limiter must not get the daemon to do it first. Its answer is one more way
 * for an attempt to be wrong.
 */
export interface SessionPairingAttempt {
  readonly code: string;
  readonly deviceName: string;
  readonly deviceKey: string;
  readonly prove: () => Promise<boolean>;
}

/** Which way a redemption arrived: at the bound address, or over a rendezvous. */
export type PairingCarrierKind = PairingCarrier['kind'];

/**
 * A device that was just granted access, as an observer may learn it.
 *
 * NO TOKEN AND NO DIGEST, by construction: this is its own shape rather than the record, so an
 * observer cannot be handed what it must never hold. `createdAt` is this daemon's instant.
 */
export interface PairingGrant {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly carrier: PairingCarrierKind;
  readonly createdAt: string;
}

/**
 * Told once, after a grant is PERSISTED — the security log and the new-device alert hang off it.
 *
 * It may not decide the redemption: whatever it throws or rejects with is swallowed by the caller, so
 * a full disk cannot turn a pairing that happened into a refusal the device retries.
 */
export type PairingGrantObserver = (grant: PairingGrant) => Promise<void>;

/**
 * Which carrier an attempt arrived on, because the two have separate budgets.
 *
 * A DIRECT attempt reached the daemon's own listener, so it is keyed by its peer address for the
 * fixed-window limiter and spends the code's five direct guesses. A RELAYED one spends the separate
 * relay budget and is bounded structurally instead (see {@link PairingService.redeemInSession}).
 */
export type PairingCarrier = { readonly kind: 'direct'; readonly rateLimitKey: string } | { readonly kind: 'relay' };

/**
 * State this daemon holds ABOUT one device, which must not outlive the device's grant.
 *
 * A device grant is not only a credential — other subsystems file durable rows against it, and a row
 * that survived its device would keep working after the access it belongs to was taken away. Web Push
 * enrolment is the first: a revoked phone that keeps receiving this machine's notifications is a
 * security defect rather than a cosmetic one.
 *
 * IT IS A SEAM, NOT A REGISTRY. Each owner satisfies it structurally, so revocation stays one act
 * instead of a list of cleanups every future subsystem has to remember to join.
 */
export interface DeviceScopedState {
  /** Forgets everything held for one device. Named ids that were never here are not an error. */
  forgetDevice(deviceId: string): Promise<unknown>;
}

/**
 * WHERE A REDEMPTION READS THIS DAEMON'S PUBLISHED CARRIERS: the frozen set current right now.
 *
 * Declared here, by its first consumer, so pairing depends on nothing above it; the runtime's
 * `PublishedCarrierSet` is the one production owner and `GET /v1/carriers` reads the same object.
 */
export interface PublishedCarrierView {
  current(): readonly DaemonCarrier[];
}

interface PairingServiceOptions {
  readonly daemonId: string;
  readonly daemonName: string;
  /**
   * WHAT THIS DAEMON HANDS OUT, decided by the configuration and never by a caller.
   *
   * An address alone is what this used to take, and an address alone cannot say whether the device
   * about to read it can dial it. The decision arrives already made, from one owner, so this service
   * has nothing to derive and no way to derive it differently.
   */
  readonly advertisement: Advertisement;
  /**
   * EVERY WAY THIS DAEMON CAN BE REACHED, handed to the device that just earned the right to reach it.
   *
   * A redemption is the one moment a device is guaranteed to be listening, so it is where the set
   * belongs — a phone that learned only the direct address it paired over has no way to find the
   * rendezvous that would still work when it leaves the house.
   *
   * ONE OWNER, READ AT THE MOMENT OF REDEMPTION. The composition root holds the set and gives the SAME
   * view to `GET /v1/carriers`, so a device's first copy and its refresh are read from one place. It
   * used to be a frozen array, on the argument that a getter could answer differently on two calls; a
   * tunnel (`docs/relay-protocol.md` §15) is published only while its connector is registered, so the
   * set now legitimately changes, and the rule is kept by the single owner rather than by constancy —
   * see `runtime/published-carriers.ts`.
   *
   * THIS SERVICE DECIDES NOTHING ABOUT IT. Nothing here filters, re-orders or adds to it. It is CHECKED
   * at construction — see the constructor — and every later set is parsed by its owner when it is made,
   * so a carrier this daemon's own device would refuse cannot leave through here, and cannot be
   * discovered halfway through a redemption either.
   */
  readonly carriers: PublishedCarrierView;
  /**
   * The rendezvous a device that has never met this daemon can find FOR ITSELF, or nothing.
   *
   * IT IS PROVENANCE, NOT AN ADDRESS FROM THE LIST ABOVE, and that distinction is the whole value of
   * the field. This used to be derived here as "the first published relay of any kind", which was
   * wrong in exactly the case it mattered: an operator's own rendezvous is published and is NOT
   * something a fresh phone can discover, so disclosing it beside a QR promised a first pairing that
   * cannot happen. The composition root supplies this only for a DISCOVERED source — one this daemon
   * read from the hosted directory advertisement, which is the same advertisement the scanning
   * device's own build reads — so the claim is true by construction and a self-hosted deployment
   * fails closed to nothing. That closed door is the declared GAP in `docs/relay-protocol.md` §13.
   *
   * IT NEVER REACHES THE LINK. The fragment is `v1;url=…;code=…;fp=…` and carries no rendezvous;
   * this value exists so the HOST's own screens know a loopback-bound daemon is redeemable anyway and
   * can draw the QR plus the metadata disclosure.
   */
  readonly discoveredRelayUrl?: string;
  readonly clock: PairingClock;
  readonly cryptography: PairingCryptography;
  readonly devices: PairingDeviceStore;
  readonly credentials: PairingDeviceRegistry;
  /**
   * Everything else that is keyed by a device, purged when its grant is revoked.
   *
   * OPTIONAL, and the reason it can safely be is worth stating: each owner ALSO refuses to act on a
   * device it cannot find a live grant for, so a daemon built without this purge leaks stale rows and
   * never leaks access. See `PushService` for both halves of that argument.
   */
  readonly deviceState?: readonly DeviceScopedState[];
  /**
   * Every live connection a device holds — terminals, event feeds, relayed streams — ended once its
   * grant is gone. See `LiveDeviceConnections` for why it runs after the grant is removed rather
   * than with the purge above.
   */
  readonly connections?: DeviceConnectionRevoker;
  /** See {@link PairingGrantObserver}. */
  readonly onGranted?: PairingGrantObserver;
  /**
   * Where a revocation somebody ASKED for is written down, in the owner's grant journal.
   *
   * OPTIONAL for the reason `deviceState` is: a daemon built without it still revokes correctly and
   * merely leaves no trace. It records only when the caller names an actor, so the daemon's own idle
   * expiry — which nobody asked for — is not written as though somebody had.
   */
  readonly audit?: Pick<GrantAuditPort, 'record'>;
  readonly rateLimiter?: PairingRateLimiter;
  /**
   * The machine's idle period in days, read at every check so a shortened one applies at the next
   * (`idleExpiryDays`, `docs/design/zero-trust.md` B6). Absent means {@link DEVICE_IDLE_EXPIRY_DAYS}.
   */
  readonly idleExpiryDays?: () => number;
  /**
   * How long one idle DAY is, in milliseconds. A seam, so a suite or an end-to-end run can drive the
   * shortest idle period (one day) in seconds; absent means a real day.
   */
  readonly idleDayMs?: number;
  readonly compare?: (left: string, right: string) => boolean;
  readonly pairingAppUrl?: string;
  readonly capabilities?: readonly string[];
}

export type PairingRedemption =
  | { readonly kind: 'paired'; readonly response: PairingResponse }
  | { readonly kind: 'refused' };

/**
 * ONE MINT ATTEMPT: a live code, or the reason there is none.
 *
 * IT IS A UNION RATHER THAN A THROW OR A NULLABLE CODE, and the shape is the enforcement. A caller
 * cannot reach the code without having read which of the two answers it got, so the requirement below
 * cannot be skipped by a route that forgot to ask first — and a refusal carries the sentence a person
 * needs rather than a status somebody else has to write prose for.
 */
const REFUSED = { kind: 'refused' } as const;

/** The complete pairing state machine. One instance belongs to one daemon runtime. */
export class PairingService {
  private readonly daemonId: DaemonId;
  private readonly daemonName: string;
  private readonly advertisement: Advertisement;
  private readonly pairingAppUrl: string;
  private readonly capabilities: readonly string[];
  private readonly rateLimiter: PairingRateLimiter;
  /** When each recent grant was made, per carrier: see {@link PAIRING_GRANTS_PER_HOUR}. */
  readonly #grantedAt: Record<PairingCarrierKind, number[]> = { direct: [], relay: [] };
  private readonly compare: (left: string, right: string) => boolean;
  private active: ActivePairing | undefined;
  private readonly observations = new Map<PairingId, PairingCodeStatusResponse>();
  /** The latest instant a person used each device, ahead of the hourly copy on disk. */
  readonly #seen = new Map<string, number>();
  /** Devices whose `lastSeenAt` is being written right now, so a burst writes it once. */
  readonly #touching = new Set<string>();

  constructor(private readonly options: PairingServiceOptions) {
    this.daemonId = DaemonIdSchema.parse(options.daemonId);
    this.daemonName = DaemonNameSchema.parse(options.daemonName);
    // THE CARRIER SET IS CHECKED BEFORE THIS DAEMON CAN PAIR ANYBODY, and the parsed copy is thrown
    // away on purpose.
    //
    // WHY IT CANNOT WAIT FOR THE RESPONSE. `redeem()` parses the whole response LAST — after the code
    // is burned, the device row is written and the credential is live. `PublishedCarriersSchema` throws
    // rather than dropping, so a set it refuses would turn one redemption into a generic 500 with the
    // code spent, a device persisted and no token delivered to anybody: an un-repairable half-state,
    // reached by a configuration mistake rather than by an attack. Here the same bad set refuses at
    // boot instead, before there is a code to spend, and the operator gets a failure they can act on.
    //
    // WHY THE COPY IS DISCARDED. `parse` returns a NEW array, and adopting it would make this service a
    // second authority on a fact the composition root owns — the refresh route would then answer from
    // one array and a redemption from another, which is the disagreement this whole feature exists to
    // end. What is wanted is the CHECK, not the result: `this.options.carriers` stays the one owner.
    PublishedCarriersSchema.parse(options.carriers.current());
    this.advertisement = normalizedAdvertisement(options.advertisement);
    this.pairingAppUrl = new URL(options.pairingAppUrl ?? FERRETRY_PAIRING_APP_URL).toString();
    this.capabilities = [...(options.capabilities ?? ['daemon-api'])];
    this.rateLimiter = options.rateLimiter ?? new PairingRateLimiter(options.clock);
    this.compare = options.compare ?? secretsMatch;
  }

  /**
   * A live code, replacing any code still outstanding.
   *
   * IT ASKS NOTHING ABOUT THIS MACHINE. Who may mint is the `pairing` capability's question, answered
   * at the boundary before this runs: the owner's admin token at the machine is ungoverned, and every
   * other caller — a browser on the host included — needs the grant AND a live passkey step-up from the
   * device already paired. The code itself is single-use and
   * short-lived, so there is no machine-level precondition left for this method to check.
   */
  mint(grants: PairingGrantSet = 'full'): PairingCodeMintResponse {
    if (this.active !== undefined) this.expire(this.active);
    while (this.observations.size >= OBSERVATION_LIMIT) {
      const oldest = this.observations.keys().next().value;
      if (oldest !== undefined) this.observations.delete(oldest);
    }

    const pairingId = PairingIdSchema.parse(this.options.cryptography.pairingId());
    const code = PairingCodeSchema.parse(this.options.cryptography.pairingCode());
    const expiresAtMs = this.options.clock.now() + PAIRING_CODE_TTL_SECONDS * 1_000;
    const expiresAt = instant(expiresAtMs);
    this.active = { pairingId, code, expiresAtMs, attempts: 0, relayAttempts: 0, relayClosed: false, grants };
    this.observations.set(pairingId, { pairingId, status: 'pending', expiresAt });

    return PairingCodeMintResponseSchema.parse({
      pairingId,
      code,
      ttlSeconds: PAIRING_CODE_TTL_SECONDS,
      expiresAt,
      daemonId: this.daemonId,
      daemonName: this.daemonName,
      ...this.#link(code),
      grants,
    });
  }

  /**
   * The link half of a mint, or the reason there is none.
   *
   * IT TAKES NO REQUEST, AND THAT IS THE GUARD. The plausible shortcut here is to decide from the
   * caller's own carrier — "this request arrived on loopback, so a loopback address is fine" — and it
   * is wrong in the commonest case there is: somebody standing at the machine minting a code to scan
   * with their phone. The minter is local and the redeemer is not. There is no request in scope to
   * reach for, so the mistake cannot be made here.
   */
  #link(code: PairingCode):
    | {
        readonly daemonUrl: string;
        readonly pairUrl: string;
        readonly reach: PairingReach;
        readonly discoveredRelayUrl?: string;
      }
    | { readonly refusal: AdvertisementRefusal } {
    if (this.advertisement.kind === 'none') return { refusal: this.advertisement.refusal };
    const daemonUrl = this.advertisement.url;
    return {
      daemonUrl,
      // Composed by the protocol's own writer rather than spelled here. The mint schema verifies this
      // URL against these very fields, and a second speller would be the invisible difference that
      // breaks a reader nobody tested.
      //
      // THE SEED IS THE THREE FIELDS AND NOTHING ELSE. It briefly carried a rendezvous, so a device
      // that could not reach `daemonUrl` had somewhere to dial — the circularity is real, and it is
      // now resolved on the OTHER side: the scanning device reads the hosted directory advertisement
      // its own build carries and finds the same rendezvous this daemon dialled, so the link does not
      // have to tell it. A QR that named an arbitrary address is the larger, deferred question.
      pairUrl: pairingLinkUrl(this.pairingAppUrl, { daemonUrl, code, daemonId: this.daemonId }),
      // The decision's vocabulary translated into the wire's, in the one place that crosses between
      // them: an address a different device can dial is an address any device can redeem.
      reach: this.advertisement.kind === 'address' ? 'any-device' : 'local-only',
      // Passed through from the composition root, never derived from `options.carriers`: only a
      // DISCOVERED rendezvous is something a fresh device can find, and this list cannot say which
      // entry that is. See the option's own comment for why the difference is not cosmetic.
      ...(this.options.discoveredRelayUrl === undefined ? {} : { discoveredRelayUrl: this.options.discoveredRelayUrl }),
    };
  }

  status(pairingId: PairingId): PairingCodeStatusResponse | undefined {
    const observation = this.observations.get(pairingId);
    if (observation?.status !== 'pending') return observation;
    const active = this.active;
    if (active?.pairingId === pairingId && this.options.clock.now() < active.expiresAtMs) return observation;
    const expired = { pairingId, status: 'expired', expiresAt: observation.expiresAt } as const;
    this.observations.set(pairingId, expired);
    if (active?.pairingId === pairingId) this.active = undefined;
    return expired;
  }

  /**
   * Ends one minted code before its two minutes are up.
   *
   * IT IS ADDRESSED BY PAIRING ID, NEVER BY CODE. The id is the non-secret handle a mint answers with
   * for exactly this reason: this value reaches a URL, and a URL reaches every access log in the path,
   * so a revoke keyed by the code would put the code somewhere it outlives its TTL.
   *
   * `undefined` means this daemon never minted that id — reported as a 404 rather than a cheerful
   * success, because "revoked" and "there was nothing here" are different answers and a screen that
   * cannot tell them apart will claim to have closed a door it never found. An id it DOES know is
   * always answered with the observation, so revoking an already-expired or already-redeemed code is
   * idempotent rather than an error: two people shutting the same door is the expected use.
   */
  revoke(pairingId: PairingId): PairingCodeStatusResponse | undefined {
    const observation = this.observations.get(pairingId);
    if (observation === undefined) return undefined;
    const active = this.active;
    if (active?.pairingId === pairingId) this.expire(active);
    // Re-read rather than returning what `expire` wrote: a code that was already redeemed keeps its
    // redeemed observation, and reporting it as expired would tell an operator no device got in.
    return this.observations.get(pairingId) ?? observation;
  }

  /**
   * Every device that may reach this daemon, projected for the wire.
   *
   * THE KEY IS DROPPED HERE, by construction rather than by remembering to: the return type is the
   * protocol's `PairedDevice`, which has no field for one. Idle grants are expired first, so the list a
   * person reads never shows a device that could no longer get in.
   */
  async devices(): Promise<readonly PairedDevice[]> {
    await this.expireIdleDevices();
    return this.options.credentials.all().map(record => {
      const lastSeenMs = this.#lastSeenMs(record);
      return PairedDeviceSchema.parse({
        id: record.id,
        name: record.name,
        platform: record.platform,
        createdAt: record.createdAt,
        lastSeenAt: instant(lastSeenMs),
        idleExpiresAt: instant(lastSeenMs + this.#idleExpiryMs()),
        grants: record.grants,
        ...(record.pairedOver === undefined ? {} : { pairedOver: record.pairedOver }),
      });
    });
  }

  /**
   * The public key a session must prove, or nothing — for a device that is unknown, revoked or idle.
   *
   * THIS IS THE ONE QUESTION A SESSION ASKS before it is admitted, and again at every lease renewal,
   * so idle expiry and revocation are both re-read from this daemon's own state each time a device
   * exercises its key. An idle grant is expired HERE, as a side effect of being asked about: there is
   * no timer, because a device nobody is using needs nothing to happen to it until it tries.
   */
  async deviceKey(id: string): Promise<string | undefined> {
    const record = this.options.credentials.get(id);
    if (record === undefined) return undefined;
    if (this.options.clock.now() - this.#lastSeenMs(record) < this.#idleExpiryMs()) return record.publicKey;
    await this.revokeDevice(record.id).catch(() => false);
    return undefined;
  }

  /**
   * A person just used this device — a request the page marked `presence`, never an auth or a silent
   * renewal, so an unattended tab cannot keep a device alive. Advances `lastSeenAt`, writing it to disk
   * at most once an hour.
   *
   * The in-memory instant moves every time, so idle expiry is exact; the document only moves when the
   * persisted copy is an hour stale, so a busy phone is not a disk write per request. A failed write is
   * dropped: losing at most an hour of "last seen" can bring an expiry forward by that hour, never
   * keep a device alive longer than it was actually used.
   */
  seen(id: string): void {
    const now = this.options.clock.now();
    this.#seen.set(id, now);
    const record = this.options.credentials.get(id);
    if (record === undefined || this.#touching.has(id)) return;
    if (now - Date.parse(record.lastSeenAt) < LAST_SEEN_PERSIST_INTERVAL_MS) return;
    const lastSeenAt = instant(now);
    this.#touching.add(id);
    void this.options.devices
      .touch(id, lastSeenAt)
      .then(
        () => {
          // The LATEST record, not the one read before the write: a grant change made meanwhile must survive.
          const latest = this.options.credentials.get(id);
          if (latest !== undefined) this.options.credentials.refresh({ ...latest, lastSeenAt });
        },
        () => undefined,
      )
      .finally(() => this.#touching.delete(id));
  }

  /** Ends every grant nobody has used for the idle period. Called at boot and per list. */
  async expireIdleDevices(): Promise<number> {
    const now = this.options.clock.now();
    let expired = 0;
    for (const record of this.options.credentials.all()) {
      if (now - this.#lastSeenMs(record) < this.#idleExpiryMs()) continue;
      if (await this.revokeDevice(record.id).catch(() => false)) expired += 1;
    }
    return expired;
  }

  /**
   * How many paired devices an idle period of `days` would end at the next check — what a person is
   * told BEFORE nothing can be done about it. Ends nothing itself.
   */
  devicesIdleLongerThan(days: number): number {
    const now = this.options.clock.now();
    return this.options.credentials.all().filter(record => now - this.#lastSeenMs(record) >= days * this.#dayMs())
      .length;
  }

  /** When this device's current key was put in place: its last rotation, or its pairing. */
  keyIssuedAt(id: string): number | undefined {
    const record = this.options.credentials.get(id);
    return record === undefined ? undefined : Date.parse(record.keyRotatedAt ?? record.createdAt);
  }

  /**
   * Replaces a device's key with `publicKey` (`docs/design/zero-trust.md` B6), written first and adopted
   * only once written, for the reason {@link revokeDevice} gives. The caller has verified the new key
   * inside a session the old one opened; this only records it. `false` when the device is gone.
   */
  async rotateDeviceKey(id: string, publicKey: string): Promise<boolean> {
    const record = this.options.credentials.get(id);
    if (record === undefined) return false;
    const keyRotatedAt = instant(this.options.clock.now());
    if (!(await this.options.devices.rotateKey(id, publicKey, keyRotatedAt))) return false;
    this.options.credentials.refresh({ ...record, publicKey, keyRotatedAt });
    return true;
  }

  #idleExpiryMs(): number {
    return (this.options.idleExpiryDays?.() ?? DEVICE_IDLE_EXPIRY_DAYS) * this.#dayMs();
  }

  #dayMs(): number {
    return this.options.idleDayMs ?? DAY_MS;
  }

  #lastSeenMs(record: PairingDeviceRecord): number {
    return Math.max(Date.parse(record.lastSeenAt), this.#seen.get(record.id) ?? 0);
  }

  /**
   * One device's own grants, or nothing for a device that is unknown or revoked.
   *
   * Read from the LIVE registry, synchronously, because the authorization boundary asks it in front of
   * every governed request — the same registry a revocation clears, so a revoked device has no grants.
   */
  deviceGrants(id: string): CapabilityGrants | undefined {
    return this.options.credentials.get(id)?.grants;
  }

  /**
   * Replaces one device's grants: the document first, then the live registry, so a failed write leaves
   * nothing changed — the order `revokeDevice` keeps, for its reason. Who may make the change is decided
   * by the caller (`DeviceGrantService`); this only records it.
   */
  async setDeviceGrants(id: string, grants: CapabilityGrants): Promise<boolean> {
    if (this.options.credentials.get(id) === undefined) return false;
    if (!(await this.options.devices.setGrants(id, grants))) return false;
    // The LATEST record, re-read after the write: a sighting that landed meanwhile must survive too.
    const latest = this.options.credentials.get(id);
    if (latest !== undefined) this.options.credentials.refresh({ ...latest, grants });
    return true;
  }

  /**
   * Takes one device's access away.

   *
   * THE ORDER IS DELIBERATE: the document is written first, and only a successful write removes the
   * live grant. The other order — kill it in memory, then persist — turns a failed write into a
   * daemon whose answer disagrees with its own state file, so the phone stops working now and starts
   * working again at the next restart, which is the least explainable outcome available. This way a
   * write failure means nothing was revoked, the caller is told, and the operator can try again.
   *
   * There is no await between the write and the in-memory removal, so no session can be admitted
   * against a key this daemon has already promised to forget.
   *
   * THE GRANT GOES FIRST, then the device's live sessions, and only then its passkeys, step-ups and push
   * enrolments. A stolen phone loses its access in the first step, so no request can be served between
   * the purge and the revocation, and a purge that fails cannot leave the phone paired with its passkeys
   * gone (review L5). EVERY OWNER'S PURGE IS ATTEMPTED, whatever an earlier one did: one that throws is
   * collected and the rest still run, so a push store that cannot be written never leaves the device's
   * passkeys — and the passkeys-changed signal they fire — behind. The failures are thrown together at
   * the end, after the revocation is recorded. What a failed purge leaves is harmless: notifications reach
   * only devices that are still paired (`PushService` drops an orphaned enrolment at delivery), a passkey
   * bound to a device id that is never minted again can step nobody up, and a KEPT proof that device made
   * stops verifying because it is no longer paired (`StepUpService.verifyStoredProof`).
   *
   * WHEN `actor` IS GIVEN, the revocation is written to the audit journal as `device.revoked=<id>` —
   * and only once it has actually happened, as the LAST step. A refused or unknown revocation leaves no
   * record, because nothing was revoked; and a journal that cannot be written must not leave a stolen
   * phone's sockets open, so the connections end first. A failed audit write therefore surfaces as an
   * error AFTER the device is already gone: the caller is told the record is missing, never that the
   * revocation failed.
   */
  async revokeDevice(id: string, actor?: string): Promise<boolean> {
    const removed = await this.options.devices.remove(id);
    if (removed) {
      this.options.credentials.remove(id);
      this.#seen.delete(id);
      // Only now, with nothing left that verifies: a socket ended any earlier could be reopened on the
      // key this revocation is about to remove.
      this.options.connections?.endDevice(id);
    }
    // Even with no grant left to remove: revoking a lost phone twice is how its leftovers are cleaned up.
    const failures: unknown[] = [];
    for (const owner of this.options.deviceState ?? []) {
      try {
        await owner.forgetDevice(id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (removed && actor !== undefined) {
      await this.options.audit?.record({
        actor,
        changes: [`device.revoked=${id}`],
        at: instant(this.options.clock.now()),
      });
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} purges of a revoked device failed`);
    return removed;
  }

  /**
   * ONE REDEMPTION, from a sealed `pair` record, on either carrier.
   *
   * There is no other way in any more. The plain-HTTP `POST /v1/pair` handed a live code to whatever
   * answered at an address nothing had authenticated; every redemption now arrives inside a session
   * whose daemon was proved against the QR's fingerprint before the code left the device.
   *
   * IT TAKES NO `ApiRequest`, AND THAT IS THE SECURITY PROPERTY RATHER THAN A CONVENIENCE. A
   * pre-credential session that could build a request would be an anonymous caller at a route table.
   * The session's pairing branch calls this and only this, so the tunnel's invariant — a request carries
   * exactly one credential, the one its session was opened with — stays literally true.
   *
   * TWO BUDGETS, BECAUSE TWO CARRIERS. A direct attempt is admitted by the per-peer fixed window and
   * spends the code's five direct guesses. A relayed attempt spends the separate relay budget and is
   * never keyed by a peer: the session identifier is minted by the rendezvous and cannot repeat, so a
   * limiter keyed by it would admit every time. What bounds that path is structural — one attempt per
   * session, a ceiling on pre-credential sessions per link, the rendezvous' own arrival rate, and the
   * relay budget below, whose exhaustion closes only the relay path for this code.
   *
   * NOTHING IS REFUSED EARLY, including the case where no code is minted at all, and a proof that does
   * not verify is spent exactly like a wrong code. Answering faster when there is nothing to guess, or
   * differently for a bad key, would give an unauthenticated caller an oracle.
   */
  async redeemInSession(attempt: SessionPairingAttempt, carrier: PairingCarrier): Promise<PairingRedemption> {
    if (carrier.kind === 'direct' && !this.rateLimiter.admit(carrier.rateLimitKey)) return REFUSED;
    // Run for every admitted attempt, whatever its code: verifying only when the code matched would
    // make a right code measurably slower than a wrong one.
    const proven = await attempt.prove();
    const parsed = PairingRequestSchema.safeParse({ code: attempt.code, deviceName: attempt.deviceName });
    const candidate = parsed.success ? parsed.data.code : attempt.code;
    const active = this.active;
    const matches = this.compare(candidate, active?.code ?? DUMMY_PAIRING_CODE);
    const keyed = proven && DeviceKeySchema.safeParse(attempt.deviceKey).success;
    const now = this.options.clock.now();

    if (active === undefined) return REFUSED;
    if (now >= active.expiresAtMs) {
      this.expire(active);
      return REFUSED;
    }
    // A spent relay budget refuses AFTER the comparison, like every other cause: the whole point of
    // the separate budget is that this refusal is invisible from the LAN, and a faster answer here
    // would announce to the attacker that their own guesses had closed the path.
    if (carrier.kind === 'relay' && active.relayClosed) return REFUSED;
    // A body that cannot describe a code guess is still compared above, but it cannot spend a
    // budget. Otherwise anybody could kill the active code with five broken records.
    if (!parsed.success) return REFUSED;
    if (!matches || !keyed) {
      if (carrier.kind === 'direct') {
        active.attempts += 1;
        if (active.attempts >= PAIRING_CODE_MAX_ATTEMPTS) this.expire(active);
      } else {
        active.relayAttempts += 1;
        // `relayClosed`, NEVER `expire`. This is the entire separation: the code survives, its five
        // direct guesses survive, and only the carrier the guesses came over is shut.
        if (active.relayAttempts >= PAIRING_CODE_MAX_ATTEMPTS) active.relayClosed = true;
      }
      return REFUSED;
    }
    // A name that would read as one of the log's fixed actors is refused AFTER the guess is judged,
    // so a wrong code still spends the budget whatever name it carries. The code survives.
    if (isReservedActorPhrase(parsed.data.deviceName)) return REFUSED;
    // Bounds on how many devices exist and how fast they arrive, checked after the guess is judged and
    // before the code is consumed: a refusal here leaves the code live for when there is room.
    if (this.options.credentials.all().length >= PAIRING_MAX_DEVICES) return REFUSED;
    const recentGrants = this.#grantedAt[carrier.kind].filter(at => at > now - HOUR_MS);
    this.#grantedAt[carrier.kind] = recentGrants;
    if (recentGrants.length >= PAIRING_GRANTS_PER_HOUR) return REFUSED;
    recentGrants.push(now);
    return await this.grant(active, parsed.data.deviceName, attempt.deviceKey, now, carrier.kind);
  }

  /**
   * The one successful path, shared by both carriers so neither can drift into granting differently.
   *
   * A device paired over a rendezvous and a device paired over the bound address receive the same
   * response from the same code here — `carriers` included, which is what the relayed device
   * navigates by afterwards.
   */
  private async grant(
    active: ActivePairing,
    deviceName: string,
    publicKey: string,
    now: number,
    carrier: PairingCarrierKind,
  ): Promise<PairingRedemption> {
    // The consume is the synchronous state change immediately before any persistence await. A
    // concurrent call therefore sees no active code and cannot enter the successful branch.
    this.active = undefined;
    const createdAt = instant(now);
    const record: PairingDeviceRecord = {
      id: this.options.cryptography.deviceId(),
      daemonId: this.daemonId,
      name: deviceName,
      platform: 'browser',
      createdAt,
      lastSeenAt: createdAt,
      pairedOver: carrier,
      publicKey,
      // Full access behind the unlock, by default (owner decision 2026-10-14): the device can do nothing
      // until it unlocks, and then anything its grants allow. A `--limited` code narrows it to the fleet.
      grants: active.grants === 'limited' ? LIMITED_DEVICE_GRANTS : FULL_DEVICE_GRANTS,
    };

    try {
      await this.options.devices.add(record);
      this.options.credentials.add(record);
    } catch {
      this.expire(active);
      return REFUSED;
    }

    this.observations.set(active.pairingId, {
      pairingId: active.pairingId,
      status: 'redeemed',
      expiresAt: instant(active.expiresAtMs),
      redeemedAt: createdAt,
      deviceName,
    });
    // After the grant is persisted, and unable to undo it: see {@link PairingGrantObserver}.
    try {
      await this.options.onGranted?.({ deviceId: record.id, deviceName, carrier, createdAt });
    } catch {
      // The observer reports its own failures; the device is paired either way.
    }
    return {
      kind: 'paired',
      response: PairingResponseSchema.parse({
        deviceId: record.id,
        daemonId: this.daemonId,
        daemonName: this.daemonName,
        capabilities: this.capabilities,
        // The one set this daemon resolved at boot, projected for the wire — the same reference the
        // refresh route holds, so a device's first answer and its next one cannot disagree. It cannot
        // fail this parse: the constructor already refused a set this schema would reject, which is
        // what keeps a bad carrier from being discovered after the code has been spent.
        carriers: this.options.carriers.current(),
        idleExpiryDays: this.options.idleExpiryDays?.() ?? DEVICE_IDLE_EXPIRY_DAYS,
      }),
    };
  }

  private expire(active: ActivePairing): void {
    if (this.active?.pairingId === active.pairingId) this.active = undefined;
    const current = this.observations.get(active.pairingId);
    this.observations.set(active.pairingId, {
      pairingId: active.pairingId,
      status: 'expired',
      expiresAt: current?.expiresAt ?? instant(active.expiresAtMs),
    });
  }
}

function instant(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/**
 * The advertisement with its address in canonical form.
 *
 * The address is normalised ONCE, here, for the reason it always was: `http://box.test` and the same
 * address with a trailing slash are the same place, and a fragment the protocol checks against a
 * differently-spelled copy of it fails a comparison about nothing. A refusal has no address to
 * normalise and is carried through untouched.
 */
function normalizedAdvertisement(advertisement: Advertisement): Advertisement {
  return advertisement.kind === 'none'
    ? advertisement
    : { ...advertisement, url: new URL(advertisement.url).toString() };
}
