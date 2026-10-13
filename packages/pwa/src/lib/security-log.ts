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

import type { AuditActor, AuditEvent, AuditOutcome, PairedDevice, PairedDevicesView } from '@ferretry/protocol';

/** Every event the log can hold, as a sentence. Closed over the wire's own list, so a new kind fails typecheck here. */
export const AUDIT_EVENT_WORDS: Readonly<Record<AuditEvent, string>> = {
  'device.paired': 'A device was paired',
  'device.revoked': 'A device was removed',
  'device.expired': 'A device’s access expired',
  'pairing.code-minted': 'A pairing code was made',
  'pairing.refused': 'A pairing attempt was refused',
  'session.opened': 'A device connected',
  'step-up.succeeded': 'Password confirmed',
  'step-up.failed': 'Password confirmation failed',
  'passkey.registered': 'A passkey was added',
  'terminal.opened': 'A terminal was opened',
  'fleet.configured': 'Agent settings were changed',
  'grants.changed': 'Remote permissions were changed',
  'secrets.used': 'A secret was used',
};

export const SECURITY_LOG_EMPTY = 'Nothing has happened yet.';

/**
 * Who did it, as a person would say it.
 *
 * A device's name is the one its owner chose, so it is shown as text and nothing else. A record that
 * names a device without its name falls back to a description rather than to an id nobody recognises.
 */
export function auditActorWords(actor: AuditActor): string {
  if (actor.kind === 'host') return 'this computer';
  if (actor.kind === 'warden') return 'a supervising agent';
  // Somebody presenting a pairing code from a device that is not paired: only ever on a refusal.
  if (actor.kind === 'anonymous') return 'someone who is not paired';
  return actor.deviceName ?? 'a paired device';
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
 * The devices paired since this browser last looked, newest first.
 *
 * THIS DEVICE IS NEVER NEWS. The browser reading the list is itself a paired device, and the first
 * thing it would otherwise announce is its own arrival.
 */
export function devicesPairedSince(view: PairedDevicesView, lookedMs: number): readonly PairedDevice[] {
  return view.devices
    .filter(device => device.id !== view.thisDeviceId && Date.parse(device.createdAt) > lookedMs)
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

/**
 * The instant to remember as "looked", given what is on screen.
 *
 * Never earlier than now, and never earlier than the newest device shown: the machine's clock is not
 * this browser's, so a device stamped a few seconds ahead of "now" must not come straight back.
 */
export function lookedInstant(view: PairedDevicesView | null, nowMs: number): number {
  const newest = (view?.devices ?? []).reduce(
    (latest, device) => Math.max(latest, Date.parse(device.createdAt) || 0),
    0,
  );
  return Math.max(nowMs, newest);
}

export function newDeviceNoticeText(device: PairedDevice, machine: string, nowMs: number): string {
  return `A new device, ${device.name}, was paired with ${machine} ${relativeWords(device.createdAt, nowMs)}.`;
}

export function removedDeviceText(device: PairedDevice, machine: string): string {
  return `${device.name} was removed. It can no longer reach ${machine}.`;
}
