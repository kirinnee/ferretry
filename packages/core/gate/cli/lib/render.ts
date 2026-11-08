import {
  type AuditActor,
  type AuditKindName,
  type AuditView,
  auditShortId,
  isSecuritySwitch,
  SECURITY_SETTING_BOUNDS,
  SECURITY_SETTING_FIELDS,
  type SecuritySettingField,
  type SecuritySettings,
  type SecuritySettingsView,
} from '../../contract/index.ts';

/**
 * What `fy daemon audit` and `fy daemon security` print (today's `cli/src/lib/audit/render.ts` and
 * `security/render.ts`, copied; event names follow §1: `input.hold-*`, `ferret.credential-*`).
 */

type AuditRecordView = AuditView['records'][number];

/** What each core kind is called to a person. A plugin's own kind is shown by its name. */
const EVENT_WORDS: Readonly<Record<AuditKindName, string>> = {
  'device.paired': 'A device was paired',
  'device.revoked': 'A device was removed',
  'device.expired': 'A device’s access expired',
  'device.key-rotated': 'A device’s key was replaced',
  'pairing.code-minted': 'A pairing code was made',
  'pairing.code-revoked': 'A pairing code was withdrawn',
  'pairing.refused': 'A pairing attempt was refused',
  'session.opened': 'An agent session was started',
  'step-up.succeeded': 'Passkey confirmation passed',
  'step-up.failed': 'Passkey confirmation failed',
  'passkey.registered': 'A passkey was added',
  'terminal.opened': 'A terminal was opened',
  'terminal.closed': 'A finished ferret’s terminals were closed',
  'terminal.input': 'Keystrokes reached a terminal',
  'fleet.configured': 'Agent settings were changed',
  'grants.changed': 'Remote permissions were changed',
  'secrets.used': 'A secret was used',
  'secrets.changed': 'A secret was stored or deleted',
  'catalog.changed': 'A catalog this machine publishes was changed',
  'catalog.exported': 'A catalog was exported as a signed file',
  'catalog.share.minted': 'A catalog share code was made',
  'catalog.share.ended': 'A catalog share code was ended',
  'catalog.member.joined': 'A browser joined and can now read shared catalogs',
  'catalog.member.passkey-added': 'A person who reads shared catalogs added a passkey',
  'catalog.member.unlocked': 'A person who reads shared catalogs unlocked with a passkey',
  'catalog.member.join-refused': 'A share code was turned away',
  'catalog.member.join-proved': 'A new browser joined a person after one of their passkeys proved it',
  'catalog.member.join-proof-refused': "A browser was turned away because it could not prove the person's passkey",
  'catalog.member.new-passkey-used': 'A browser joined a person on an invite approved for a new passkey',
  'catalog.share.new-passkey-marked': 'An invite was approved to let a person set up a new passkey',
  'catalog.share.new-passkey-cleared': 'The approval for a new passkey was taken off an invite',
  'catalog.member.revoked': 'A person who reads shared catalogs was removed',
  'catalog.member.key-removed': 'One browser of a person who reads shared catalogs was removed',
  'catalog.member.catalog-removed': 'A shared catalog was taken away from a person',
  'catalog.member.renamed': 'A person who reads shared catalogs was given a different name',
  'catalog.share.cross-member': "A share code made for one person was used by another person's browser",
  'catalog.link.minted': 'A download link was made',
  'catalog.link.copied': 'A download link was copied',
  'catalog.link.ended': 'A download link was turned off',
  'catalog.link.moved': 'A download link was moved to another version',
  'catalog.link.changed': "A download link's end or limit was changed",
  'catalog.link.revived': 'A download link was put back after the link store let it lapse',
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
  'input.rebound': 'A page or terminal changed under a request for a value, and the request was redrawn',
  'input.expired': 'A request for a value ran out of time',
  'input.cancelled': 'A request for a value was cancelled',
  'input.hold-ended': 'A terminal that a ferret was kept out of was opened up again',
  'input.hold-revealed': 'A viewer chose to see a terminal a ferret was kept out of',
  'link.opened': 'A link was opened in this computer’s browser',
  'ferret.credential-refused': "A ferret's own token was refused",
  'ferret.credential-revoked': "A ferret's token was revoked",
  'phone-approval.raised': 'A ferret asked you to approve a sign-in on your phone',
  'phone-approval.refused': 'A sign-in to approve on your phone was refused: "Not me"',
  'phone-approval.settled': 'A sign-in to approve on your phone ended',
};

