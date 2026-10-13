/**
 * The first run and Import again, as data (docs/design/account-model.md §4.3, E1–E11).
 *
 * Five steps, one decision each: **Check tools** → **Claude Code** → **Codex** → **Name runtimes** →
 * **Done**. Import again (Settings → Setup) is the same flow without the first step. A machine whose
 * import offers updates (a source file changed since the last import, O6) gets one more step,
 * **What changed**, where every update is offered and none is ticked.
 *
 * The import is ONE reviewed change (`setup.import`), sent from the last step before Done with every
 * answer the person gave on the way. Nothing is imported by choosing "Import" on a harness step: that
 * is an answer, and Back can still change it.
 *
 * Pure: a scan and the person's answers in, the steps, the rows and the change out.
 */

import type {
  FleetAccountChange,
  FleetHarnessScan,
  FleetHostLogin,
  FleetSetupScan,
  FleetSetupTool,
} from '@ferretry/protocol';
import type { StepperStep } from '../shell/stepper-model.ts';
import { countWords, fileName, listWords, SETUP_HARNESS_NAMES, SETUP_HARNESSES, type SetupHarness } from './setup-words.ts';

export type FirstRunMode = 'setup' | 'import';

export type HarnessChoice = 'import' | 'skip';

/** Everything the person has answered so far. */
export interface FirstRunAnswers {
  readonly choices: Readonly<Partial<Record<SetupHarness, HarnessChoice>>>;
  /** The runtime name typed on each card. Absent means the suggestion. */
  readonly names: Readonly<Partial<Record<SetupHarness, string>>>;
  /** "Add another anyway", per card. Absent means the default: ticked unless one already exists (E15). */
  readonly make: Readonly<Partial<Record<SetupHarness, boolean>>>;
  /** Updates the person ticked on What changed (O6). */
  readonly accepted: readonly string[];
}

export const NO_ANSWERS: FirstRunAnswers = { choices: {}, names: {}, make: {}, accepted: [] };

export const FIRST_RUN_FLOW_KIND = 'first-run';

const scanOf = (scan: FleetSetupScan, harness: SetupHarness): FleetHarnessScan | undefined =>
  scan.harnesses.find(candidate => candidate.harness === harness);

/** Whether this machine has the harness installed, as the scan last saw it. */
export const scanHasHarness = (scan: FleetSetupScan, harness: SetupHarness): boolean =>
  scanOf(scan, harness)?.installed === true;

/** The harnesses the person chose to import that are installed. */
export const includedHarnesses = (scan: FleetSetupScan, answers: FirstRunAnswers): SetupHarness[] =>
  SETUP_HARNESSES.filter(harness => answers.choices[harness] === 'import' && scanHasHarness(scan, harness));

/** Whether anything at all would be sent: a harness to import, or an update to take. */
export const importsAnything = (scan: FleetSetupScan, answers: FirstRunAnswers): boolean =>
  includedHarnesses(scan, answers).length > 0 || answers.accepted.length > 0;

/** The steps, which grow and shrink with the answers: no Name step when nothing is imported. */
export const firstRunSteps = (mode: FirstRunMode, scan: FleetSetupScan | null, answers: FirstRunAnswers) => {
  const steps: StepperStep[] = [];
  if (mode === 'setup') steps.push({ id: 'tools', label: 'Check tools' });
  steps.push({ id: 'claude', label: SETUP_HARNESS_NAMES.claude }, { id: 'codex', label: SETUP_HARNESS_NAMES.codex });
  if (scan !== null && scan.updates.length > 0) steps.push({ id: 'updates', label: 'What changed' });
  if (scan !== null && includedHarnesses(scan, answers).length > 0) steps.push({ id: 'names', label: 'Name runtimes' });
  steps.push({ id: 'done', label: 'Done', final: true });
  return steps;
};

/** The step that sends the import: the last one before Done, when there is anything to send. */
export const sendsImport = (steps: readonly StepperStep[], at: string, wouldSend: boolean): boolean =>
  wouldSend && steps[steps.length - 2]?.id === at;

// ── Check tools ──────────────────────────────────────────────────────────────────────────────────

/** The tools that are missing. */
export const missingTools = (tools: readonly FleetSetupTool[]): Extract<FleetSetupTool, { installed: false }>[] =>
  tools.filter((tool): tool is Extract<FleetSetupTool, { installed: false }> => !tool.installed);

// ── A harness step ───────────────────────────────────────────────────────────────────────────────

export type RowTone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';

export interface FoundRow {
  readonly key: string;
  /** "Account", "Instructions". */
  readonly label: string;
  readonly title: string;
  readonly detail?: string;
  /** Account rows only: the status shape. */
  readonly status?: 'ready' | 'refresh_due' | 'needs_sign_in';
  readonly badges: readonly { readonly text: string; readonly tone: RowTone }[];
}

