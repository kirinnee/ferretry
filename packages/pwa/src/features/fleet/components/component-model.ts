/**
 * The Components tab as data (docs/design/account-model.md §3.3, §4.2, E20–E22, E30).
 *
 * A component is saved once and referenced, so everything here is about two questions: what it
 * holds, and who it reaches. The daemon answers both — the catalogue carries each component's
 * content, badges and "used by" — and this module only turns those answers into words, and an edit
 * the person typed into the ONE change the daemon derives the next setup from.
 *
 * Nothing here composes a configuration document. A settings edit is sent as its entries, with
 * `{ keep: true }` for a value the daemon would not show, so a hidden value is kept without ever
 * travelling back.
 *
 * Pure.
 */

import {
  type FleetAccountChange,
  type FleetComponentKind,
  FleetComponentNameSchema,
  type FleetComponentView,
  type FleetEnvEntry,
  type FleetEnvInput,
  type FleetHarnessScope,
  type FleetLayeredProfileView,
  type FleetProfileScope,
} from '@ferretry/protocol';
import { cloneOriginName } from '../setup/clone-model.ts';

export type CatalogHarness = 'claude' | 'codex';

export const HARNESS_NAMES: Readonly<Record<CatalogHarness, string>> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * A scope in words (§3.4 P7): what every badge on a component or a profile says. The ONE place the PWA
 * spells them, so the Profiles tab, the builder, Add runtime and the Components tab can never disagree.
 */
export const SCOPE_WORDS: Readonly<Record<FleetHarnessScope, string>> = {
  generic: 'Generic',
  claude: 'Claude only',
  codex: 'Codex only',
};

/** A profile written before P7 that layers Claude-only and Codex-only parts together. */
const MIXED_WORD = 'Mixed';

/** The scope a profile shows: its word, or "Mixed". */
export const profileScopeWord = (scope: FleetProfileScope): string =>
  scope.kind === 'mixed' ? MIXED_WORD : SCOPE_WORDS[scope.scope];

/** The six kinds in the order the tab lists them (the prototype's TYPE_ORDER). */
export const COMPONENT_KINDS: readonly FleetComponentKind[] = [
  'instructions',
  'mcp',
  'skills',
  'settings',
  'hooks',
  'modelSets',
];

/** One of a kind, in a sentence: "New MCP server", "Model set · Heavy". */
export const KIND_ONE: Readonly<Record<FleetComponentKind, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

/** Several of a kind: "Skip, add no MCP servers". */
export const KIND_MANY: Readonly<Record<FleetComponentKind, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP servers',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model sets',
};

/** Settings and hooks belong to one harness; the other kinds may be generic (K2). */
export const harnessBound = (kind: FleetComponentKind): boolean => kind === 'settings' || kind === 'hooks';

export type ComponentBadgeTone = 'pend' | 'accent' | 'warn';

export interface ComponentBadge {
  readonly text: string;
  readonly tone: ComponentBadgeTone;
  /** Draws the warning mark before the text. */
  readonly warn?: boolean;
  /** Draws the lock before the text. */
  readonly lock?: boolean;
}

/** A `${secret:NAME}` reference: the value lives in the secret store and is never shown (E7). */
export const SECRET_REFERENCE = /^\$\{secret:[^}]+\}$/u;

/** Environment entries the secret store holds or the daemon would not show. */
const storedSecrets = (env: readonly FleetEnvEntry[]): number =>
  env.filter(entry => 'hidden' in entry || SECRET_REFERENCE.test(entry.value)).length;

const detailEnv = (component: FleetComponentView): readonly FleetEnvEntry[] =>
  component.detail.kind === 'mcp' || component.detail.kind === 'settings' ? component.detail.env : [];

/** A scope's badge: Generic reads quiet, one harness reads as the accent it narrows to. */
const scopeBadge = (scope: FleetHarnessScope): ComponentBadge => ({
  text: SCOPE_WORDS[scope],
  tone: scope === 'generic' ? 'pend' : 'accent',
});

/** A profile's scope badge; a mixed one is a warning. */
export const profileScopeBadge = (scope: FleetProfileScope): ComponentBadge =>
  scope.kind === 'mixed' ? { text: MIXED_WORD, tone: 'warn', warn: true } : scopeBadge(scope.scope);

/**
 * The prototype's `compBadges`: harness scope, where a copy came from, partial support, warnings, a path
 * to check, stored secrets. `machineNames` is this browser's own label for each machine it paired, by
 * daemon id, so a copied component names its source the way the reader does.
 */
export function componentBadges(
  component: FleetComponentView,
  machineName: string,
  machineNames: ReadonlyMap<string, string> = new Map(),
): readonly ComponentBadge[] {
  const badges: ComponentBadge[] = [scopeBadge(component.scope)];
  const origin = cloneOriginName(component, machineNames);
  if (origin !== undefined) badges.push({ text: `Copied from ${origin}`, tone: 'pend' });
  for (const partial of component.partial)
    badges.push({ text: `Partly supported on ${HARNESS_NAMES[partial.harness]}`, tone: 'warn' });
  for (const warning of component.warnings) badges.push({ text: warning, tone: 'warn', warn: true });
  if (component.checkPath !== undefined)
    badges.push({ text: `Check this path on ${machineName}`, tone: 'warn', warn: true });
  const secrets = storedSecrets(detailEnv(component));
  if (secrets > 0) badges.push({ text: `${counted(secrets, 'secret')} stored`, tone: 'pend', lock: true });
  return badges;
}

