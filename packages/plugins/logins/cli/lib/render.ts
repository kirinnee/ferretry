import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type {
  LoginBudget,
  LoginBudgetPeriodView,
  LoginDisabled,
  LoginList,
  LoginUsageWindow,
  LoginView,
  ModelCatalogEntryView,
  ModelCatalogRefreshResult,
  ModelCatalogsView,
  ProviderPresetCatalog,
  ProviderPresetView,
} from '../../contract/index.ts';

const HARNESS_LABEL: Record<HarnessKey, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** Two spaces per level, so nested facts read as belonging to the line above. */
const indent = (lines: readonly string[], depth = 1): string[] => lines.map(line => `${'  '.repeat(depth)}${line}`);

/** A list in a sentence, or the word for nothing. */
const listOrNone = (items: readonly string[], none = 'none'): string => (items.length === 0 ? none : items.join(', '));

const usdWords = (amount: number): string => `$${amount.toFixed(2)}`;

const untilWords = (until: string): string => {
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) return until;
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 16).replace('T', ' ')} UTC`;
};

/** "disabled (spend limit reached) until 2026-11-01" for a switch that is off, or nothing when it is on. */
const disabledWords = (disabled: LoginDisabled | undefined): string | undefined => {
  if (disabled === undefined) return undefined;
  const why = disabled.reason === undefined ? '' : ` (${disabled.reason})`;
  const until = disabled.until === undefined ? '' : ` until ${untilWords(disabled.until)}`;
  return `disabled${why}${until}`;
};

const window = (name: string, usage: LoginUsageWindow): string =>
  usage.usedPercent === undefined ? `${name} not measured yet` : `${name} ${Math.round(usage.usedPercent)}% used`;

/** "today $12.40 of $40.00 trigger, $60.00 hard" — one period of a budget. */
function periodWords(name: string, period: LoginBudgetPeriodView): string {
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
function budgetLines(budget: LoginBudget | undefined, binaryName: string): string[] {
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
        ? `Over its hard limit: its ferrets were stopped and nothing new starts on it until ${back}. Move one with \`${binaryName} ferret move <id>\`.`
        : `Over its trigger: nothing new starts on it until ${back}; ferrets already on it keep running.`,
    );
  }
  return lines;
}

/** Where the login lives, in the words the Sign-ins tab uses. */
function whereKept(login: LoginView): string {
  if (login.sharedWithTerminal) return `shared with ${login.harness} in your terminal`;
  if (login.store === 'environment') return 'read from the environment';
  if (login.clonedFrom) return `copied from ${login.clonedFrom}: sign in to use it`;
  return 'kept by Ferretry';
}

