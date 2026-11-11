/**
 * The Components section as data (docs/design/account-model.md §3.3, §4.2, E20–E22, E30).
 *
 * A component is saved once and referenced, so everything here is about two questions: what it
 * holds, and who it reaches. The daemon answers both — the catalogue carries each component's
 * content, badges and "used by" — and this module only turns those answers into words, and an edit
 * the person typed into the ONE change the daemon derives the next setup from.
 *
 * Nothing here composes a configuration document. A settings edit is sent as its entries, with
 * `{ keep: true }` for a value the daemon would not show, so a hidden value is kept without ever
 * travelling back. A launch flag or MCP argument the daemon hid is sent the same way, as
 * `{ keep: true, at }` — its position in the list as read — with the list's etag.
 *
 * Pure.
 */

import {
  type AccountChange,
  type CommandWord,
  type ComponentKind,
  ComponentNameSchema,
  type ComponentView,
  type EnvEntry,
  type EnvInput,
  HIDDEN_WORD_TEXT,
  type HarnessScope,
  type KeptWord,
  type LayeredProfileView,
  type ProfileScope,
} from '../../../../contract/index.ts';

/**
 * What a copied item's source is called: this browser's own label for that machine when it has one, else the name the
 * machine gave itself. `undefined` for an item that was not copied.
 */
const cloneOriginName = (
  item: { readonly clonedFrom?: string; readonly clonedFromDaemon?: string },
  names: ReadonlyMap<string, string>,
): string | undefined => {
  const known = item.clonedFromDaemon === undefined ? undefined : names.get(item.clonedFromDaemon);
  if (known !== undefined) return known;
  return item.clonedFrom === undefined ? undefined : `${item.clonedFrom} (the name it gave itself)`;
};

export type CatalogHarness = 'claude-code' | 'codex';

export const HARNESS_NAMES: Readonly<Record<CatalogHarness, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/**
 * A scope in words (§3.4 P7): what every badge on a component or a profile says. The ONE place the PWA
 * spells them, so the Profiles tab, the builder, Add runtime and the Components section can never disagree.
 */
export const SCOPE_WORDS: Readonly<Record<HarnessScope, string>> = {
  generic: 'Generic',
  'claude-code': 'Claude only',
  codex: 'Codex only',
};

/** A profile written before P7 that layers Claude-only and Codex-only parts together. */
const MIXED_WORD = 'Mixed';

/** The scope a profile shows: its word, or "Mixed". */
export const profileScopeWord = (scope: ProfileScope): string =>
  scope.kind === 'mixed' ? MIXED_WORD : SCOPE_WORDS[scope.scope];

/** The six kinds in the order the tab lists them (the prototype's TYPE_ORDER). */
export const COMPONENT_KINDS: readonly ComponentKind[] = [
  'instructions',
  'mcp',
  'skills',
  'settings',
  'hooks',
  'modelSets',
];

/** One of a kind, in a sentence: "New MCP server", "Model set · Heavy". */
export const KIND_ONE: Readonly<Record<ComponentKind, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

/** Settings and hooks belong to one harness; the other kinds may be generic (K2). */
export const harnessBound = (kind: ComponentKind): boolean => kind === 'settings' || kind === 'hooks';

type ComponentBadgeTone = 'pend' | 'accent' | 'warn';

export interface ComponentBadge {
  readonly text: string;
  readonly tone: ComponentBadgeTone;
  /** Draws the warning mark before the text. */
  readonly warn?: boolean;
  /** Draws the lock before the text. */
  readonly lock?: boolean;
}

/** A `${secret:NAME}` reference: the value lives in the secret store and is never shown (E7). */
const SECRET_REFERENCE = /^\$\{secret:[^}]+\}$/u;

/** Environment entries the secret store holds or the daemon would not show. */
const storedSecrets = (env: readonly EnvEntry[]): number =>
  env.filter(entry => 'hidden' in entry || SECRET_REFERENCE.test(entry.value)).length;

