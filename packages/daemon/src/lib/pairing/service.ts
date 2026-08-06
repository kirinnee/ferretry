import {
  type Advertisement,
  type AdvertisementRefusal,
  type DaemonCarrier,
  type DaemonId,
  DaemonIdSchema,
  DaemonNameSchema,
  DeviceTokenSchema,
  type PairedDevice,
  PairedDeviceSchema,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_SECONDS,
  type PairingCode,
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  PairingCodeSchema,
  type PairingCodeStatusResponse,
  type PairingId,
  PairingIdSchema,
  type PairingReach,
  PairingRequestSchema,
  type PairingResponse,
  PairingResponseSchema,
} from '@ferretry/protocol';
import { type DeviceCredentialVerifier, secretsMatch } from '../api/authentication.ts';

const FERRETRY_PAIRING_APP_URL = 'https://ferretry.pages.dev/pair';
const PAIRING_RATE_LIMIT_ATTEMPTS = 10;
const PAIRING_RATE_LIMIT_WINDOW_MS = 60_000;
const PAIRING_RATE_LIMIT_MAX_KEYS = 4_096;

const DUMMY_PAIRING_CODE = '2222-2222';
const OBSERVATION_LIMIT = 128;

export interface PairingClock {
  now(): number;
}

export interface PairingCryptography {
  pairingCode(): string;
  pairingId(): string;
  deviceToken(): string;
  deviceId(): string;
  hashDeviceToken(daemonId: string, token: string): string;
}

export interface PairingDeviceRecord {
  readonly id: string;
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly platform: 'browser';
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly tokenHash: string;
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
}

/**
 * Live verifier for this daemon's persisted device grants.
 *
 * Hashing includes the daemon id, so copying a hash document to another daemon cannot make the
 * credential valid there. Every comparison walks the whole digest and every record; neither the
 * matching prefix nor a record's position becomes an early-exit timing oracle.
 */
export class PairingDeviceRegistry implements DeviceCredentialVerifier {
  private readonly records = new Map<string, PairingDeviceRecord>();

  constructor(
    private readonly daemonId: DaemonId,
    private readonly cryptography: Pick<PairingCryptography, 'hashDeviceToken'>,
    records: readonly PairingDeviceRecord[] = [],
    private readonly compare: (left: string, right: string) => boolean = secretsMatch,
  ) {
    for (const record of records) this.add(record);
  }

  /**
   * Forgets one grant, so the credential stops authenticating THIS INSTANT.
   *
   * The registry is the live verifier, and it is the half of a revocation that actually ends access:
   * the document on disk decides what comes back after a restart, while this decides whether the next
   * request is served. A revocation that only rewrote the file would leave a revoked phone working
   * until somebody restarted the daemon, which is precisely when nobody is going to.
   */
  remove(id: string): boolean {
    return this.records.delete(id);
  }

  add(record: PairingDeviceRecord): void {
    if (record.daemonId !== this.daemonId) throw new Error('a device grant belongs to a different daemon');
    // A grant with no digest is not a grant. It could never match a real digest, so it would sit in
    // the registry as a device that silently cannot authenticate — and the invariant "a stored grant
    // is comparable evidence" would hold only in the file schema, one layer away from the comparison
    // that relies on it. Refuse loudly instead of registering something unusable.
    if (record.tokenHash.trim() === '') throw new Error('a device grant carries no token digest');
    this.records.set(record.id, record);
  }

  identify(token: string): string | undefined {
    // Nothing is not a credential. Without this a blank token is hashed and compared against every
    // record, safe today only because no grant can hold the digest of an empty token — a property
    // owned by a schema elsewhere rather than by this comparison.
    if (token.trim() === '') return undefined;
    const digest = this.cryptography.hashDeviceToken(this.daemonId, token);
    let identity: string | undefined;
    for (const record of this.records.values()) {
      if (this.compare(digest, record.tokenHash)) identity = record.id;
    }
    return identity;
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
  attempts: number;
}

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
   * IT IS THE VALUE, NOT A WAY TO ASK FOR ONE. The composition root resolves the set once, before this
   * service exists, and gives the SAME ARRAY to `GET /v1/carriers`. A getter would have been the
   * flexible choice and it would also have been the bug: two calls may answer differently, so the set
   * a device is handed at pairing could stop matching the set it refreshes, which is precisely the
   * disagreement the published set was introduced to end.
   *
   * THIS SERVICE DECIDES NOTHING ABOUT IT. Nothing here filters, re-orders or adds to it, and it is
   * never held as anything but `readonly`. `PairingResponseSchema` parses it on the way out, so a
   * carrier this daemon's own device would refuse cannot leave through here.
   */
  readonly carriers: readonly DaemonCarrier[];
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
  readonly rateLimiter?: PairingRateLimiter;
  readonly compare?: (left: string, right: string) => boolean;
  readonly pairingAppUrl?: string;
  readonly capabilities?: readonly string[];
}

