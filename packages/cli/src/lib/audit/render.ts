import type { AuditActor, AuditEvent, AuditRecord, AuditView } from '@ferretry/protocol';

/** What each kind of event is called to a person. Keyed by the closed event list, so a new kind cannot be missed. */
const EVENT_WORDS: Readonly<Record<AuditEvent, string>> = {
  'device.paired': 'A device was paired',
  'device.revoked': 'A device was removed',
  'device.expired': 'A device’s access expired',
  'pairing.code-minted': 'A pairing code was made',
  'pairing.refused': 'A pairing attempt was refused',
  'session.opened': 'A device connected',
  'step-up.succeeded': 'Password confirmation passed',
  'step-up.failed': 'Password confirmation failed',
  'passkey.registered': 'A passkey was added',
  'terminal.opened': 'A terminal was opened',
  'fleet.configured': 'Agent settings were changed',
  'grants.changed': 'Remote permissions were changed',
  'secrets.used': 'A secret was used',
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local wall-clock time, to the second: the reader is asking "what happened while I was out". */
export function localTime(at: string): string {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Who did it, in words. A device is named by the name its owner gave it, falling back to its id. */
export function describeActor(actor: AuditActor): string {
  if (actor.kind === 'host') return 'this computer';
  if (actor.kind === 'warden') return 'a supervising agent';
  if (actor.kind === 'anonymous') return 'someone who is not paired';
  return actor.deviceName ?? actor.deviceId ?? 'a paired device';
}

/** One record as one line: time, what happened, who, outcome. */
export function renderAuditRecord(record: AuditRecord): string {
  const subject = record.subject === undefined ? '' : ` (${record.subject})`;
  return `${localTime(record.at)}  ${EVENT_WORDS[record.event]}${subject}  by ${describeActor(record.actor)}  ${record.outcome}`;
}

/**
 * The security log, newest first.
 *
 * DAMAGE IS SAID LOUDLY AT THE END, where the eye lands last. A line the daemon could not read is a
 * hole in the history, and a shorter listing that said nothing would read as a clean one.
 */
export function renderAudit(view: AuditView): string {
  const lines: string[] =
    view.records.length === 0 ? ['no security events have been recorded'] : view.records.map(renderAuditRecord);
  if (view.unreadable > 0)
    lines.push(
      '',
      `! ${String(view.unreadable)} line${view.unreadable === 1 ? '' : 's'} of the log could not be read — the history has gaps`,
    );
  return lines.join('\n');
}