const detailEnv = (component: ComponentView): readonly EnvEntry[] =>
  component.detail.kind === 'mcp' || component.detail.kind === 'settings' ? component.detail.env : [];

/** A scope's badge: Generic reads quiet, one harness reads as the accent it narrows to. */
const scopeBadge = (scope: HarnessScope): ComponentBadge => ({
  text: SCOPE_WORDS[scope],
  tone: scope === 'generic' ? 'pend' : 'accent',
});

/** A profile's scope badge; a mixed one is a warning. */
export const profileScopeBadge = (scope: ProfileScope): ComponentBadge =>
  scope.kind === 'mixed' ? { text: MIXED_WORD, tone: 'warn', warn: true } : scopeBadge(scope.scope);

/**
 * The prototype's `compBadges`: harness scope, where a copy came from, partial support, warnings, a path
 * to check, stored secrets. `machineNames` is this browser's own label for each machine it paired, by
 * daemon id, so a copied component names its source the way the reader does.
 */
export function componentBadges(
  component: ComponentView,
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
export const profilesWithLayer = (reference: string, profiles: readonly LayeredProfileView[]): readonly string[] =>
  profiles.filter(profile => profile.layers.includes(reference)).map(profile => profile.name);

// ── Drafts ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What the edit and new forms hold. Every kind's text lives in `body`, the way the prototype's form
 * does: instructions and hooks text, the MCP command line, skills and models one per line, settings
 * one `key = value` per line.
 */
export interface ComponentDraft {
  readonly kind: ComponentKind;
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
  /** Settings: the launch flags as read, a hidden one kept by its position. */
  readonly flags: readonly (string | KeptWord)[];
  /** The etag the flags and the MCP arguments were read with, sent back with a kept word. */
  readonly wordsEtag?: string;
  /** MCP: the arguments the daemon hid, as `body` shows each and where it stood in the list as read. */
  readonly hiddenArgs: readonly { readonly shown: string; readonly at: number }[];
  /**
   * The daemon withheld the whole list of MCP arguments or launch flags (the write rule still refuses a word the word
   * cutter showed): nothing of it was sent, so no word of it can be kept, and the form says so in words.
   */
  readonly wordsWithheld: boolean;
  /** An MCP server's command or web address the daemon withheld: nothing of it was sent, so the form asks for it again. */
  readonly commandWithheld: boolean;
  /** Instructions or hooks text the daemon cut a secret out of: it cannot be saved from here. */
  readonly redacted: boolean;
  /** Hooks read from a folder rather than one file: edited in that folder. */
  readonly directory: boolean;
  /** An MCP server at a web address that signs in with OAuth (docs/mcp-oauth.md). Kept by an edit. */
  readonly oauth: boolean;
}

export const blankDraft = (kind: ComponentKind): ComponentDraft => ({
  kind,
  name: '',
  harness: harnessBound(kind) ? 'claude-code' : undefined,
  body: '',
  defaultModel: '',
  hiddenKeys: [],
  keptEnv: [],
  flags: [],
  hiddenArgs: [],
  wordsWithheld: false,
  commandWithheld: false,
  redacted: false,
  directory: false,
  oauth: false,
});

const QUOTE_NEEDED = /[\s"'\\]/u;

/** One argument as a person would type it: quoted only when it has to be. */
const shellWord = (word: string): string =>
  word === '' || QUOTE_NEEDED.test(word) ? `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : word;

/** A command-line word as it may be shown: as written, or with its hidden value as `‹hidden›`. */
const shownText = (word: CommandWord): string => (typeof word === 'string' ? word : word.shown);

/** An MCP server's command line: `npx -y @modelcontextprotocol/server-github`, or its URL. */
export function mcpCommandLine(detail: Extract<ComponentView['detail'], { kind: 'mcp' }>): string {
  if (detail.commandWithheld === true || detail.urlWithheld === true) return '';
  if (detail.command === undefined) return detail.url ?? '';
  return [detail.command, ...(detail.args ?? []).map(shownText)].map(shellWord).join(' ');
}

/** The hidden words of a list as read, with where each stood. */
const hiddenWords = (words: readonly CommandWord[] | undefined): readonly { shown: string; at: number }[] =>
  (words ?? []).flatMap((word, at) => (typeof word === 'string' ? [] : [{ shown: word.shown, at }]));

/**
 * An MCP command line's arguments as an edit sends them: a word showing a hidden value, left as it was, is kept by
 * where it stood (the first unused hidden word shown the same), so moving it moves its value with it. `bad` is a
 * word holding `‹hidden›` that is no hidden word as shown: its value was never here to send.
 */
function mcpArguments(
  draft: Pick<ComponentDraft, 'hiddenArgs'>,
  words: readonly string[],
): { readonly args: readonly (string | KeptWord)[]; readonly bad?: string } {
  const used = new Set<number>();
  const args: (string | KeptWord)[] = [];
  for (const word of words) {
    if (!word.includes(HIDDEN_WORD_TEXT)) {
      args.push(word);
      continue;
    }
    const kept = draft.hiddenArgs.find(hidden => hidden.shown === word && !used.has(hidden.at));
    if (kept === undefined) return { args, bad: word };
    used.add(kept.at);
    args.push({ keep: true, at: kept.at });
  }
  return { args };
}

/** The etag a change sends: only with a kept word, which is all the daemon checks it for. */
const etagFor = (words: readonly (string | KeptWord)[], etag: string | undefined): string | undefined =>
  words.some(word => typeof word !== 'string') ? etag : undefined;

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
export function draftFromComponent(component: ComponentView): ComponentDraft {
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
    case 'mcp': {
      // A withheld command or address is retyped whole, with its arguments: nothing of the line can be kept by position.
      const startWithheld = detail.commandWithheld === true || detail.urlWithheld === true;
      return {
        ...base,
        body: mcpCommandLine(detail),
        keptEnv: detail.env.map(entry => entry.name),
        hiddenArgs: startWithheld ? [] : hiddenWords(detail.args),
        wordsWithheld: detail.argsWithheld === true,
        commandWithheld: startWithheld,
        ...(detail.argsEtag === undefined || startWithheld ? {} : { wordsEtag: detail.argsEtag }),
        oauth: detail.auth === 'oauth',
      };
    }
    case 'skills':
      return { ...base, body: detail.items.join('\n') };
    case 'settings': {
      const entries = content?.form === 'entries' ? content.entries : [];
      return {
        ...base,
        body: entries.flatMap(entry => ('hidden' in entry ? [] : [`${entry.key} = ${entry.value}`])).join('\n'),
        hiddenKeys: entries.flatMap(entry => ('hidden' in entry ? [entry.key] : [])),
        keptEnv: detail.env.map(entry => entry.name),
        flags: (detail.flags ?? []).map((word, at) => (typeof word === 'string' ? word : { keep: true as const, at })),
        wordsWithheld: detail.flagsWithheld === true,
        ...(detail.flagsEtag === undefined ? {} : { wordsEtag: detail.flagsEtag }),
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

/** The form's words for an MCP server whose arguments the daemon withheld (it was sent none, so none can be kept). */
export const WITHHELD_ARGS_PROBLEM =
  'The arguments are not shown because they may hold a credential, so they can’t be kept. Type the whole command line again, or edit the file at this machine.';

/** The form's words for an MCP server's command or web address the daemon withheld (it was sent nothing of it). */
export const WITHHELD_COMMAND_PROBLEM =
  'The command is not shown because it may hold a credential, so it can’t be kept. Type the whole command line again, or edit the file at this machine.';

/** The form's words for launch flags the daemon withheld: the form has no place to type flags, so it cannot save them. */
export const WITHHELD_FLAGS_PROBLEM =
  'The launch flags are not shown because they may hold a credential, so this form can’t keep them. Edit the file at this machine.';

/** Why the form cannot be saved yet, in one sentence, or `undefined` when it can (the prototype's `draftError`). */
export function draftProblem(
  draft: ComponentDraft,
  existing: readonly ComponentView[],
  editing?: string,
): string | undefined {
  const name = draft.name.trim();
  if (name === '') return 'Give it a name.';
  if (!ComponentNameSchema.safeParse(name).success) return 'Use a name without a slash or "..".';
  if (editing === undefined && existing.some(component => component.kind === draft.kind && component.name === name))
    return `You already have one called ${name}.`;
  if (draft.redacted) return 'This text holds a value that looks like a secret, so it can’t be saved from here.';
  if (draft.directory) return 'These hooks come from a folder, so they are edited in that folder.';
  switch (draft.kind) {
    case 'mcp': {
      const words = splitCommandLine(draft.body);
      if (words.length === 0)
        return draft.commandWithheld ? WITHHELD_COMMAND_PROBLEM : 'Type the command that starts the server.';
      if (draft.wordsWithheld && words.length === 1) return WITHHELD_ARGS_PROBLEM;
      const bad = mcpArguments(draft, words.slice(1)).bad;
      return bad === undefined ? undefined : `Type the hidden value again, or put “${bad}” back as it was.`;
    }
    case 'skills':
      return lines(draft.body).length === 0 ? 'Name at least one skill.' : undefined;
    case 'settings': {
      if (draft.wordsWithheld) return WITHHELD_FLAGS_PROBLEM;
      const bad = settingsEntries(draft.body).bad;
      return bad === undefined ? undefined : `Write each setting as key = value: “${bad}”.`;
    }
    case 'modelSets':
      return componentDraftModels(draft).length === 0 ? 'Add at least one model.' : undefined;
    default:
      return undefined;
  }
}

const keepAll = (names: readonly string[]): EnvInput | undefined =>
  names.length === 0 ? undefined : Object.fromEntries(names.map(name => [name, { keep: true as const }]));

const withHarness = (harness: CatalogHarness | undefined) => (harness === undefined ? {} : { harness });

const URL_LINE = /^https?:\/\//iu;

/** Whether an MCP draft names a server by its web address rather than a command: only those sign in. */
export const mcpDraftIsUrl = (draft: Pick<ComponentDraft, 'body'>): boolean => URL_LINE.test(draft.body.trim());

/** The ONE change a saved form asks for. Call only when {@link draftProblem} says nothing. */
export function componentChange(draft: ComponentDraft, create: boolean): AccountChange {
  const name = draft.name.trim();
  const put = (component: Extract<AccountChange, { kind: 'component.put' }>['component'], content?: string) =>
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
      return put({ kind: 'hooks', harness: draft.harness ?? 'claude-code' }, draft.body);
    case 'mcp': {
      const line = draft.body.trim();
      const env = keepAll(draft.keptEnv);
      const target = URL_LINE.test(line)
        ? { url: line, ...(draft.oauth ? { auth: 'oauth' as const } : {}) }
        : (([command, ...words]) => {
            const { args } = mcpArguments(draft, words);
            const etag = etagFor(args, draft.wordsEtag);
            return {
              command: command as string,
              ...(args.length === 0 ? {} : { args: [...args] }),
              ...(etag === undefined ? {} : { argsEtag: etag }),
            };
          })(splitCommandLine(line));
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
      const flagsEtag = etagFor(draft.flags, draft.wordsEtag);
      return put({
        kind: 'settings',
        harness: draft.harness ?? 'claude-code',
        entries,
        ...(draft.flags.length === 0 ? {} : { flags: [...draft.flags] }),
        ...(flagsEtag === undefined ? {} : { flagsEtag }),
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
