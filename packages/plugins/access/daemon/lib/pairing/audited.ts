import type { AuditDraft } from '@ferretry/core-gate/contract';
import { AUDIT_KINDS, auditShortId } from '@ferretry/core-gate/contract';
import { type PushNotificationPayload, PushNotificationPayloadSchema } from '../wire.ts';
import {
  type PairingCarrier,
  type PairingGrant,
  type PairingRedemption,
  PairingService,
  type SessionPairingAttempt,
} from './service.ts';

/**
 * Today's `daemon/src/lib/audit/pairing.ts` (`AuditedPairingService`) and the new-device alert of
 * `audit/{policy,service}.ts`, moved beside the pairing they audit. Records go to Gate's audit log
 * (`GatePort.audit`), names and ids only.
 */

/** What a pairing record goes to: Gate's audit port. It never throws (a failed write is Gate's to report). */
type AuditSink = (draft: AuditDraft) => Promise<void>;

/** Who hears that a new device was paired: every OTHER enrolled browser, by push. */
interface NewDeviceAlertPort {
  newDevicePaired(device: PairingGrant): Promise<void>;
}

/** Where an alert that could not be sent is said (the daemon log); never thrown into a redemption. */
export type AuditFailureReporter = (sentence: string) => void;

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
      await this.#audit.log({
        event: AUDIT_KINDS['pairing.refused'],
        actor: { kind: 'anonymous' },
        outcome: 'refused',
        detail: { carrier: carrier.kind },
      });
    return result;
  }

  override async rotateDeviceKey(id: string, publicKey: string): Promise<boolean> {
    const rotated = await super.rotateDeviceKey(id, publicKey);
    if (rotated)
      await this.#audit.log({
        event: AUDIT_KINDS['device.key-rotated'],
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
      await this.#audit.log({
        event: AUDIT_KINDS['device.expired'],
        actor: { kind: 'host' },
        subject: id,
        outcome: 'succeeded',
      });
    return removed;
  }
}

async function granted(audit: PairingAuditOptions, grant: PairingGrant): Promise<void> {
  await audit.log({
    event: AUDIT_KINDS['device.paired'],
    actor: { kind: 'device', deviceId: grant.deviceId, deviceName: grant.deviceName },
    subject: grant.deviceId,
    outcome: 'succeeded',
    detail: { carrier: grant.carrier },
  });
  void audit.alert.newDevicePaired(grant).catch((error: unknown) => {
    audit.failures(
      `the other devices could not be told that a device was paired: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

const DEVICE_PAIRED_EVENT_PREFIX = 'device-paired:';
const DEVICE_PAIRED_TITLE = 'A new device was paired';

/**
 * What every other enrolled device reads when a new one is paired.
 *
 * `kind: 'device-paired'` IS SENT, so a reader's own local "new device" switch (see
 * `packages/pwa/src/lib/notification-filter.ts`) can tell this apart from every other event — this
 * daemon no longer stores or enforces any preference itself, so the client is the only place left to
 * decide whether to show it. That is also why every enrolled device is sent it unconditionally
 * (`PushService.notify`): "somebody new can now reach this machine" is a fact every other device is
 * told, and which of them chooses to surface it is entirely local.
 *
 * THE NAME IS QUOTED AND NEVER STANDS ALONE. The person who paired chose it, so it is printed as a
 * label in quotes beside the facts nobody chose: the carrier it arrived over, the daemon's time, and
 * the short id the device list shows.
 *
 * `url` is the application root, like every other notification here: the client owns its own route
 * table, and the app shows its new-device notice — with the one-tap removal — wherever it opens.
 */
function newDeviceAlert(device: PairingGrant, machineName: string): PushNotificationPayload {
  const over = device.carrier === 'relay' ? 'over the relay' : 'on the local network';
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `${DEVICE_PAIRED_EVENT_PREFIX}${device.deviceId}`,
    kind: 'device-paired',
    title: DEVICE_PAIRED_TITLE,
    body: `A device calling itself “${device.deviceName}” (${auditShortId(device.deviceId)}) was paired with ${machineName} ${over} at ${device.createdAt}. If that was not you, remove it in Settings.`,
    tag: `${DEVICE_PAIRED_EVENT_PREFIX}${device.deviceId}`,
    url: '/',
    count: 1,
  });
}

/** Today's `PushNewDeviceAlert`: tells every enrolled browser, and reports (never throws) a failure. */
export class PushNewDeviceAlert implements NewDeviceAlertPort {
  constructor(
    private readonly push: {
      list(): Promise<readonly { readonly id: string }[]>;
      notify(dispatch: { readonly payload: PushNotificationPayload }, to?: readonly string[]): Promise<unknown>;
    },
    private readonly machineName: string,
    private readonly failures: AuditFailureReporter,
  ) {}

  async newDevicePaired(device: PairingGrant): Promise<void> {
    try {
      const addressed = (await this.push.list()).map(enrolment => enrolment.id);
      if (addressed.length === 0) return;
      await this.push.notify({ payload: newDeviceAlert(device, this.machineName) }, addressed);
    } catch (error) {
      this.failures(
        `the other devices could not be told that device ${auditShortId(device.deviceId)} was paired: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
