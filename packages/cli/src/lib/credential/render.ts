import type {
  FleetBudgetPeriodView,
  FleetCredentialBudget,
  FleetCredentialList,
  FleetCredentialUsageWindow,
  FleetCredentialView,
  FleetProviderPresetCatalog,
} from '@ferretry/protocol';
import { usdWords } from '@ferretry/fleet';
import { disabledWords, HARNESS_LABEL, indent, listOrNone } from '../fleet/account-render.ts';
import { presetScopeChip } from './provider-match.ts';

const window = (name: string, usage: FleetCredentialUsageWindow): string =>
  usage.usedPercent === undefined ? `${name} not measured yet` : `${name} ${Math.round(usage.usedPercent)}% used`;

/** "today $12.40 of $40.00 trigger, $60.00 hard" — one period of a budget. */
function periodWords(name: string, period: FleetBudgetPeriodView): string {
  const limits = [
    ...(period.trigger === undefined ? [] : [`${usdWords(period.trigger)} trigger`]),
    ...(period.hard === undefined ? [] : [`${usdWords(period.hard)} hard`]),
  ].join(', ');
  return `${name} ${usdWords(period.spentUsd)} of ${limits}`;
}

/** A reset instant in the budget's own zone: `Sat 00:00`. */
const resetWords = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(Date.parse(instant));

/** The budget lines under a login (docs/budgets.md): spent on THIS machine against its limits, and what holds it. */
function budgetLines(budget: FleetCredentialBudget | undefined, binaryName: string): string[] {
  if (budget === undefined) return [];
  const periods = [
    ...(budget.daily === undefined ? [] : [periodWords('today', budget.daily)]),
    ...(budget.weekly === undefined ? [] : [periodWords('this week', budget.weekly)]),
  ];
  const zone = `${budget.timeZone}${budget.timeZoneSet ? '' : ', the host’s zone'}`;
  const lines = [`Budget, spent on this machine only (${zone}): ${periods.join(' · ')}`];
  if (!budget.measured) lines.push('Not measured yet: the first count since the daemon started is still running.');
  if (budget.partial === true)
    lines.push('Partial: a transcript is too large to read back to the start of the period, so the amount may be low.');
  if (budget.unpriced > 0)
    lines.push(`${String(budget.unpriced)} request(s) used a model with no price and are not in these amounts.`);
  const held = (['weekly', 'daily'] as const)
    .map(name => budget[name])
    .find(period => period !== undefined && period.level === budget.level);
  if (budget.level !== 'ok' && held !== undefined) {
    const back = resetWords(held.resetsAt, budget.timeZone);
    lines.push(
      budget.level === 'over_hard'
        ? `Over its hard limit: its ferrets were stopped and nothing new starts on it until ${back}. Move one with \`${binaryName} migrate <id> -a <runtime>\`.`
        : `Over its trigger: nothing new starts on it until ${back}; ferrets already on it keep running.`,
    );
  }
  return lines;
}

/** Where the login lives, in the words the Credentials tab uses. */
function whereKept(credential: FleetCredentialView): string {
  if (credential.sharedWithTerminal) return `shared with ${credential.harness} in your terminal`;
  if (credential.store === 'environment') return 'read from the environment';
  if (credential.clonedFrom) return `copied from ${credential.clonedFrom}: sign in to use it`;
  return 'kept by Ferretry';
}

/** One login as a row and the facts under it. */
export function renderCredentialRow(credential: FleetCredentialView, binaryName: string): string[] {
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
      ...budgetLines(credential.budget, binaryName),
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
  for (const credential of list.credentials) lines.push(...renderCredentialRow(credential, binaryName), '');
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