export type PairingRedemption =
  | { readonly kind: 'paired'; readonly response: PairingResponse }
  | { readonly kind: 'refused' };

const REFUSED = { kind: 'refused' } as const;

/** The complete pairing state machine. One instance belongs to one daemon runtime. */
export class PairingService {
  private readonly daemonId: DaemonId;
  private readonly daemonName: string;
  private readonly advertisement: Advertisement;
  private readonly pairingAppUrl: string;
  private readonly capabilities: readonly string[];
  private readonly rateLimiter: PairingRateLimiter;
  private readonly compare: (left: string, right: string) => boolean;
  private active: ActivePairing | undefined;
  private readonly observations = new Map<PairingId, PairingCodeStatusResponse>();

  constructor(private readonly options: PairingServiceOptions) {
    this.daemonId = DaemonIdSchema.parse(options.daemonId);
    this.daemonName = DaemonNameSchema.parse(options.daemonName);
    this.advertisement = normalizedAdvertisement(options.advertisement);
    this.pairingAppUrl = new URL(options.pairingAppUrl ?? FERRETRY_PAIRING_APP_URL).toString();
    this.capabilities = [...(options.capabilities ?? ['daemon-api'])];
    this.rateLimiter = options.rateLimiter ?? new PairingRateLimiter(options.clock);
    this.compare = options.compare ?? secretsMatch;
  }