/** "1 profile", "3 runtimes". */
export const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

/** "a, b and c". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
}

/** The profiles that have this component as one of their OWN layers (the rest reach it through a base). */
export const profilesWithLayer = (reference: string, profiles: readonly FleetLayeredProfileView[]): readonly string[] =>
  profiles.filter(profile => profile.layers.includes(reference)).map(profile => profile.name);

// ── Drafts ───────────────────────────────────────────────────────────────────────────────────────

/** One line of a settings edit: a value typed, or a hidden one kept as is. */
export type SettingsLine = { readonly key: string; readonly hidden: true };

/**
 * What the edit and new forms hold. Every kind's text lives in `body`, the way the prototype's form
 * does: instructions and hooks text, the MCP command line, skills and models one per line, settings
 * one `key = value` per line.
 */
export interface ComponentDraft {
  readonly kind: FleetComponentKind;
  readonly name: string;
  /** `undefined` is generic (both harnesses). */
  readonly harness: CatalogHarness | undefined;
  readonly body: string;
  /** Model sets: the default, one of the models in `body`. */
  readonly defaultModel: string;
  /** Settings: values the daemon hid, kept as is. */
  readonly hiddenKeys: readonly string[];
  /** The fields an edit keeps untouched (an MCP server's or a settings component's environment, flags). */
  readonly keptEnv: readonly string[];
  readonly flags: readonly string[];
  /** Instructions or hooks text the daemon cut a secret out of: it cannot be saved from here. */
  readonly redacted: boolean;
  /** Hooks read from a folder rather than one file: edited in that folder. */
  readonly directory: boolean;
  /** An MCP server at a web address that signs in with OAuth (docs/mcp-oauth.md). Kept by an edit. */
  readonly oauth: boolean;
}

export const blankDraft = (kind: FleetComponentKind): ComponentDraft => ({
  kind,
  name: '',
  harness: harnessBound(kind) ? 'claude' : undefined,
  body: '',
  defaultModel: '',
  hiddenKeys: [],
  keptEnv: [],
  flags: [],
  redacted: false,
  directory: false,
  oauth: false,
});