const accountRow = (account: FleetHostLogin): FoundRow => {
  const email = account.email;
  switch (account.state) {
    case 'signed-in':
      return {
        key: 'account',
        label: 'Account',
        title: 'Signed in',
        ...(email === undefined ? {} : { detail: email }),
        status: 'ready',
        badges: [],
      };
    case 'refresh-due':
      return {
        key: 'account',
        label: 'Account',
        title: 'Signed in · refresh due',
        detail: `${email === undefined ? '' : `${email} · `}It renews the first time you launch.`,
        status: 'refresh_due',
        badges: [],
      };
    case 'not-signed-in':
      return {
        key: 'account',
        label: 'Account',
        title: 'Not signed in',
        detail: 'Your setup can still be imported.',
        status: 'needs_sign_in',
        badges: [],
      };
    case 'unreadable':
    case 'not-shareable':
      return {
        key: 'account',
        label: 'Account',
        title: account.state === 'unreadable' ? 'Couldn’t read this login' : 'This login can’t be shared',
        detail: account.reason ?? 'Your setup can still be imported. You can sign in afterwards.',
        status: 'needs_sign_in',
        badges: [],
      };
  }
};

const kilobytes = (bytes: number): string =>
  bytes < 1024 ? countWords(bytes, 'byte') : `${(bytes / 1024).toFixed(1).replace(/\.0$/u, '')} KB`;

/**
 * What the harness step lists under "Found on <machine>". `claudeImported` is whether Claude Code's
 * instructions are already being imported, so Codex can say whether its own are the same (E9).
 */
export const foundRows = (scan: FleetSetupScan, harness: SetupHarness, claudeImported: boolean): FoundRow[] => {
  const found = scanOf(scan, harness);
  if (found === undefined) return [];
  const rows: FoundRow[] = [accountRow(found.account)];
  const nothing =
    found.instructions === undefined &&
    found.settings === undefined &&
    found.mcpServers.length === 0 &&
    found.skills.length === 0;
  if (nothing) {
    const file = harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    rows.push({
      key: 'setup',
      label: 'Setup',
      title: 'Nothing found',
      detail: `No ${file}, settings, MCP servers or skills. Ferretry will make a plain Starter profile. You can add to it later.`,
      badges: [],
    });
    return rows;
  }
  if (found.instructions !== undefined) {
    const same = harness === 'codex' && claudeImported ? scan.instructionsIdentical : undefined;
    rows.push({
      key: 'instructions',
      label: 'Instructions',
      title: found.instructions.name,
      detail: kilobytes(found.instructions.bytes),
      badges:
        same === undefined
          ? []
          : [
              same
                ? { text: 'Same as your CLAUDE.md · one shared copy', tone: 'ok' }
                : { text: 'Different from your CLAUDE.md · kept separately', tone: 'accent' },
            ],
    });
  }
  if (found.settings !== undefined) {
    const { count, hooks } = found.settings;
    rows.push({
      key: 'settings',
      label: 'Settings',
      title: fileName(found.settings.source),
      detail: hooks === 0 ? countWords(count, 'setting') : `${countWords(count, 'setting')}, ${countWords(hooks, 'hook')}`,
      badges:
        found.secretKeys.length === 0
          ? []
          : [
              {
                text: `${countWords(found.secretKeys.length, 'secret value')} · go to the secret store, never shown`,
                tone: 'warn',
              },
            ],
    });
  }
  if (found.mcpServers.length > 0)
    rows.push({
      key: 'mcp',
      label: 'MCP servers',
      title: String(found.mcpServers.length),
      detail: found.mcpServers.join(', '),
      badges: found.missingCommands.map(command => ({ text: `Command not found: ${command}`, tone: 'warn' as const })),
    });
  if (found.skills.length > 0)
    rows.push({
      key: 'skills',
      label: 'Skills',
      title: String(found.skills.length),
      detail: found.skills.join(', '),
      badges: [],
    });
  return rows;
};

/** Problems the scan could not get past for this harness, as sentences. */
export const harnessProblems = (scan: FleetSetupScan, harness: SetupHarness): readonly string[] =>
  scanOf(scan, harness)?.problems ?? [];

/** The button that imports a harness: "Import, sign in later" when it is not signed in (E4). */
export const importLabel = (scan: FleetSetupScan, harness: SetupHarness): string => {
  const state = scanOf(scan, harness)?.account.state;
  return state === 'signed-in' || state === 'refresh-due'
    ? `Import from ${SETUP_HARNESS_NAMES[harness]}`
    : 'Import, sign in later';
};

// ── Name runtimes ────────────────────────────────────────────────────────────────────────────────

export interface NameCard {
  readonly harness: SetupHarness;
  readonly suggested: string;
  /** A runtime that already uses this login and profile (E15): adding another is unticked by default. */
  readonly duplicate?: string;
}

