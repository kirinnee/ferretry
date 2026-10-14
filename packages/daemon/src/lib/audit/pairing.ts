import {
  type PairingCarrier,
  type PairingGrant,
  type PairingRedemption,
  PairingService,
  type SessionPairingAttempt,
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
 * — never from the response, and never from a before/after diff of
 * the device list, which a concurrent revoke or a second redemption could make name the wrong device.
 *
 * NEITHER WRITE DECIDES THE REDEMPTION. The record is awaited — `AuditLog` never throws — and the
 * Web Push alert is NOT: a slow push service must not hold a device's first answer open, so it is
 * fired, and a failure is reported to the operator rather than thrown.
 *
 * REFUSALS ARE FOLDED BY `AuditLog`, per carrier per window (see `auditFoldKey`), so a stranger
 * guessing badly on purpose writes one line a minute and cannot rotate the real history away.
 *
 * THE TWO CHANGES NO ROUTE MAKES are recorded here too, so the log is the one place every change to who
 * may reach this machine shows: a device's key replaced inside a step-up (`device.key-rotated`), and a
 * device the daemon revoked itself for going idle (`device.expired`), which nobody asked for and the
 * grant journal therefore never records.
 */
export class AuditedPairingService extends PairingService {
  readonly #audit: PairingAuditOptions;

  constructor(options: ConstructorParameters<typeof PairingService>[0], audit: PairingAuditOptions) {
    super({ ...options, onGranted: async grant => await granted(audit, grant) });
    this.#audit = audit;
  }

  override async redeemInSession(attempt: SessionPairingAttempt, carrier: PairingCarrier): Promise<PairingRedemption> {
    const result = await super.redeemInSession(attempt, carrier);
    if (result.kind === 'refused')
      await this.#audit.log.record({
        event: 'pairing.refused',
        actor: { kind: 'anonymous' },
        outcome: 'refused',
        detail: { carrier: carrier.kind },
      });
    return result;
  }

  override async rotateDeviceKey(id: string, publicKey: string): Promise<boolean> {
    const rotated = await super.rotateDeviceKey(id, publicKey);
    if (rotated)
      await this.#audit.log.record({
        event: 'device.key-rotated',
        actor: { kind: 'device', deviceId: id },
        subject: id,
        outcome: 'succeeded',
      });
    return rotated;
  }

  /**
   * A revocation with NO actor is the daemon's own idle expiry — every route names the caller — and
   * is recorded as `device.expired`. A route's revocation is recorded by the route table instead.
   */
  override async revokeDevice(id: string, actor?: string): Promise<boolean> {
    const removed = await super.revokeDevice(id, actor);
    if (removed && actor === undefined)
      await this.#audit.log.record({
        event: 'device.expired',
        actor: { kind: 'host' },
        subject: id,
        outcome: 'succeeded',
      });
    return removed;
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
