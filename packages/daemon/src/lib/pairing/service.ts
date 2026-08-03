import {
  type DaemonId,
  DaemonIdSchema,
  DaemonNameSchema,
  DeviceTokenSchema,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_SECONDS,
  type PairingCode,
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  PairingCodeSchema,
  type PairingCodeStatusResponse,
  type PairingId,
  PairingIdSchema,
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

interface PairingServiceOptions {
  readonly daemonId: string;
  readonly daemonName: string;
  readonly daemonUrl: string;
  readonly clock: PairingClock;
  readonly cryptography: PairingCryptography;
  readonly devices: PairingDeviceStore;
  readonly credentials: PairingDeviceRegistry;
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
  private readonly daemonUrl: string;
  private readonly pairingAppUrl: string;
  private readonly capabilities: readonly string[];
  private readonly rateLimiter: PairingRateLimiter;
  private readonly compare: (left: string, right: string) => boolean;
  private active: ActivePairing | undefined;
  private readonly observations = new Map<PairingId, PairingCodeStatusResponse>();

  constructor(private readonly options: PairingServiceOptions) {
    this.daemonId = DaemonIdSchema.parse(options.daemonId);
    this.daemonName = DaemonNameSchema.parse(options.daemonName);
    this.daemonUrl = new URL(options.daemonUrl).toString();
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
      daemonUrl: this.daemonUrl,
      pairUrl: pairingUrl(this.pairingAppUrl, this.daemonUrl, code, this.daemonId),
    });
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

function pairingUrl(appUrl: string, daemonUrl: string, code: PairingCode, daemonId: DaemonId): string {
  const url = new URL(appUrl);
  url.hash = `v1;url=${encodeURIComponent(daemonUrl)};code=${code};fp=${encodeURIComponent(daemonId)}`;
  return url.toString();
}