/** An environment login's variables, preset and needs: values only where they are plain. */
function environmentLines(login: LoginView): string[] {
  const environment = login.environment;
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

/** One login as a row and the facts under it. */
export function renderLoginRow(login: LoginView, binaryName: string): string[] {
  const who = [login.email, login.label].filter(Boolean).join(' · ');
  const off = disabledWords(login.disabled);
  const head = `${login.id}  ${HARNESS_LABEL[login.harness]}${who ? `  ${who}` : ''}  — ${off ?? login.status.label}`;
  return [
    head,
    ...indent([
      ...(off === undefined ? [] : [`Nothing new starts on it. Turn it back on with \`login enable ${login.id}\`.`]),
      login.status.explanation,
      `Usage: ${window('5-hour', login.usage.fiveHour)} · ${window('weekly', login.usage.weekly)}`,
      ...budgetLines(login.budget, binaryName),
      `Used by: ${listOrNone(login.usedBy, 'no runtime yet')}`,
      `Login: ${whereKept(login)}`,
      ...environmentLines(login),
      ...(login.needsLabel ? ['Another login has the same email: give one a label to tell them apart.'] : []),
    ]),
  ];
}

/** The Sign-ins tab in a terminal. */
export function renderLoginList(list: LoginList, binaryName: string): string {
  if (list.logins.length === 0) {
    return `No logins on ${list.machine} yet. Add one with \`${binaryName} login add claude\` (or codex).`;
  }
  const lines = [`Logins on ${list.machine}:`, ''];
  for (const login of list.logins) lines.push(...renderLoginRow(login, binaryName), '');
  const needsSignIn = list.logins.filter(login => login.status.word === 'needs_sign_in' && login.signIn.available);
  if (needsSignIn.length > 0) {
    lines.push('Needs sign-in:', ...indent(needsSignIn.map(login => `${binaryName} login signin ${login.id}`)));
  }
  return lines.join('\n').trimEnd();
}

/** The harnesses a preset is offered for, Claude Code first. */
const offeredHarnesses = (preset: ProviderPresetView): readonly HarnessKey[] =>
  (['claude-code', 'codex'] as const).filter(harness =>
    preset.halves.some(half => half.harness === harness && half.offered.available),
  );

const SCOPE_WORD: Record<HarnessKey, string> = { 'claude-code': 'Claude', codex: 'Codex' };

/** The scope chip `login presets` shows: "Claude + Codex", "Claude only", "Codex only", or "not offered". */
function presetScopeChip(preset: ProviderPresetView): string {
  const offered = offeredHarnesses(preset);
  if (offered.length === 2) return `${SCOPE_WORD['claude-code']} + ${SCOPE_WORD.codex}`;
  const [only] = offered;
  return only === undefined ? 'not offered' : `${SCOPE_WORD[only]} only`;
}

/** The provider presets, one line each, grouped by tool, with why a hidden one is not offered. */
export function renderPresetList(catalog: ProviderPresetCatalog, binaryName: string): string {
  const lines: string[] = [];
  for (const harness of ['claude-code', 'codex'] as const) {
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

// ── Model catalogs (docs/model-catalog.md) ────────────────────────────────────────────────────────────────

const TIER_WORDS = { best: 'most capable', balanced: 'balanced', fast: 'fast' } as const;

const contextWords = (tokens: number | undefined): string =>
  tokens === undefined
    ? ''
    : tokens >= 1_000_000
      ? ` · ${tokens / 1_000_000}M context`
      : ` · ${Math.round(tokens / 1000)}K context`;

const modelLine = (model: ModelCatalogEntryView): string =>
  `    ${model.default ? '*' : ' '} ${model.id}  ${model.label} (${TIER_WORDS[model.tier]}${contextWords(model.context)}${
    model.efforts.length === 0 ? '' : ` · effort ${model.efforts.join('/')}`
  })`;

/** The published catalog's state in one line. */
function publishedLine(view: ModelCatalogsView): string {
  const published = view.published;
  if (!published.enabled) return `Published catalog: not followed (FY_MODEL_CATALOG=off)`;
  const version = published.version === undefined ? 'none taken yet' : `version ${published.version}`;
  const checked = published.checkedAt === undefined ? 'never checked' : `checked ${published.checkedAt}`;
  return `Published catalog from ${published.origin}: ${version}, ${checked}`;
}

/** `login models list`: each catalog, where it came from, and its models by CLI. `*` marks the default. */
export function renderModelCatalogs(view: ModelCatalogsView): string {
  const lines = [publishedLine(view)];
  for (const catalog of view.catalogs) {
    lines.push(
      '',
      `${catalog.id} — ${catalog.label} (${catalog.origin}, verified ${catalog.verified}${catalog.customIds ? ', takes any id' : ''})`,
    );
    for (const harness of ['claude-code', 'codex'] as const) {
      const models = harness === 'codex' ? catalog.codex : catalog.claude;
      if (models === undefined) continue;
      lines.push(`  ${HARNESS_LABEL[harness]}:`, ...models.map(modelLine));
    }
  }
  return lines.join('\n');
}

const OUTCOME_WORDS: Readonly<Record<ModelCatalogRefreshResult['outcome'], string>> = {
  updated: 'The published model catalog was updated; it is in effect now',
  unchanged: 'The published model catalog has not changed',
  'not-due': 'The model catalog was checked recently',
  unreachable: 'The published model catalog could not be reached; the one held stays in effect',
  refused: 'The published model catalog did not check; the one held stays in effect',
  disabled: 'This daemon follows no published model catalog (FY_MODEL_CATALOG=off)',
};

/** `login models refresh`: what the check came to, in one sentence. */
export function renderModelRefresh(result: ModelCatalogRefreshResult): string {
  const version = result.version === undefined ? '' : ` (version ${result.version})`;
  const reason = result.reason === undefined ? '' : `: ${result.reason}`;
  return `${OUTCOME_WORDS[result.outcome]}${version}${reason}.`;
}
