import type { AuditDetail } from '@ferretry/protocol';
import { type PairingRedemption, PairingService, type RelayPairingAttempt } from '../pairing/index.ts';
import type { AuditSink, NewDeviceAlertPort } from './types.ts';

/** What the pairing audit needs beyond the pairing service itself. */
export interface PairingAuditOptions {
  readonly log: AuditSink;
  readonly alert: NewDeviceAlertPort;
  /** Monotonic enough milliseconds, for spacing out refusal records. */
  nowMs(): number;
}

/**
 * How far apart two `pairing.refused` records are kept, at least.
 *
 * WHY REFUSALS ARE SPACED AND NOTHING ELSE IS. Pairing redemption is the one door anybody can knock
 * on without a credential, and the log is bounded at two mebibytes. A record per refusal would let a
 * stranger rotate the real history out of the log by guessing badly on purpose. One record per window
 * per carrier, carrying how many were folded into it, keeps the fact ("somebody kept trying") and
 * costs an attacker the ability to erase anything.
 */
export const PAIRING_REFUSAL_WINDOW_MS = 60_000;

type Carrier = 'direct' | 'relay';

/**
 * The pairing state machine, with every redemption written to the security log.
 *
 * A SUBCLASS, so the composition root swaps one constructor and nothing that holds a
 * `PairingService` changes type. Every decision is still the parent's: this only observes the
 * answer it gave, after it gave it.
 *
 * NAMES AND IDS ONLY. The code a caller presented and the address a guess arrived from are in scope
 * here, and neither reaches a record; the credential the parent issues is never read at all: a paired device is
 * recorded by its id and its owner-chosen name, a refusal by its carrier and a count.
 */
export class AuditedPairingService extends PairingService {
  readonly #audit: PairingAuditOptions;
  readonly #lastRefusal = new Map<Carrier, { readonly atMs: number }>();
  readonly #folded = new Map<Carrier, number>();

  constructor(options: ConstructorParameters<typeof PairingService>[0], audit: PairingAuditOptions) {
    super(options);
    this.#audit = audit;
  }

  override async redeem(value: unknown, rateLimitKey: string): Promise<PairingRedemption> {
    const before = await this.#deviceIds();
    return await this.#observed(await super.redeem(value, rateLimitKey), before, 'direct');
  }

  override async redeemOverRelay(attempt: RelayPairingAttempt): Promise<PairingRedemption> {
    const before = await this.#deviceIds();
    return await this.#observed(await super.redeemOverRelay(attempt), before, 'relay');
  }

  /**
   * The grants that exist right now.
   *
   * WHICH DEVICE WAS JUST PAIRED is read as the one grant that was not here before the redemption,
   * rather than from the response: the response carries the new credential, and this class has no
   * business holding it even for a lookup. One live code can be redeemed once, so at most one grant
   * can appear across one successful call.
   */
  async #deviceIds(): Promise<ReadonlySet<string>> {
    return new Set((await this.devices()).map(device => device.id));
  }

  async #observed(
    result: PairingRedemption,
    before: ReadonlySet<string>,
    carrier: Carrier,
  ): Promise<PairingRedemption> {
    if (result.kind === 'paired') await this.#paired(before, carrier);
    else await this.#refused(carrier);
    return result;
  }

  async #paired(before: ReadonlySet<string>, carrier: Carrier): Promise<void> {
    const device = (await this.devices()).find(entry => !before.has(entry.id));
    const deviceId = device?.id;
    await this.#audit.log.record({
      event: 'device.paired',
      actor: {
        kind: 'device',
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(device === undefined ? {} : { deviceName: device.name }),
      },
      ...(deviceId === undefined ? {} : { subject: deviceId }),
      outcome: 'succeeded',
      detail: { carrier },
    });
    if (deviceId !== undefined && device !== undefined)
      await this.#audit.alert.newDevicePaired({ deviceId, deviceName: device.name });
  }

  async #refused(carrier: Carrier): Promise<void> {
    const now = this.#audit.nowMs();
    const last = this.#lastRefusal.get(carrier);
    if (last !== undefined && now - last.atMs < PAIRING_REFUSAL_WINDOW_MS) {
      this.#folded.set(carrier, (this.#folded.get(carrier) ?? 0) + 1);
      return;
    }
    const folded = this.#folded.get(carrier) ?? 0;
    this.#lastRefusal.set(carrier, { atMs: now });
    this.#folded.set(carrier, 0);
    const detail: AuditDetail = { carrier, ...(folded === 0 ? {} : { earlierRefusals: folded }) };
    await this.#audit.log.record({
      event: 'pairing.refused',
      actor: { kind: 'anonymous' },
      outcome: 'refused',
      detail,
    });
  }
}