const eventWords = (event: string): string => (EVENT_WORDS as Readonly<Record<string, string>>)[event] ?? event;

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local wall-clock time, to the second. */
function localTime(at: string): string {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Who did it, in words. A device's name is untrusted text: quoted, marked as a device, with a short id. */
export function describeActor(actor: AuditActor): string {
  if (actor.kind === 'host') return 'this computer';
  if (actor.kind === 'warden') return 'a supervising agent';
  if (actor.kind === 'anonymous') return 'someone who is not paired';
  const id = actor.deviceId === undefined ? '' : ` (${auditShortId(actor.deviceId)})`;
  if (actor.deviceName !== undefined) return `device “${actor.deviceName}”${id}`;
  return actor.deviceId === undefined ? 'a paired device' : `device ${auditShortId(actor.deviceId)}`;
}

function describeDetail(record: AuditRecordView): string {
  if (record.detail === undefined) return '';
  const pairs = Object.keys(record.detail)
    .sort()
    .map(key => `${key}=${String(record.detail?.[key])}`);
  return pairs.length === 0 ? '' : `  [${pairs.join(' ')}]`;
}

function renderAuditRecord(record: AuditRecordView): string {
  const subject = record.subject === undefined ? '' : ` (${record.subject})`;
  return `${localTime(record.at)}  ${eventWords(record.event)}${subject}  by ${describeActor(record.actor)}  ${record.outcome}${describeDetail(record)}`;
}

/** The audit, newest first: security changes first (never crowded out), activity after, damage at the end. */
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

/** One setting's value as a person types it back: `on`/`off` for a switch, the number otherwise. */
function formatSettingValue(field: SecuritySettingField, settings: SecuritySettings): string {
  if (isSecuritySwitch(field)) return settings[field] ? 'on' : 'off';
  return String(settings[field]);
}

function boundsOf(field: SecuritySettingField): string {
  if (isSecuritySwitch(field)) return 'on | off';
  const { min, max } = SECURITY_SETTING_BOUNDS[field];
  return `${String(min)}-${String(max)}`;
}

/** The settings report: each value, its bounds, and where the document came from. Damage is said out loud. */
export function renderSecurity(view: SecuritySettingsView, clientName: string): string {
  const nameWidth = Math.max(...SECURITY_SETTING_FIELDS.map(field => field.length));
  const valueWidth = Math.max(...SECURITY_SETTING_FIELDS.map(field => formatSettingValue(field, view.settings).length));
  const lines = SECURITY_SETTING_FIELDS.map(
    field =>
      `${field.padEnd(nameWidth)}  ${formatSettingValue(field, view.settings).padEnd(valueWidth)}  (${boundsOf(field)})`,
  );
  const origin: Record<SecuritySettingsView['source'], string> = {
    document: 'source: gate.yaml',
    defaults: 'source: defaults (nothing has been changed on this machine)',
    damaged: 'source: DAMAGED — gate.yaml could not be read, so the narrowest reading is in force; fix or remove it',
  };
  return [
    ...lines,
    '',
    origin[view.source],
    ...(view.updatedAt === undefined ? [] : [`updated: ${view.updatedAt}`]),
    '',
    `change one with \`${clientName} daemon security set <field> <value>\``,
  ].join('\n');
}

/** What a change reports: the new value, and the devices a shortened idle period will unpair. */
export function renderSecurityChange(
  field: SecuritySettingField,
  change: { readonly view: SecuritySettingsView; readonly devicesExpiring: number },
): string {
  const lines = [`${field} = ${formatSettingValue(field, change.view.settings)}`];
  if (change.devicesExpiring > 0)
    lines.push(`${String(change.devicesExpiring)} paired device(s) will be unpaired at the next check`);
  return lines.join('\n');
}

/** The grant view and history as the CLI reads them (`GET /v1/grants`, `GET /v1/grants/audit`). */
export interface GrantsReport {
  readonly capabilities: readonly {
    readonly capability: string;
    readonly configure: boolean;
    readonly granted: { readonly use: boolean; readonly configure: boolean };
    readonly configureRefusal: string;
    readonly origin: string;
  }[];
}
export interface GrantHistoryReport {
  readonly entries: readonly { readonly at: string; readonly actor: string; readonly changes: readonly string[] }[];
  readonly unreadable: number;
  readonly truncated: boolean;
}

const AXES = ['use', 'configure'] as const;

/** The one sentence every step-up refusal is explained with, wherever it is shown. */
const STEP_UP_NOTE = 'needs a passkey confirmation from a paired device';

/** The grant report, with the ORIGIN column, and who the rows apply to said once at the top (today's `renderGrants`). */
export function renderGrants(view: GrantsReport, clientName: string): string {
  const nameWidth = Math.max(...view.capabilities.map(entry => entry.capability.length));
  return [
    'These apply to callers that are NOT on this host. This command line is ungoverned.',
    '',
    ...view.capabilities.map(entry => {
      const axes = AXES.map(axis => `${axis}=${entry.granted[axis] ? 'on ' : 'off'}`).join('  ');
      const effective =
        entry.granted.configure && !entry.configure
          ? `  (configure ${entry.configureRefusal === 'step-up-required' ? STEP_UP_NOTE : entry.configureRefusal} right now)`
          : '';
      return `${entry.capability.padEnd(nameWidth)}  ${axes}  (${entry.origin})${effective}`;
    }),
    '',
    `change one with \`${clientName} daemon config set <capability> --use|--no-use --configure|--no-configure\``,
  ].join('\n');
}

/** What a change reports about itself, with the restart answer stated at the moment of the change. */
export function renderGrantChange(changed: readonly string[], clientName: string): string {
  if (changed.length === 0) return 'nothing changed; those grants already read that way';
  return [
    `${changed.join(', ')} — in effect now, no restart needed.`,
    `(Editing <FY_HOME>/config/gate.yaml by hand is also read live; \`${clientName} daemon config\` shows what is in effect.)`,
  ].join('\n');
}

/** Which axes one change actually moved, so the report never claims more than it did. */
export function grantDifference(before: GrantsReport, after: GrantsReport): readonly string[] {
  const changed: string[] = [];
  for (const entry of after.capabilities) {
    const previous = before.capabilities.find(candidate => candidate.capability === entry.capability);
    if (previous === undefined) continue;
    for (const axis of AXES)
      if (previous.granted[axis] !== entry.granted[axis])
        changed.push(`${entry.capability}.${axis}=${entry.granted[axis] ? 'on' : 'off'}`);
  }
  return changed;
}

/** Who changed what, most recent first; damage is reported rather than a shorter history. */
export function renderGrantHistory(view: GrantHistoryReport): string {
  const lines: string[] = [];
  if (view.entries.length === 0) lines.push('no grant has been changed on this machine');
  else {
    const actorWidth = Math.max(...view.entries.map(entry => entry.actor.length));
    for (const entry of view.entries)
      lines.push(`${entry.at}  ${entry.actor.padEnd(actorWidth)}  ${entry.changes.join(', ')}`);
  }
  if (view.truncated) lines.push('', 'older records exist; this is the tail of the journal');
  if (view.unreadable > 0)
    lines.push(
      '',
      `! ${String(view.unreadable)} line${view.unreadable === 1 ? '' : 's'} in this window could not be read as a record — this history is incomplete`,
    );
  return lines.join('\n');
}