  mint(): PairingCodeMintResponse {
    if (this.active !== undefined) this.expire(this.active);
    while (this.observations.size >= OBSERVATION_LIMIT) {
      const oldest = this.observations.keys().next().value;
      if (oldest !== undefined) this.observations.delete(oldest);
    }

    const pairingId = PairingIdSchema.parse(this.options.cryptography.pairingId());
    const code = PairingCodeSchema.parse(this.options.cryptography.pairingCode());
    const expiresAtMs = this.options.clock.now() + PAIRING_CODE_TTL_SECONDS * 1_000;
    const expiresAt = instant(expiresAtMs);
    this.active = { pairingId, code, expiresAtMs, attempts: 0 };
    this.observations.set(pairingId, { pairingId, status: 'pending', expiresAt });

    return PairingCodeMintResponseSchema.parse({
      pairingId,
      code,
      ttlSeconds: PAIRING_CODE_TTL_SECONDS,
      expiresAt,
      daemonId: this.daemonId,
      daemonName: this.daemonName,
      ...this.#link(code),
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
  #link(
    code: PairingCode,
  ):
    | { readonly daemonUrl: string; readonly pairUrl: string; readonly reach: PairingReach }
    | { readonly refusal: AdvertisementRefusal } {
    if (this.advertisement.kind === 'none') return { refusal: this.advertisement.refusal };
    const daemonUrl = this.advertisement.url;
    return {
      daemonUrl,
      pairUrl: pairingUrl(this.pairingAppUrl, daemonUrl, code, this.daemonId),
      // The decision's vocabulary translated into the wire's, in the one place that crosses between
      // them: an address a different device can dial is an address any device can redeem.
      reach: this.advertisement.kind === 'address' ? 'any-device' : 'local-only',
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
   * THE DIGEST IS DROPPED HERE, and it is dropped by construction rather than by remembering to: the
   * return type is the protocol's `PairedDevice`, which has no field for one. A record's `tokenHash` is
   * the only thing standing between a leaked state file and a forged credential, and no caller of this
   * has any use for it.
   */
  async devices(): Promise<readonly PairedDevice[]> {
    const records = await this.options.devices.list();
    return records.map(record =>
      PairedDeviceSchema.parse({
        id: record.id,
        name: record.name,
        platform: record.platform,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
      }),
    );
  }

  /**
   * Takes one device's access away.
   *
   * THE ORDER IS DELIBERATE: the document is written first, and only a successful write removes the
   * live credential. The other order — kill it in memory, then persist — turns a failed write into a
   * daemon whose answer disagrees with its own state file, so the phone stops working now and starts
   * working again at the next restart, which is the least explainable outcome available. This way a
   * write failure means nothing was revoked, the caller is told, and the operator can try again.
   *
   * There is no await between the write and the in-memory removal, so no request can be authenticated
   * against a credential this daemon has already promised to forget.
   *
   * DEVICE-SCOPED STATE GOES FIRST, before the grant it belongs to. That is the opposite of the order
   * above and for the same reason: whichever step fails, the world it leaves has to be coherent. Purging
   * first means a failure leaves the device fully paired with its state intact — retryable, nothing
   * half-done — whereas revoking first would leave a phone that is unpaired and still receiving this
   * machine's notifications, which is the outcome the purge exists to prevent. The cost of this order is
   * a moment in which a still-paired device has lost its notifications; it is strictly the safer half.
   */
  async revokeDevice(id: string): Promise<boolean> {
    for (const owner of this.options.deviceState ?? []) await owner.forgetDevice(id);
    const removed = await this.options.devices.remove(id);
    if (!removed) return false;
    this.options.credentials.remove(id);
    return true;
  }

  async redeem(value: unknown, rateLimitKey: string): Promise<PairingRedemption> {
    if (!this.rateLimiter.admit(rateLimitKey)) return REFUSED;

    const parsed = PairingRequestSchema.safeParse(value);
    const candidate = parsed.success ? parsed.data.code : pairingCodeFrom(value);
    const active = this.active;
    const matches = this.compare(candidate, active?.code ?? DUMMY_PAIRING_CODE);
    const now = this.options.clock.now();

    if (active === undefined) return REFUSED;
    if (now >= active.expiresAtMs) {
      this.expire(active);
      return REFUSED;
    }
    // A body that cannot describe a code guess is still compared above, but it cannot spend the
    // daemon-wide five-guess budget. Otherwise anybody could kill the active code with five broken
    // uploads while rotating through rate-limit keys.
    if (!parsed.success) return REFUSED;
    if (!matches) {
      active.attempts += 1;
      if (active.attempts >= PAIRING_CODE_MAX_ATTEMPTS) this.expire(active);
      return REFUSED;
    }

    // The consume is the synchronous state change immediately before any persistence await. A
    // concurrent call therefore sees no active code and cannot enter the successful branch.
    this.active = undefined;
    const createdAt = instant(now);
    const deviceToken = DeviceTokenSchema.parse(this.options.cryptography.deviceToken());
    const record: PairingDeviceRecord = {
      id: this.options.cryptography.deviceId(),
      daemonId: this.daemonId,
      name: parsed.data.deviceName,
      platform: 'browser',
      createdAt,
      lastSeenAt: createdAt,
      tokenHash: this.options.cryptography.hashDeviceToken(this.daemonId, deviceToken),
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
      deviceName: parsed.data.deviceName,
    });
    return {
      kind: 'paired',
      response: PairingResponseSchema.parse({
        deviceToken,
        daemonId: this.daemonId,
        daemonName: this.daemonName,
        capabilities: this.capabilities,
        // The one set this daemon resolved at boot, projected for the wire. The refresh route answers
        // with the same array, so a device's first answer and its next one cannot disagree.
        carriers: this.options.carriers,
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

function pairingCodeFrom(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('code' in value)) return '';
  return typeof value.code === 'string' ? value.code : '';
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

function pairingUrl(appUrl: string, daemonUrl: string, code: PairingCode, daemonId: DaemonId): string {
  const url = new URL(appUrl);
  url.hash = `v1;url=${encodeURIComponent(daemonUrl)};code=${code};fp=${encodeURIComponent(daemonId)}`;
  return url.toString();
}