const QUOTE_NEEDED = /[\s"'\\]/u;

/** One argument as a person would type it: quoted only when it has to be. */
const shellWord = (word: string): string =>
  word === '' || QUOTE_NEEDED.test(word) ? `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : word;

/** An MCP server's command line: `npx -y @modelcontextprotocol/server-github`, or its URL. */
export function mcpCommandLine(detail: Extract<FleetComponentView['detail'], { kind: 'mcp' }>): string {
  if (detail.command === undefined) return detail.url ?? '';
  return [detail.command, ...(detail.args ?? [])].map(shellWord).join(' ');
}

/** Splits a command line into words, honouring double and single quotes and backslashes. */
export function splitCommandLine(line: string): readonly string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const [index, char] of [...line].entries()) {
    const last = index === line.length - 1;
    if (escaped) {
      word += char;
      escaped = false;
    } else if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && !last) escaped = true;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && !last) {
      escaped = true;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

const lines = (text: string): readonly string[] =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');

/** The form's starting point for an existing component. */
export function draftFromComponent(component: FleetComponentView): ComponentDraft {
  const base = { ...blankDraft(component.kind), name: component.name, harness: component.harness };
  const content = component.content;
  const detail = component.detail;
  switch (detail.kind) {
    case 'instructions':
    case 'hooks':
      return {
        ...base,
        body: content?.form === 'text' ? content.text : '',
        redacted: content?.form === 'text' && content.redacted,
        directory: detail.kind === 'hooks' && detail.directory !== undefined,
      };
    case 'mcp':
      return {
        ...base,
        body: mcpCommandLine(detail),
        keptEnv: detail.env.map(entry => entry.name),
        oauth: detail.auth === 'oauth',
      };
    case 'skills':
      return { ...base, body: detail.items.join('\n') };
    case 'settings': {
      const entries = content?.form === 'entries' ? content.entries : [];
      return {
        ...base,
        body: entries.flatMap(entry => ('hidden' in entry ? [] : [`${entry.key} = ${entry.value}`])).join('\n'),
        hiddenKeys: entries.flatMap(entry => ('hidden' in entry ? [entry.key] : [])),
        keptEnv: detail.env.map(entry => entry.name),
        flags: detail.flags ?? [],
      };
    }
    default:
      return { ...base, body: detail.models.join('\n'), defaultModel: detail.default };
  }
}

/** A model set's models, as typed. */
export const componentDraftModels = (draft: ComponentDraft): readonly string[] => [...new Set(lines(draft.body))];

/** The default a model set saves: the one picked, or the first model when the pick was removed. */
export const draftDefault = (draft: ComponentDraft): string | undefined => {
  const models = componentDraftModels(draft);
  return models.includes(draft.defaultModel) ? draft.defaultModel : models[0];
};

/** A settings line's value as the daemon stores it: JSON when it reads as JSON, else the text. */
export function settingsValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The settings lines typed, as `key → value`; a line without `=` is reported, never dropped. */
export function settingsEntries(body: string): {
  readonly entries: ReadonlyMap<string, string>;
  readonly bad?: string;
} {
  const entries = new Map<string, string>();
  for (const line of lines(body)) {
    const at = line.indexOf('=');
    const key = at > 0 ? line.slice(0, at).trim() : '';
    if (key === '') return { entries, bad: line };
    entries.set(key, line.slice(at + 1).trim());
  }
  return { entries };
}

/** Why the form cannot be saved yet, in one sentence, or `undefined` when it can (the prototype's `draftError`). */
export function draftProblem(
  draft: ComponentDraft,
  existing: readonly FleetComponentView[],
  editing?: string,
): string | undefined {
  const name = draft.name.trim();
  if (name === '') return 'Give it a name.';
  if (!FleetComponentNameSchema.safeParse(name).success) return 'Use a name without a slash or "..".';
  if (editing === undefined && existing.some(component => component.kind === draft.kind && component.name === name))
    return `You already have one called ${name}.`;
  if (draft.redacted) return 'This text holds a value that looks like a secret, so it can’t be saved from here.';
  if (draft.directory) return 'These hooks come from a folder, so they are edited in that folder.';
  switch (draft.kind) {
    case 'mcp':
      return splitCommandLine(draft.body).length === 0 ? 'Type the command that starts the server.' : undefined;
    case 'skills':
      return lines(draft.body).length === 0 ? 'Name at least one skill.' : undefined;
    case 'settings': {
      const bad = settingsEntries(draft.body).bad;
      return bad === undefined ? undefined : `Write each setting as key = value: “${bad}”.`;
    }
    case 'modelSets':
      return componentDraftModels(draft).length === 0 ? 'Add at least one model.' : undefined;
    default:
      return undefined;
  }
}

const keepAll = (names: readonly string[]): FleetEnvInput | undefined =>
  names.length === 0 ? undefined : Object.fromEntries(names.map(name => [name, { keep: true as const }]));

const withHarness = (harness: CatalogHarness | undefined) => (harness === undefined ? {} : { harness });

const URL_LINE = /^https?:\/\//iu;

/** Whether an MCP draft names a server by its web address rather than a command: only those sign in. */
export const mcpDraftIsUrl = (draft: Pick<ComponentDraft, 'body'>): boolean => URL_LINE.test(draft.body.trim());

/** The ONE change a saved form asks for. Call only when {@link draftProblem} says nothing. */
export function componentChange(draft: ComponentDraft, create: boolean): FleetAccountChange {
  const name = draft.name.trim();
  const put = (component: Extract<FleetAccountChange, { kind: 'component.put' }>['component'], content?: string) =>
    ({
      kind: 'component.put',
      name,
      component,
      ...(content === undefined ? {} : { content }),
      create,
    }) as const;
  switch (draft.kind) {
    case 'instructions':
      return put({ kind: 'instructions', ...withHarness(draft.harness) }, draft.body);
    case 'hooks':
      return put({ kind: 'hooks', harness: draft.harness ?? 'claude' }, draft.body);
    case 'mcp': {
      const line = draft.body.trim();
      const env = keepAll(draft.keptEnv);
      const target = URL_LINE.test(line)
        ? { url: line, ...(draft.oauth ? { auth: 'oauth' as const } : {}) }
        : (([command, ...args]) => ({ command: command as string, ...(args.length === 0 ? {} : { args }) }))(
            splitCommandLine(line),
          );
      return put({ kind: 'mcp', ...target, ...(env === undefined ? {} : { env }), ...withHarness(draft.harness) });
    }
    case 'skills':
      return put({ kind: 'skills', items: [...new Set(lines(draft.body))], ...withHarness(draft.harness) });
    case 'settings': {
      const typed = settingsEntries(draft.body).entries;
      const entries = Object.fromEntries([
        ...[...typed].map(([key, value]) => [key, { value: settingsValue(value) }] as const),
        ...draft.hiddenKeys.filter(key => !typed.has(key)).map(key => [key, { keep: true as const }] as const),
      ]);
      const env = keepAll(draft.keptEnv);
      return put({
        kind: 'settings',
        harness: draft.harness ?? 'claude',
        entries,
        ...(draft.flags.length === 0 ? {} : { flags: [...draft.flags] }),
        ...(env === undefined ? {} : { env }),
      });
    }
    default:
      return put({
        kind: 'modelSets',
        models: [...componentDraftModels(draft)],
        default: draftDefault(draft) as string,
      });
  }
}

/** What the "saved for reuse" list calls something made inside a flow: "Instructions Team rules". */
export const reuseLabel = (kind: FleetComponentKind, name: string): string => `${KIND_ONE[kind]} ${name}`;
