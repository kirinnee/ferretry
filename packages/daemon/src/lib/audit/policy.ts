import {
  AUDIT_KEPT_EVENTS,
  type AuditActor,
  type AuditDetail,
  type AuditOutcome,
  type AuditRecord,
  AuditRecordSchema,
  auditShortId,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
} from '@ferretry/protocol';
import type { AuthenticatedCredential } from '../api/authentication.ts';
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
 *
 * A FERRET'S OWN SESSION CREDENTIAL IS `host` TOO — it is on this machine — and the record says which
 * ferret in its detail ({@link agentAuditDetail}), exactly as the agent tools have always recorded one.
 */
export function auditActorOf(
  credential: AuthenticatedCredential | undefined,
  deviceName: string | undefined,
): AuditActor {
  if (credential === undefined) return { kind: 'anonymous' };
  if (credential.tokenClass === 'session') return { kind: 'host' };
  if (credential.tokenClass !== 'device') return { kind: credential.tokenClass === 'admin' ? 'host' : 'warden' };
  return {
    kind: 'device',
    deviceId: credential.deviceId,
    ...(deviceName === undefined ? {} : { deviceName }),
  };
}

/**
 * The detail that names the ferret behind a record its own session credential caused: `by: 'agent'`, as
 * the agent tools write, and the session — never the credential. Nothing for any other caller.
 */
export function agentAuditDetail(credential: AuthenticatedCredential | undefined): AuditDetail {
  return credential?.tokenClass === 'session' ? { by: 'agent', session: credential.sessionId } : {};
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
 * deliberately not part of the key: a flood of random ids is one flood.
 *
 * A SUCCESSFUL ACT OF ACTIVITY — anything not in `AUDIT_KEPT_EVENTS`: an attach, keystrokes, a secret
 * used, an agent prompted — folds by who, what, what it was done to and every detail it carries. A
 * device can repeat activity at will, so "this phone attached to that terminal 15,000 times this
 * minute" is one line with a count, and two acts that differ in anything a reader would care about
 * never fold together.
 *
 * A SUCCESS OF A KEPT EVENT is never folded: each pairing, revocation or grant change is its own fact.
 */
export function auditFoldKey(entry: AuditEntry): string | undefined {
  const who = `${entry.actor.kind}:${entry.actor.deviceId ?? ''}`;
  if (entry.outcome === 'succeeded') {
    if (AUDIT_KEPT_EVENTS.includes(entry.event)) return undefined;
    const detail = Object.entries(entry.detail ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([who, entry.event, entry.subject ?? '', detail]);
  }
  const carrier = typeof entry.detail?.carrier === 'string' ? entry.detail.carrier : '';
  return `${who}|${entry.event}|${entry.outcome}|${carrier}`;
}

/**
 * Whether a record goes to the store a flood cannot reach — before the daily allowance is applied.
 *
 * Only a SUCCESS of a kept event: a refusal is what a flood is made of, and activity is what a paired
 * device can repeat for free, so letting either in would hand the flood the one store it must not have.
 */
export function isKeptAuditEntry(entry: AuditEntry): boolean {
  return entry.outcome === 'succeeded' && AUDIT_KEPT_EVENTS.includes(entry.event);
}

/**
 * How many kept records of ONE event every caller who is not a person at this machine may write,
 * together, per UTC day.
 *
 * ONE ALLOWANCE PER EVENT, SHARED BY ALL OF THEM. Shared, because a device can mint codes and pair new
 * devices, and every one it pairs would bring an allowance of its own. Per event, so churn of a cheap
 * kept event — fifty secret puts — cannot spend the allowance a pairing or a revocation needs. Fifty a
 * day of any one event is far more than a person makes from their phones; with nine kept events at
 * about 300 bytes a line, the kept store holds weeks of a flood at the cap before it is full, and a
 * full store refuses a rationed line rather than rotating (see `AuditLog`). Somebody at the machine
 * has no allowance: they already own the files.
 *
 * WHAT IS RATIONED IS DECIDED BY THE CAUSE, NOT THE ACTOR. An idle expiry is the machine acting, but a
 * paired device decides how many happen, so it is rationed too (`AuditEntry.cause`).
 *
 * The first record of an event past the allowance is still kept, marked `detail.keptAllowanceSpent`,
 * so the reader is TOLD the allowance ran out; the rest that day are counted into one kept line, which
 * names their subjects as far as the detail bound allows.
 */
export const AUDIT_KEPT_DAILY_ALLOWANCE = 50;

/** Whether a kept record is exempt from the allowance and may rotate the kept store: a person at the machine. */
export function isOwnersOwnRecord(entry: AuditEntry): boolean {
  return entry.actor.kind === 'host' && entry.cause !== 'daemon';
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
 * RESERVED, because an agent pushes its own words: an Attention card's title is the push's heading. An
 * agent that could send "A new device was paired" — or a reassuring fake — would be able to impersonate
 * the one notification a person must be able to trust. `agendaNotificationTitle` labels any title
 * that reads as this alert as `Ferret “…”`, and an Attention push's eventKey and tag are its own, so no
 * agent payload can open with either.
 */
export const DEVICE_PAIRED_EVENT_PREFIX = 'device-paired:';
export const DEVICE_PAIRED_TITLE = 'A new device was paired';

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
export function newDeviceAlert(device: PairedDeviceNotice, machineName: string): PushNotificationPayload {
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
