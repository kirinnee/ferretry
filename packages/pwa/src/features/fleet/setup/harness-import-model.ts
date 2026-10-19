/**
 * The Claude Code and Codex steps of New machine setup, as data (docs/design/account-model.md §4.3,
 * E1–E11; the flat-onboarding proposal).
 *
 * ONE SCREEN PER CLI: is it installed, what was found, is it signed in, and the runtime it will make —
 * named in place, prefilled with the daemon's own suggestion (`claude-default`, `codex-default`). There
 * is no Name step and no runtime wizard: the step's one button sends ONE reviewed change, `setup.import`
 * for this CLI alone, and the import creates the runtime under that name. Import again is the same step
 * opened from Settings, and a component whose source changed is offered on it, never ticked (O6).
 *
 * Pure: a scan and the person's answers in, the rows, the name, the label and the change out.
 */

import type {
  FleetAccountChange,
  FleetHarnessScan,
  FleetHostLogin,
  FleetSetupScan,
  FleetSetupTool,
} from '@ferretry/protocol';
import { countWords, fileName, listWords, type SetupHarness } from './setup-words.ts';

type FleetSetupUpdate = FleetSetupScan['updates'][number];

const scanOf = (scan: FleetSetupScan, harness: SetupHarness): FleetHarnessScan | undefined =>
  scan.harnesses.find(candidate => candidate.harness === harness);

/** Whether this machine has the harness installed, as the scan last saw it. */
export const scanHasHarness = (scan: FleetSetupScan, harness: SetupHarness): boolean =>
  scanOf(scan, harness)?.installed === true;

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
      detail:
        hooks === 0 ? countWords(count, 'setting') : `${countWords(count, 'setting')}, ${countWords(hooks, 'hook')}`,
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

/** Whether the person's own login for this CLI is signed in (a refresh due still counts: it renews itself). */
export const scanSignedIn = (scan: FleetSetupScan, harness: SetupHarness): boolean => {
  const state = scanOf(scan, harness)?.account.state;
  return state === 'signed-in' || state === 'refresh-due';
};

/**
 * Whether the step offers "Sign in now": the person's own login is there to share but is not signed in.
 * A login that could not be read, or cannot be shared, is imported as an empty slot and signed in after.
 */
export const offersSignIn = (scan: FleetSetupScan, harness: SetupHarness): boolean =>
  scanOf(scan, harness)?.account.state === 'not-signed-in';

// ── The runtime ──────────────────────────────────────────────────────────────────────────────────

/** What the person answered on one CLI's step. Kept with the rail's progress, so Finish later keeps it. */
export interface HarnessAnswers {
  /** The runtime name typed. Absent means the daemon's suggestion. */
  readonly name?: string;
  /** "Also add <name>" when this login and profile already have a runtime (E15). Off unless ticked. */
  readonly addAnother?: boolean;
  /** Updates ticked under What changed (O6). */
  readonly accepted?: readonly string[];
}

/** The runtime the import would make for this CLI, or the one it would duplicate. */
export type RuntimePlan =
  | { readonly kind: 'new'; readonly suggested: string }
  | { readonly kind: 'duplicate'; readonly existing: string; readonly suggested: string }
  /** The import makes no runtime for it: nothing it could run on was found. */
  | { readonly kind: 'none' };

export const runtimePlan = (scan: FleetSetupScan, harness: SetupHarness): RuntimePlan => {
  const runtime = scan.runtimes.find(candidate => candidate.harness === harness);
  if (runtime !== undefined) return { kind: 'new', suggested: runtime.name };
  const duplicate = scan.duplicates.find(candidate => candidate.harness === harness);
  return duplicate === undefined
    ? { kind: 'none' }
    : { kind: 'duplicate', existing: duplicate.existing, suggested: duplicate.suggested };
};

/** Whether the import makes a runtime: always for a new one, and for a duplicate only when ticked. */
export const makesRuntime = (plan: RuntimePlan, answers: HarnessAnswers): boolean =>
  plan.kind === 'new' || (plan.kind === 'duplicate' && answers.addAnother === true);

/** The name in the field: what was typed, else the daemon's suggestion. */
export const runtimeName = (plan: RuntimePlan, answers: HarnessAnswers): string =>
  answers.name ?? (plan.kind === 'none' ? '' : plan.suggested);

/** The step's one button: "Import and create claude-default", "…, sign in later" when not signed in (E4). */
export const importButtonLabel = (plan: RuntimePlan, answers: HarnessAnswers, signedIn: boolean): string =>
  `${makesRuntime(plan, answers) ? `Import and create ${runtimeName(plan, answers)}` : 'Import'}${signedIn ? '' : ', sign in later'}`;

