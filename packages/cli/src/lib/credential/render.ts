import type { FleetCredentialList, FleetCredentialUsageWindow, FleetCredentialView } from '@ferretry/protocol';
import { HARNESS_LABEL, indent, listOrNone } from '../fleet/account-render.ts';

const window = (name: string, usage: FleetCredentialUsageWindow): string =>
  usage.usedPercent === undefined ? `${name} not measured yet` : `${name} ${Math.round(usage.usedPercent)}% used`;

/** Where the login lives, in the words the Credentials tab uses. */
function whereKept(credential: FleetCredentialView): string {
  if (credential.sharedWithTerminal) return `shared with ${credential.harness} in your terminal`;
  if (credential.store === 'environment') return 'read from the environment';
  if (credential.clonedFrom) return `copied from ${credential.clonedFrom}: sign in to use it`;
  return 'kept by Ferretry';
}

/** One login as a row and the facts under it. */
export function renderCredentialRow(credential: FleetCredentialView): string[] {
  const who = [credential.email, credential.label].filter(Boolean).join(' · ');
  const head = `${credential.id}  ${HARNESS_LABEL[credential.harness]}${who ? `  ${who}` : ''}  — ${credential.status.label}`;
  return [
    head,
    ...indent([
      credential.status.explanation,
      `Usage: ${window('5-hour', credential.usage.fiveHour)} · ${window('weekly', credential.usage.weekly)}`,
      `Used by: ${listOrNone(credential.usedBy, 'no runtime yet')}`,
      `Login: ${whereKept(credential)}`,
      ...(credential.needsLabel ? ['Another login has the same email: give one a label to tell them apart.'] : []),
    ]),
  ];
}

/** The Credentials tab in a terminal. */
export function renderCredentialList(list: FleetCredentialList, binaryName: string): string {
  if (list.credentials.length === 0) {
    return `No logins on ${list.machine} yet. Add one with \`${binaryName} credential add claude\` (or codex).`;
  }
  const lines = [`Logins on ${list.machine}:`, ''];
  for (const credential of list.credentials) lines.push(...renderCredentialRow(credential), '');
  const needsSignIn = list.credentials.filter(
    credential => credential.status.word === 'needs_sign_in' && credential.signIn.available,
  );
  if (needsSignIn.length > 0) {
    lines.push(
      'Needs sign-in:',
      ...indent(needsSignIn.map(credential => `${binaryName} credential signin ${credential.id}`)),
    );
  }
  return lines.join('\n').trimEnd();
}
