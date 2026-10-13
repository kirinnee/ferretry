import {
  type AuditActor,
  type AuditOutcome,
  type AuditRecord,
  AuditRecordSchema,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
} from '@ferretry/protocol';
import type { AuthenticatedCredential } from '../api/socket-ticket.ts';
import type { AuditEntry, PairedDeviceNotice } from './types.ts';

/**
 * The pure decisions of the audit domain: who a credential is in the log's vocabulary, what a status
 * says about an outcome, what one record looks like, and what the new-device alert says.
 */

/**
 * Who the log says acted, from the credential the authorization boundary derived — never from
 * anything the caller sent.
 *
 * THE ADMIN TOKEN IS `host`. Reading it requires this machine's disk, so whoever holds it is, for the
 * log's purposes, at the machine. An absent credential is a public route's caller, which is somebody
 * who has not proved anything yet.
 */
export function auditActorOf(
  credential: AuthenticatedCredential | undefined,
  deviceName: string | undefined,
): AuditActor {
  if (credential === undefined) return { kind: 'anonymous' };
  if (credential.tokenClass !== 'device') return { kind: credential.tokenClass === 'admin' ? 'host' : 'warden' };
  return {
    kind: 'device',
    deviceId: credential.deviceId,
    ...(deviceName === undefined ? {} : { deviceName }),
  };
}

/**
 * What an HTTP status says happened.
 *
 * A 4xx is the daemon REFUSING — a wrong code, a switched-off grant, a request it would not run. A
 * 5xx, or no answer at all, is the daemon FAILING. The two are different facts to somebody reading
 * the log: one is the gate working, the other is something to repair.
 */
export function auditOutcomeOf(status: number | undefined): AuditOutcome {
  if (status === undefined || status >= 500) return 'failed';
  return status >= 400 ? 'refused' : 'succeeded';
}

/**
 * One record, stamped and PROVED against the wire contract before anything is written.
 *
 * Parsing here rather than trusting the emitter is what keeps the file readable by the same schema
 * that serves it: a record the reader would count as unreadable is refused at the door instead.
 */
export function auditRecord(entry: AuditEntry, at: string): AuditRecord {
  return AuditRecordSchema.parse({
    at,
    event: entry.event,
    actor: entry.actor,
    ...(entry.subject === undefined ? {} : { subject: entry.subject }),
    outcome: entry.outcome,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  });
}

/**
 * What every other enrolled device reads when a new one is paired.
 *
 * NO `kind`, deliberately: a payload about no session bypasses a device's session preferences (see
 * `acceptsDispatch`), and "somebody new can now reach this machine" is not noise a person can
 * have meant to switch off by declining unattended-session alerts.
 *
 * `url` is the application root, like every other notification here: the client owns its own route
 * table, and the app shows its new-device notice — with the one-tap removal — wherever it opens.
 */
export function newDeviceAlert(device: PairedDeviceNotice, machineName: string): PushNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `device-paired:${device.deviceId}`,
    title: 'A new device was paired',
    body: `A new device, ${device.deviceName}, was paired with ${machineName}. If that was not you, remove it in Settings.`,
    tag: `device-paired:${device.deviceId}`,
    url: '/',
    count: 1,
  });
}
