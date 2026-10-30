import type {
  FleetCredentialList,
  FleetCredentialUsageWindow,
  FleetCredentialView,
  FleetProviderPresetCatalog,
} from '@ferretry/protocol';
import { disabledWords, HARNESS_LABEL, indent, listOrNone } from '../fleet/account-render.ts';
import { presetScopeChip } from './provider-match.ts';

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
  const off = disabledWords(credential.disabled);
  const head = `${credential.id}  ${HARNESS_LABEL[credential.harness]}${who ? `  ${who}` : ''}  — ${off ?? credential.status.label}`;
  return [
    head,
    ...indent([
      ...(off === undefined
        ? []
        : [`Nothing new starts on it. Turn it back on with \`login enable ${credential.id}\`.`]),
      credential.status.explanation,
      `Usage: ${window('5-hour', credential.usage.fiveHour)} · ${window('weekly', credential.usage.weekly)}`,
      `Used by: ${listOrNone(credential.usedBy, 'no runtime yet')}`,
      `Login: ${whereKept(credential)}`,
      ...environmentLines(credential),
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

/** The provider presets, one line each, grouped by tool, with why a hidden one is not offered. */
export function renderPresetList(catalog: FleetProviderPresetCatalog, binaryName: string): string {
  const lines: string[] = [];
  for (const harness of ['claude', 'codex'] as const) {
    const presets = catalog.presets.filter(preset => preset.harness === harness);
    if (presets.length === 0) continue;
    lines.push(`${HARNESS_LABEL[harness]}:`);
    for (const preset of presets) {
      const test = preset.test.available
        ? `test: ${preset.test.spends === 'nothing' ? 'free' : 'one token'}`
        : 'no test';
      lines.push(
        ...indent([
          `${preset.id}  ${preset.label}  (${presetScopeChip(preset)})  — ${test}, quota: ${preset.quota.source}`,
          ...(preset.offered.available ? [] : indent([`Not offered: ${preset.offered.reason}`])),
        ]),
      );
    }
    lines.push('');
  }
  lines.push(`Add one: ${binaryName} login add claude --preset <id> --env NAME=VALUE`);
  return lines.join('\n');
}

/** An environment login's variables, preset and needs: values only where they are plain. */
function environmentLines(credential: FleetCredentialView): string[] {
  const environment = credential.environment;
  if (environment === undefined) return [];
  return [
    ...(environment.preset === undefined ? [] : [`Preset: ${environment.preset.label}`]),
    ...environment.variables.map(variable => {
      if (variable.kind === 'plain') return `${variable.name}=${variable.value}`;
      if (variable.kind === 'hidden') return `${variable.name}=(hidden)`;
      return `${variable.name}=\${secret:${variable.secrets.join('}, ${secret:')}}${variable.set ? ' (set)' : ' (not set)'}`;
    }),
    ...(environment.cloudCredential === undefined ? [] : [environment.cloudCredential.sentence]),
    ...(environment.missingSecrets.length === 0 ? [] : [`Needs: ${environment.missingSecrets.join(', ')}`]),
  ];
}
