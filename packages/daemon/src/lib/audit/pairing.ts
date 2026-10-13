import {
  type PairingCarrier,
  type PairingGrant,
  type PairingRedemption,
  PairingService,
  type RelayPairingAttempt,
} from '../pairing/index.ts';
import type { AuditFailureReporter, AuditSink, NewDeviceAlertPort } from './types.ts';

/** What the pairing audit needs beyond the pairing service itself. */
export interface PairingAuditOptions {
  readonly log: AuditSink;
  readonly alert: NewDeviceAlertPort;
  readonly failures: AuditFailureReporter;
}

/**
 * The pairing state machine, with every redemption written to the security log.
 *
 * A SUBCLASS, so the composition root swaps one constructor and nothing that holds a
 * `PairingService` changes type. Every decision is still the parent's.
 *
 * WHICH DEVICE WAS PAIRED comes from the parent's `onGranted` port, called once the grant is persisted
 * — never from the response, which carries the new credential, and never from a before/after diff of
 * the device list, which a concurrent revoke or a second redemption could make name the wrong device.
 *
 * NEITHER WRITE DECIDES THE REDEMPTION. The record is awaited — `AuditLog` never throws — and the
 * Web Push alert is NOT: a slow push service must not hold a device's first answer open, so it is
 * fired, and a failure is reported to the operator rather than thrown.
 *
 * REFUSALS ARE FOLDED BY `AuditLog`, per carrier per window (see `auditFoldKey`), so a stranger
 * guessing badly on purpose writes one line a minute and cannot rotate the real history away.
 */
export class AuditedPairingService extends PairingService {
  readonly #audit: PairingAuditOptions;

  constructor(options: ConstructorParameters<typeof PairingService>[0], audit: PairingAuditOptions) {
    super({ ...options, onGranted: async grant => await granted(audit, grant) });
    this.#audit = audit;
  }

  override async redeem(value: unknown, rateLimitKey: string): Promise<PairingRedemption> {
    return await this.#observed(await super.redeem(value, rateLimitKey), 'direct');
  }

  override async redeemOverRelay(attempt: RelayPairingAttempt): Promise<PairingRedemption> {
    return await this.#observed(await super.redeemOverRelay(attempt), 'relay');
  }

  async #observed(result: PairingRedemption, carrier: PairingCarrier): Promise<PairingRedemption> {
    if (result.kind === 'refused')
      await this.#audit.log.record({
        event: 'pairing.refused',
        actor: { kind: 'anonymous' },
        outcome: 'refused',
        detail: { carrier },
      });
    return result;
  }
}

async function granted(audit: PairingAuditOptions, grant: PairingGrant): Promise<void> {
  await audit.log.record({
    event: 'device.paired',
    actor: { kind: 'device', deviceId: grant.deviceId, deviceName: grant.deviceName },
    subject: grant.deviceId,
    outcome: 'succeeded',
    detail: { carrier: grant.carrier },
  });
  void audit.alert.newDevicePaired(grant).catch((error: unknown) => {
    audit.failures.auditWriteFailed(
      `the other devices could not be told that a device was paired: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
