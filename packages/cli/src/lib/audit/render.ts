import { type AuditActor, type AuditEvent, type AuditRecord, type AuditView, auditShortId } from '@ferretry/protocol';

/** What each kind of event is called to a person. Keyed by the closed event list, so a new kind cannot be missed. */
const EVENT_WORDS: Readonly<Record<AuditEvent, string>> = {
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

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local wall-clock time, to the second: the reader is asking "what happened while I was out". */
export function localTime(at: string): string {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Who did it, in words.
 *
 * A DEVICE'S NAME IS UNTRUSTED TEXT ITS OWNER TYPED, so it is never said in the slot the fixed actors
 * use: it is marked as a device, quoted, and followed by a short id. A phone named "this computer"
 * therefore reads `device “this computer” (…a1b2c3)` and never as the machine's owner. (Pairing also
 * refuses those exact names; this is the layer that holds when a record predates the refusal.)
 */
export function describeActor(actor: AuditActor): string {
  if (actor.kind === 'host') return 'this computer';
  if (actor.kind === 'warden') return 'a supervising agent';
  if (actor.kind === 'anonymous') return 'someone who is not paired';
  const id = actor.deviceId === undefined ? '' : ` (${auditShortId(actor.deviceId)})`;
  if (actor.deviceName !== undefined) return `device “${actor.deviceName}”${id}`;
  return actor.deviceId === undefined ? 'a paired device' : `device ${auditShortId(actor.deviceId)}`;
}

/** The record's short facts as `key=value` pairs, in a stable order: the carrier, a count, a mode. */
function describeDetail(record: AuditRecord): string {
  if (record.detail === undefined) return '';
  const pairs = Object.keys(record.detail)
    .sort()
    .map(key => `${key}=${String(record.detail?.[key])}`);
  return pairs.length === 0 ? '' : `  [${pairs.join(' ')}]`;
}

/** One record as one line: time, what happened, who, outcome, and the short facts behind it. */
export function renderAuditRecord(record: AuditRecord): string {
  const subject = record.subject === undefined ? '' : ` (${record.subject})`;
  return `${localTime(record.at)}  ${EVENT_WORDS[record.event]}${subject}  by ${describeActor(record.actor)}  ${record.outcome}${describeDetail(record)}`;
}

/**
 * The security log, newest first, in two sections.
 *
 * SECURITY CHANGES COME FIRST AND ARE NEVER CROWDED OUT. Pairings, removals and permission changes are
 * the daemon's `kept` list, read apart from the activity, so however much activity a device produces
 * the changes are still on the page. When there are more than one page holds, the heading says how
 * many and the flag that shows the older ones.
 *
 * DAMAGE IS SAID LOUDLY AT THE END, where the eye lands last. A line the daemon could not read is a
 * hole in the history, and a shorter listing that said nothing would read as a clean one.
 */
export function renderAudit(view: AuditView, keptOffset = 0): string {
  if (view.records.length === 0 && view.keptTotal === 0)
    return withGaps(['no security events have been recorded'], view);
  const shownTo = keptOffset + view.kept.length;
  const lines: string[] = [
    view.kept.length === view.keptTotal
      ? 'Security changes — who may reach this machine (all of them):'
      : `Security changes — who may reach this machine (${String(keptOffset + 1)}–${String(shownTo)} of ${String(view.keptTotal)}):`,
    ...(view.kept.length === 0 ? ['  none on this page'] : view.kept.map(record => `  ${renderAuditRecord(record)}`)),
  ];
  if (shownTo < view.keptTotal)
    lines.push(`  … ${String(view.keptTotal - shownTo)} older — run with --kept-skip ${String(shownTo)} to see them`);
  lines.push(
    '',
    'Recent activity:',
    ...(view.records.length === 0 ? ['  none'] : view.records.map(record => `  ${renderAuditRecord(record)}`)),
  );
  return withGaps(lines, view);
}

function withGaps(lines: string[], view: AuditView): string {
  if (view.unreadable > 0)
    lines.push(
      '',
      `! ${String(view.unreadable)} line${view.unreadable === 1 ? '' : 's'} of the log could not be read — the history has gaps`,
    );
  return lines.join('\n');
}