/** The ONE change this step sends: this CLI only, under the name in the field. */
export const harnessImportChange = (
  harness: SetupHarness,
  plan: RuntimePlan,
  answers: HarnessAnswers,
): FleetAccountChange => {
  const makes = makesRuntime(plan, answers);
  const accepted = answers.accepted ?? [];
  return {
    kind: 'setup.import',
    include: [harness],
    ...(makes ? { names: { [harness]: runtimeName(plan, answers) } } : {}),
    ...(accepted.length === 0 ? {} : { acceptedUpdates: [...accepted] }),
    ...(makes && plan.kind === 'duplicate' ? { addDuplicates: true } : {}),
  };
};

// ── What changed ─────────────────────────────────────────────────────────────────────────────────

/** One thing that changed since the last import: the kind in words, and its name. */
export interface ChangedItem {
  readonly kind: string;
  readonly name: string;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skill',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

/** Kinds that have one document each, so they read as the kind alone: "Settings changed". */
const WHOLE_KINDS: readonly string[] = ['instructions', 'settings', 'hooks'];

const kindOf = (reference: string): string => reference.split('/')[0] ?? '';
const nameOf = (reference: string): string => reference.split('/').slice(1).join('/');

/**
 * What changed, one entry per thing a person recognises. A skills component names every skill by its
 * source folder, and a skill both CLIs share has TWO sources (one per CLI) — so skills are named by
 * folder and de-duplicated, never listed once per source.
 */
export const changedItems = (updates: readonly FleetSetupUpdate[]): readonly ChangedItem[] => {
  const seen = new Set<string>();
  const items: ChangedItem[] = [];
  const add = (kind: string, name: string): void => {
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, name });
  };
  for (const update of updates) {
    const kind = kindOf(update.reference);
    if (kind === 'skills') for (const source of update.sources) add('skills', fileName(source));
    else add(kind, nameOf(update.reference));
  }
  return items;
};

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "Slack MCP server and 13 skills changed": one line, the count of each kind, never a list of names. */
export const changeSummary = (updates: readonly FleetSetupUpdate[]): string => {
  const items = changedItems(updates);
  const kinds = [...new Set(items.map(item => item.kind))];
  const parts = kinds.map(kind => {
    const named = items.filter(item => item.kind === kind);
    const noun = (KIND_WORDS[kind] ?? kind).toLowerCase();
    const word = kind === 'mcp' ? 'MCP server' : noun;
    const [only] = named;
    if (named.length === 1 && only !== undefined && kind !== 'skills')
      return WHOLE_KINDS.includes(kind) ? (KIND_WORDS[kind] ?? kind) : `${capitalised(only.name)} ${word}`;
    return countWords(named.length, word);
  });
  return `${capitalised(listWords(parts))} changed`;
};

/** The "Show list" lines: the kind in words and its de-duplicated names. */
export const changeList = (updates: readonly FleetSetupUpdate[]): readonly { kind: string; names: string }[] => {
  const items = changedItems(updates);
  return [...new Set(items.map(item => item.kind))].map(kind => ({
    kind: kind === 'skills' ? 'Skills' : (KIND_WORDS[kind] ?? kind),
    names: items
      .filter(item => item.kind === kind)
      .map(item => item.name)
      .join(', '),
  }));
};

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

/** The result notes (E4–E9) for the harnesses that were imported. */
export const importNotes = (scan: FleetSetupScan, include: readonly SetupHarness[]): readonly string[] =>
  scan.notes.filter(note => include.includes(note.harness)).map(note => note.text);

/** What one import brought in, counted from the scan it was sent from. */
export interface ImportCounts {
  readonly logins: number;
  readonly skills: number;
  readonly mcpServers: number;
  readonly conversations: number;
}

export const importCounts = (scan: FleetSetupScan, harness: SetupHarness, conversations: number): ImportCounts => {
  const found = scanOf(scan, harness);
  return {
    logins: found === undefined || ['unreadable', 'not-shareable'].includes(found.account.state) ? 0 : 1,
    skills: found?.skills.length ?? 0,
    mcpServers: found?.mcpServers.length ?? 0,
    conversations,
  };
};

/** "Imported 2 logins, 13 skills, 1 MCP server, 312 conversations": ONE line; a zero is left out. */
export const importSummary = (counts: ImportCounts): string => {
  const parts = [
    counts.logins > 0 ? countWords(counts.logins, 'login') : null,
    counts.skills > 0 ? countWords(counts.skills, 'skill') : null,
    counts.mcpServers > 0 ? countWords(counts.mcpServers, 'MCP server') : null,
    counts.conversations > 0 ? countWords(counts.conversations, 'conversation') : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Imported' : `Imported ${parts.join(', ')}`;
};
