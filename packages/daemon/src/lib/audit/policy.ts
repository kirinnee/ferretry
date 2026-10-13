import {
  AUDIT_KEPT_EVENTS,
  auditShortId,
  type AuditActor,
  type AuditDetail,
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
 * Which repeats fold together, or nothing for a record that is never folded.
 *
 * A REFUSAL OR A FAILURE folds by who, what and how it ended — and by carrier, when the record names
 * one, so a stranger guessing over the relay does not hide the one guessing on the LAN. The SUBJECT is
 * deliberately not part of the key: a flood of random ids is one flood. TERMINAL INPUT folds per
 * terminal, because "this device typed into that shell" is the fact, and a keystroke count is all a
 * reader needs of it. Every other success is its own act and is never folded.
 */
export function auditFoldKey(entry: AuditEntry): string | undefined {
  const who = `${entry.actor.kind}:${entry.actor.deviceId ?? ''}`;
  const carrier = typeof entry.detail?.carrier === 'string' ? entry.detail.carrier : '';
  if (entry.event === 'terminal.input') return `${who}|${entry.event}|${entry.subject ?? ''}`;
  if (entry.outcome === 'succeeded') return undefined;
  return `${who}|${entry.event}|${entry.outcome}|${carrier}`;
}

/**
 * Whether a record goes to the store a flood cannot reach.
 *
 * Only a SUCCESS of a kept event: a refusal is what a flood is made of, so letting refusals into the
 * kept store would hand the flood the one store it must not have.
 */
export function isKeptAuditEntry(entry: AuditEntry): boolean {
  return entry.outcome === 'succeeded' && AUDIT_KEPT_EVENTS.includes(entry.event);
}

/** What stands in for a text field the contract would refuse — never the text itself. */
export const AUDIT_INVALID_TEXT = '<invalid>';
const AUDIT_TEXT = /^[^\p{Cc}\p{Cf}]{1,160}$/u;

/**
 * An entry whose free text is made to fit, so the EVENT is never lost to its own subject.
 *
 * The subject is a raw path parameter, and a 161-character or bidi-override id would otherwise fail
 * the record's schema — dropping the whole record, which is a way to probe ids without a trace. The
 * offending text is replaced by {@link AUDIT_INVALID_TEXT} and its length is kept, never its content.
 */
export function withinAuditBounds(entry: AuditEntry): AuditEntry {
  const subjectFits = entry.subject === undefined || AUDIT_TEXT.test(entry.subject);
  const detail: AuditDetail | undefined =
    entry.detail === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(entry.detail).map(([key, value]) => [
            key,
            typeof value !== 'string' || AUDIT_TEXT.test(value) ? value : AUDIT_INVALID_TEXT,
          ]),
        );
  if (subjectFits) return detail === undefined ? entry : { ...entry, detail };
  return {
    ...entry,
    subject: AUDIT_INVALID_TEXT,
    detail: { ...detail, subjectLength: entry.subject?.length ?? 0 },
  };
}

/**
 * The eventKey and tag prefix only this alert may carry, and the title it opens with.
 *
 * RESERVED, because an agent can push its own words through `POST /v1/sessions/:id/notify`: an agent
 * that could send "A new device was paired" — or a reassuring fake — would be able to impersonate the
 * one notification a person must be able to trust. `directNotificationPayload` puts the session's
 * name, labelled as an agent, in front of every agent title, and its eventKey and tag are fixed, so no
 * agent payload can open with either.
 */
export const DEVICE_PAIRED_EVENT_PREFIX = 'device-paired:';
export const DEVICE_PAIRED_TITLE = 'A new device was paired';

/**
 * What every other enrolled device reads when a new one is paired.
 *
 * NO `kind`, deliberately: a payload about no session bypasses a device's session preferences (see
 * `acceptsDispatch`), and "somebody new can now reach this machine" is not noise a person can
 * have meant to switch off by declining unattended-session alerts.
 *
 * THE NAME IS QUOTED AND NEVER STANDS ALONE. The person who paired chose it, so it is printed as a
 * label in quotes beside the facts nobody chose: the carrier it arrived over, the daemon's time, and
 * the short id the device list shows.
 *
 * `url` is the application root, like every other notification here: the client owns its own route
 * table, and the app shows its new-device notice — with the one-tap removal — wherever it opens.
 */
export function newDeviceAlert(device: PairedDeviceNotice, machineName: string): PushNotificationPayload {
  const over = device.carrier === 'relay' ? 'over the relay' : 'on the local network';
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `${DEVICE_PAIRED_EVENT_PREFIX}${device.deviceId}`,
    title: DEVICE_PAIRED_TITLE,
    body: `A device calling itself “${device.deviceName}” (${auditShortId(device.deviceId)}) was paired with ${machineName} ${over} at ${device.createdAt}. If that was not you, remove it in Settings.`,
    tag: `${DEVICE_PAIRED_EVENT_PREFIX}${device.deviceId}`,
    url: '/',
    count: 1,
  });
}