/** One card per imported harness that would make a runtime. */
export const nameCards = (scan: FleetSetupScan, answers: FirstRunAnswers): NameCard[] =>
  includedHarnesses(scan, answers).flatMap((harness): NameCard[] => {
    const runtime = scan.runtimes.find(candidate => candidate.harness === harness);
    if (runtime !== undefined) return [{ harness, suggested: runtime.name }];
    const duplicate = scan.duplicates.find(candidate => candidate.harness === harness);
    return duplicate === undefined ? [] : [{ harness, suggested: duplicate.suggested, duplicate: duplicate.existing }];
  });

export const cardMakes = (card: NameCard, answers: FirstRunAnswers): boolean =>
  answers.make[card.harness] ?? card.duplicate === undefined;

export const cardName = (card: NameCard, answers: FirstRunAnswers): string =>
  answers.names[card.harness] ?? card.suggested;

const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

/** The first free `<base>`, `<base>-2`, `<base>-3`, … */
export const freeName = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${String(index)}`)) index += 1;
  return `${base}-${String(index)}`;
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

export interface RuntimeNameProblem {
  readonly message: string;
  readonly suggestion?: string;
}

/**
 * Why a card's name cannot be used (R1, E16), or `null`. `taken` is every runtime on the machine;
 * `others` the names the other cards are about to use. The daemon checks again when it is sent.
 */
export const nameProblem = (
  name: string,
  taken: ReadonlySet<string>,
  others: readonly string[],
  machineName: string,
): RuntimeNameProblem | null => {
  const all = new Set([...taken, ...others]);
  if (name === '') return { message: 'Give the runtime a name.' };
  if (!NAME_PATTERN.test(name) || name.length > 64)
    return { message: 'Use only letters, digits and dashes.', suggestion: freeName(slug(name) || 'runtime', all) };
  if (taken.has(name)) return { message: `${name} is already a runtime on ${machineName}.`, suggestion: freeName(name, all) };
  if (others.includes(name)) return { message: 'Both runtimes have this name.', suggestion: freeName(name, all) };
  return null;
};

/** Every card's problem, keyed by harness; empty when the step may be sent. */
export const nameProblems = (
  cards: readonly NameCard[],
  answers: FirstRunAnswers,
  taken: ReadonlySet<string>,
  machineName: string,
): Partial<Record<SetupHarness, RuntimeNameProblem>> => {
  const made = cards.filter(card => cardMakes(card, answers));
  const problems: Partial<Record<SetupHarness, RuntimeNameProblem>> = {};
  for (const card of made) {
    const others = made.filter(other => other.harness !== card.harness).map(other => cardName(other, answers));
    const problem = nameProblem(cardName(card, answers), taken, others, machineName);
    if (problem !== null) problems[card.harness] = problem;
  }
  return problems;
};

/** The Name step's button. */
export const createLabel = (cards: readonly NameCard[], answers: FirstRunAnswers): string => {
  const count = cards.filter(card => cardMakes(card, answers)).length;
  return count === 0 ? 'Import without runtimes' : `Create ${countWords(count, 'runtime')}`;
};

// ── The change ───────────────────────────────────────────────────────────────────────────────────

/**
 * The one `setup.import` change every answer becomes. A duplicate card that was not ticked is left
 * out by not asking for duplicates; `addDuplicates` is one switch for the whole import, so when two
 * cards both duplicate and only one is ticked, both are added (the daemon has no per-harness switch).
 */
export const importChange = (scan: FleetSetupScan, answers: FirstRunAnswers): FleetAccountChange => {
  const include = includedHarnesses(scan, answers);
  const cards = nameCards(scan, answers).filter(card => cardMakes(card, answers));
  const names: Partial<Record<SetupHarness, string>> = {};
  for (const card of cards) names[card.harness] = cardName(card, answers);
  const addDuplicates = cards.some(card => card.duplicate !== undefined);
  return {
    kind: 'setup.import',
    include,
    ...(cards.length === 0 ? {} : { names }),
    ...(answers.accepted.length === 0 ? {} : { acceptedUpdates: [...answers.accepted] }),
    ...(addDuplicates ? { addDuplicates: true } : {}),
  };
};

// ── What changed ─────────────────────────────────────────────────────────────────────────────────

const KIND_WORDS: Readonly<Record<string, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

/** `mcp/github` → "MCP server · github": the kind in words, never the word "component". */
export const updateTitle = (reference: string): string => {
  const [kind = '', ...rest] = reference.split('/');
  const name = rest.join('/');
  const word = KIND_WORDS[kind];
  return word === undefined || name === '' ? reference : `${word} · ${name}`;
};

/** "Its source changed: settings.json". */
export const updateDetail = (sources: readonly string[]): string =>
  `Changed since the last import: ${listWords(sources.map(fileName))}.`;

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

/** The result notes (E4–E9) for the harnesses that were imported. */
export const importNotes = (scan: FleetSetupScan, include: readonly SetupHarness[]): readonly string[] =>
  scan.notes.filter(note => include.includes(note.harness)).map(note => note.text);
