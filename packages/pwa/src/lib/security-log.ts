/**
 * THE SECURITY LOG AND THE NEW-DEVICE NOTICE, in the words a person reads.
 *
 * Both surfaces answer one question — "who can reach this machine, and what have they done" — so the
 * words live in one place. A notice that says "A device was paired" while the log under it says
 * something else about the same event is two answers to one question.
 *
 * Nothing here reads a clock, a store or the network: every instant is an argument, so the tests can
 * hold time still and the components decide where "now" comes from.
 */

import {
  type AuditActor,
  type AuditEvent,
  type AuditOutcome,
  type AuditRecord,
  auditShortId,
  type PairedDevice,
  type PairedDevicesView,
} from '@ferretry/protocol';

/** Every event the log can hold, as a sentence. Closed over the wire’s own list, so a new kind fails typecheck here. */
export const AUDIT_EVENT_WORDS: Readonly<Record<AuditEvent, string>> = {
  'device.paired': 'A device was paired',
  'device.revoked': 'A device was removed',
  'device.expired': 'A device’s access expired',
  'device.key-rotated': 'A device’s key was replaced',
  'pairing.code-minted': 'A pairing code was made',
  'pairing.code-revoked': 'A pairing code was withdrawn',
  'pairing.refused': 'A pairing attempt was refused',
  'session.opened': 'An agent session was started',
  // A step-up is a passkey ceremony, not a password: "Password confirmation" told a reader the wrong
  // thing had been tried.
  'step-up.succeeded': 'Passkey confirmation passed',
  'step-up.failed': 'Passkey confirmation failed',
  'passkey.registered': 'A passkey was added',
  'terminal.opened': 'A terminal was opened',
  'terminal.input': 'Keystrokes reached a terminal',
  'fleet.configured': 'Agent settings were changed',
  'grants.changed': 'Remote permissions were changed',
  'secrets.used': 'A secret was used',
  'secrets.changed': 'A secret was stored or deleted',
  'catalog.changed': 'A catalog this machine publishes was changed',
  'catalog.exported': 'A catalog was exported as a signed file',
  'security.changed': 'A security setting was changed',
  'push.changed': 'Notifications were turned on or off for a device',
  'warden.configured': 'The supervisor was reconfigured',
  'warden.ran': 'The supervisor was run',
  'browser.opened': 'A browser was opened',
  'browser.proxy-tested': 'The browser proxy was tested',
  'worktree.removed': 'A worktree was removed',
  'agent.prompted': 'An agent was given a message',
  'agent.tool': 'An agent drove a terminal or browser',
  'surface.control': 'A person took over or handed back a terminal or browser',
  'input.requested': 'A ferret asked for a value to be typed',
  'input.delivered': 'A value was typed into a terminal or page for a ferret',
  'input.refused': 'A value for a ferret was not typed',
  'input.expired': 'A request for a value ran out of time',
  'input.cancelled': 'A request for a value was cancelled',
  'input.quarantine_ended': 'A terminal that a ferret was kept out of was opened up again',
  'input.quarantine_revealed': 'A viewer chose to see a terminal a ferret was kept out of',
  'link.opened': 'A link was opened in this computer’s browser',
};

/**
 * The devices whose PAIRING a list of records shows: what the Security panel may mark as seen.
 *
 * Only a successful `device.paired` names a device that was paired, so only those count — a device
 * that merely appears as the actor of some other record has not had its pairing shown to anybody.
 */
export function pairedDevicesShown(records: readonly AuditRecord[]): readonly string[] {
  return records
    .filter(record => record.event === 'device.paired' && record.outcome === 'succeeded')
    .flatMap(record => (record.subject === undefined ? [] : [record.subject]));
}

export const SECURITY_LOG_EMPTY = 'Nothing has happened yet.';

/**
 * Who did it, as a person would say it.
 *
 * A DEVICE'S NAME IS A LABEL SOMEBODY CHOSE, so it is never shown bare: it is marked as a device,
 * quoted, and followed by the short id the device list shows. A phone that paired as "this computer"
 * must not read as the machine itself — the daemon refuses the reserved phrases at redemption, and
 * this is the second wall, for a name that predates that rule or merely resembles one.
 */
export function auditActorWords(actor: AuditActor): string {
  if (actor.kind === 'host') return 'this computer';
  if (actor.kind === 'warden') return 'a supervising agent';
  // Somebody presenting a pairing code from a device that is not paired: only ever on a refusal.
  if (actor.kind === 'anonymous') return 'someone who is not paired';
  const id = actor.deviceId === undefined ? '' : ` (${auditShortId(actor.deviceId)})`;
  if (actor.deviceName !== undefined) return `device “${actor.deviceName}”${id}`;
  return actor.deviceId === undefined ? 'a paired device' : `device ${auditShortId(actor.deviceId)}`;
}

