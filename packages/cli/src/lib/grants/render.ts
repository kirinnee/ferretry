import { CAPABILITY_AXES, type GrantAuditView, type GrantsView } from '@ferretry/protocol';

/**
 * What a person is told, once, when this machine has no operator password.
 *
 * ONE SENTENCE, where the decision is actually visible. Not a modal, not repeated, and never a question
 * somebody has to answer to use their own command line — the admin token is governed by none of this.
 * It appears here because this report is where remote access is inspected.
 */
export const NO_PASSWORD_NOTE =
  'no operator password is set, so any paired device can change this machine’s fleet and settings without one';

/**
 * The grant report, with the ORIGIN column that is the whole point of it.
 *
 * `fyd --print-config` established the precedent and the reason: a person reading this is usually
 * asking why something is refused, and "which of these did I choose and which did something choose
 * for me" is the actual question. Values without origins answer the wrong one.
 *
 * IT SAYS WHO THE ROWS APPLY TO, once, at the top. The commonest wrong reading would be to see
 * `configure off` and conclude your own command line is blocked — loopback is ungoverned, and a
 * report that left that implicit would send somebody hunting a permission problem they do not have.
 */
export function renderGrants(view: GrantsView, clientName: string): string {
  const nameWidth = Math.max(...view.capabilities.map(entry => entry.capability.length));
  const lines = [
    'These apply to callers that are NOT on this host. This command line is ungoverned; a browser on this',
    'machine is governed until it enters the operator password once.',
    '',
    ...view.capabilities.map(entry => {
      const axes = CAPABILITY_AXES.map(axis => `${axis}=${entry.granted[axis] ? 'on ' : 'off'}`).join('  ');
      // The EFFECTIVE answer is stated only where it differs from the recorded one, because that gap
      // is the interesting fact: the operator said yes and something else is still refusing.
      const effective =
        entry.granted.configure && !entry.configure ? `  (configure ${entry.configureRefusal} right now)` : '';
      return `${entry.capability.padEnd(nameWidth)}  ${axes}  (${entry.origin})${effective}`;
    }),
    '',
    view.passwordSet
      ? 'an operator password is set, so changing any of these from off this host needs it'
      : NO_PASSWORD_NOTE,
    ...(view.lockedUntil === undefined
      ? []
      : [`too many wrong passwords: this daemon resumes checking at ${view.lockedUntil}`]),
    '',
    `change one with \`${clientName} daemon config set <capability> --use|--no-use --configure|--no-configure\``,
  ];
  return lines.join('\n');
}

/**
 * What a change reports about itself.
 *
 * IT STATES THE RESTART ANSWER AT THE MOMENT OF THE CHANGE, rather than leaving it to documentation
 * nobody reads at the moment they need it. A grant written through the daemon takes effect on the
 * very next request, because the daemon moves its in-memory answer in the same call — the case that
 * DOES need a restart is a document edited by hand behind the daemon's back, and that is worth
 * saying here precisely because it is the tempting alternative to this command.
 */
export function renderGrantChange(changed: readonly string[], clientName: string): string {
  if (changed.length === 0) return 'nothing changed; those grants already read that way';
  return [
    `${changed.join(', ')} — in effect now, no restart needed.`,
    `(Editing <FY_HOME>/config/daemon.json by hand instead would need \`${clientName} daemon restart\`.)`,
  ].join('\n');
}

/** Which axes one change actually moved, so the report never claims more than it did. */
export function grantDifference(before: GrantsView, after: GrantsView): readonly string[] {
  const changed: string[] = [];
  for (const entry of after.capabilities) {
    const previous = before.capabilities.find(candidate => candidate.capability === entry.capability);
    if (previous === undefined) continue;
    for (const axis of CAPABILITY_AXES) {
      if (previous.granted[axis] !== entry.granted[axis])
        changed.push(`${entry.capability}.${axis}=${entry.granted[axis] ? 'on' : 'off'}`);
    }
  }
  return changed;
}

/**
 * Who changed what, most recent first.
 *
 * IT REPORTS DAMAGE RATHER THAN A SHORTER HISTORY. A journal line the daemon could not read is
 * counted and said out loud: silently omitting it would let a truncated or tampered record read as a
 * clean one, and a permission history that quietly loses entries is worse than none, because people
 * trust it.
 */
export function renderGrantHistory(view: GrantAuditView): string {
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