/** A paired device as the notice names it: the quoted label beside the short id nobody chose. */
export function deviceLabel(device: PairedDevice): string {
  return `“${device.name}” (${auditShortId(device.id)})`;
}

/**
 * A record's short facts as words: the carrier, how many times, which action. Sorted by key so the
 * same record always reads the same way; empty when there are none.
 */
export function auditDetailWords(record: AuditRecord): string {
  const detail = record.detail ?? {};
  return Object.keys(detail)
    .toSorted()
    .map(key => `${key}: ${String(detail[key])}`)
    .join(' · ');
}

/** The quiet badge a refused or failed record carries; a record that worked carries none. */
export function auditOutcomeBadge(outcome: AuditOutcome): string | null {
  if (outcome === 'refused') return 'Refused';
  if (outcome === 'failed') return 'Failed';
  return null;
}

/**
 * The warning a damaged log earns. Never optional and never softened: a history with a hole in it
 * that reads as a complete one is worse than no history at all.
 */
export function securityLogGapWarning(unreadable: number): string {
  return unreadable === 1
    ? '1 entry in this log could not be read. The history has gaps.'
    : `${String(unreadable)} entries in this log could not be read. The history has gaps.`;
}

const plural = (count: number, unit: string): string => `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;

/**
 * How long ago an instant was, in words — "just now", "5 minutes ago", "yesterday", "3 days ago".
 *
 * An instant in the future (a clock on the machine running slightly ahead of this one) reads as "just
 * now" rather than as a negative age. An unreadable instant says so instead of guessing.
 */
export function relativeWords(at: string, nowMs: number): string {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((nowMs - instant) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : plural(days, 'day');
}

/** The exact instant, for a title or a tooltip beside the relative phrase. */
export function absoluteWords(at: string): string {
  const instant = new Date(at);
  return Number.isNaN(instant.getTime()) ? at : instant.toLocaleString();
}

/**
 * The devices on the list this browser has not yet seen, newest first.
 *
 * KEYED ON THE SET OF IDS, NOT ON AN INSTANT. An instant compared the daemon's `createdAt` with this
 * browser's clock, so a daemon running behind — or a device paired inside the skew — was never news.
 * Ids are the daemon's own facts: a device is new here exactly when this browser has not seen its id.
 *
 * THIS DEVICE IS NEVER NEWS. The browser reading the list is itself a paired device, and the first
 * thing it would otherwise announce is its own arrival.
 */
export function devicesNotSeen(view: PairedDevicesView, seen: ReadonlySet<string>): readonly PairedDevice[] {
  return view.devices
    .filter(device => device.id !== view.thisDeviceId && !seen.has(device.id))
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

/** How recent a device must be, by the DAEMON's clock, for a first look to announce it anyway. */
export const NEW_DEVICE_FIRST_LOOK_MS = 24 * 60 * 60_000;

/**
 * What a browser that has never looked counts as already seen.
 *
 * Everything but the devices paired within {@link NEW_DEVICE_FIRST_LOOK_MS} of the NEWEST one on the
 * list — the daemon's time, never this browser's, so a skewed clock cannot hide a device a stranger
 * paired an hour before this browser first opened. Announcing every device paired before the notice
 * shipped would teach people to dismiss it unread; a recent one is exactly the news.
 */
export function firstLookSeen(view: PairedDevicesView): ReadonlySet<string> {
  const newest = view.devices.reduce((latest, device) => Math.max(latest, Date.parse(device.createdAt) || 0), 0);
  return new Set(
    view.devices
      .filter(device => !(Date.parse(device.createdAt) > newest - NEW_DEVICE_FIRST_LOOK_MS))
      .map(device => device.id),
  );
}

/** Every device now on the list. */
export function allSeen(view: PairedDevicesView | null): ReadonlySet<string> {
  return new Set((view?.devices ?? []).map(device => device.id));
}

const CARRIER_WORDS: Readonly<Record<'direct' | 'relay', string>> = {
  direct: 'on the local network',
  relay: 'over the relay',
};

/**
 * The notice: the quoted label, the short id, the carrier when the daemon kept it, and the daemon's
 * own instant beside the relative phrase — every fact but the name is one nobody who paired chose.
 */
export function newDeviceNoticeText(device: PairedDevice, machine: string, nowMs: number): string {
  const over = device.pairedOver === undefined ? '' : ` ${CARRIER_WORDS[device.pairedOver]}`;
  return `A device calling itself ${deviceLabel(device)} was paired with ${machine}${over} ${relativeWords(device.createdAt, nowMs)} (${absoluteWords(device.createdAt)}).`;
}

export function removedDeviceText(device: PairedDevice, machine: string): string {
  return `${deviceLabel(device)} was removed. It can no longer reach ${machine}.`;
}
