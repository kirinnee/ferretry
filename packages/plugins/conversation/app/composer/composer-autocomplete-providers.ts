/**
 * Daemon-bound candidate providers for the composer autocomplete engine.
 *
 * EVERY FAMILY IS READ FROM ONE SOURCE, the `reference.catalog` hook (lead decision Q6): the plugin that owns a
 * prefix provides its entries, and Conversation reads them back through its own route
 * (`composer-reference-catalogs.ts`). A prefix nobody provides answers no rows and no error.
 *
 * Every family is reachable two ways, and both ways read that ONE source. `/` merges harness-valid built-in commands
 * with the ferret's skills (`/` catalog), and `$` offers the skills of the `$` catalog. A repeated `@` run selects one
 * reference family — Files, Agents, Agenda, Tasks — and `:`, `!` and `&` open the last three of those directly, from
 * the same catalogs the ladder reads. A second read would be a second definition: a menu that offers `!A3` beside a
 * transcript that cannot prove it is exactly the disagreement this repository keeps finding.
 *
 * WHAT AN ENTRY MEANS, per prefix (`ReferenceCatalogEntry`): `token` is what follows the sigil — a card id (`F12`),
 * an ask id (`A3`), a skill name, an agent name, a terminal or page key, or a ferret-root-relative path (a folder's
 * path ends in `/`). `label` and `detail` are the row. `closed` is a known entry not on offer: done work, a finished
 * ferret, or a file that is listed but not served (its `detail` says why).
 *
 * Every provider, candidate and cache key carries the complete daemon/ferret scope; equal ferret ids on two paired
 * daemons are unrelated identities.
 */

import { formatReference, parseReferenceToken, type Reference } from '@ferretry/app';
import {
  REFERENCE_CATALOG_FILE_MAX_ENTRIES,
  type ReferenceCatalogEntry,
  type ReferenceCatalogPrefix,
  type WorkHit,
  type WorkKind,
} from '../../contract/index.ts';
import {
  COMPOSER_REFERENCE_TIERS,
  type ComposerAutocompleteCandidate,
  type ComposerAutocompleteProvider,
  type ComposerProviderResult,
  type ComposerSuggestionSwitches,
  type ComposerTriggerMatch,
  composerSuggestionsAllow,
  DEFAULT_COMPOSER_SUGGESTIONS,
} from './composer-autocomplete.ts';
import { type ComposerReferenceCatalogReader, readReferenceCatalog } from './composer-reference-catalogs.ts';
import { assertClientDaemon } from './seam-attachments.ts';
import {
  isWorkSearchWords,
  WORK_SEARCH_DEBOUNCE_MS,
  type WorkSearchPort,
  workProjectLabel,
} from '../search/work-search.ts';
import { type DaemonConnection, type DaemonFerretScope, daemonFerretKey } from './seam.ts';

export type ComposerHarness = 'claude' | 'codex';

interface ComposerBuiltinCommand {
  readonly name: string;
  readonly description: string;
  readonly harnesses: readonly ComposerHarness[];
}

/** Harness-native commands that exist independently of installed skills. */
const COMPOSER_BUILTIN_COMMANDS: readonly ComposerBuiltinCommand[] = [
  {
    name: 'compact',
    description: 'Summarise the conversation so far and free up context',
    harnesses: ['claude', 'codex'],
  },
];

/** How a provider waits for a host read already in flight; `undefined` is "nothing unread". */
type ComposerProviderWarmup = (
  daemon: DaemonConnection,
  scope: DaemonFerretScope,
  signal: AbortSignal,
) => Promise<void> | undefined;

/** A host that already reads some prefixes (the chat page, for proof): what it holds now, per prefix. */
type ComposerCatalogGetter = (prefix: ReferenceCatalogPrefix) => readonly ReferenceCatalogEntry[] | undefined;

export interface ComposerAutocompleteProvidersOptions {
  readonly daemon: DaemonConnection;
  readonly scope: DaemonFerretScope;
  /** The half's client. Absent, a provider reads nothing of its own (built-in commands still answer). */
  readonly client?: ComposerReferenceCatalogReader;
  /** Which families may OFFER suggestions. Absent means all of them; a suppressed family still parses and proves. */
  readonly suggestions?: ComposerSuggestionSwitches;
  /** The ferret's harness: how a picked skill is invoked. Absent inserts `/name`, as an unknown harness always did. */
  readonly harness?: ComposerHarness;
  /**
   * THE HOST'S CATALOGS. A prefix in `hostedPrefixes` is the host's fact: the provider reads it through `getCatalog`
   * (after `waitForCatalog`) and never asks the daemon a second time; `undefined` there is UNPROVED, said out loud,
   * never an invented empty list. Every other prefix the provider reads itself, cached until `reset`.
   */
  readonly getCatalog?: ComposerCatalogGetter;
  readonly waitForCatalog?: ComposerProviderWarmup;
  readonly hostedPrefixes?: readonly ReferenceCatalogPrefix[];
  /**
   * The menu's "Include agent cards" switch, read live. Off (the default): a card whose ask the owner did not make
   * (the catalog entry's `agentAsked`) is not offered, unless its id is typed exactly.
   */
  readonly getIncludeAgentTasks?: () => boolean;
  /**
   * The daemon's work search, read live; `undefined` keeps the menus local. When it answers, a typed WORD query on
   * the `@@@` and `@@@@` tiers also asks it, and its hits are merged under the catalog rows. The direct `!` and `&`
   * sigils only open on an id prefix, so they never carry words and never ask.
   */
  readonly getWorkSearch?: () => WorkSearchPort | undefined;
  /** Project id to name for the cards that search finds. */
  readonly getProjectNames?: () => ReadonlyMap<string, string> | undefined;
}

const assertProviderScope = (daemon: DaemonConnection, scope: DaemonFerretScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('composer scope must belong to the requested daemon');
  if (scope.ferretId.trim() === '') throw new Error('composer scope requires a ferret');
};

/** HTML-safe identity whose decoded payload is the canonical daemon/ferret tuple. */
const providerScopeIdentity = (scope: DaemonFerretScope): string => encodeURIComponent(daemonFerretKey(scope));

const scopedId = (kind: string, scope: DaemonFerretScope, local?: string): string =>
  `${kind}:${providerScopeIdentity(scope)}${local === undefined ? '' : `:${encodeURIComponent(local)}`}`;

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { readonly name?: string })?.name === 'AbortError';

const failureText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The canonical token of a reference, or `undefined` when an entry names something the grammar cannot write. */
const tokenOf = (reference: Reference): string | undefined => {
  try {
    return formatReference(reference);
  } catch {
    return undefined;
  }
};

const entryKeywords = (entry: ReferenceCatalogEntry): string =>
  [entry.token, entry.label, entry.detail ?? '', ...(entry.aliases ?? [])].filter(Boolean).join(' ');

// ─── the catalog source ───────────────────────────────────────────────────────────────────────────────────────────

interface CatalogSource {
  /** The entries for `prefix` (and `query`, for files), read or awaited; throws when the read failed. */
  read(prefix: ReferenceCatalogPrefix, signal: AbortSignal, query?: string): Promise<readonly ReferenceCatalogEntry[]>;
  /** What is already known without a read, or `undefined`. */
  known(prefix: ReferenceCatalogPrefix, query?: string): readonly ReferenceCatalogEntry[] | undefined;
  /** Whether the host owns `prefix` (then an unread answer is unproved, not ours to fetch). */
  hosted(prefix: ReferenceCatalogPrefix): boolean;
  reset(): void;
}

const NO_ENTRIES: readonly ReferenceCatalogEntry[] = Object.freeze([]);

/**
 * One cache per composer, shared by every provider, so `/` and `$`, the ladder and the direct sigils are one read
 * per prefix rather than one per menu. A read in flight is shared too.
 */
const catalogSource = (options: ComposerAutocompleteProvidersOptions): CatalogSource => {
  const { client, scope, getCatalog, waitForCatalog, daemon } = options;
  const hostedPrefixes = new Set(getCatalog === undefined ? [] : (options.hostedPrefixes ?? []));
  const cache = new Map<string, readonly ReferenceCatalogEntry[]>();
  const inFlight = new Map<string, Promise<readonly ReferenceCatalogEntry[]>>();
  const keyOf = (prefix: ReferenceCatalogPrefix, query?: string): string => `${prefix}\u0000${query ?? ''}`;
  return {
    hosted: prefix => hostedPrefixes.has(prefix),
    known: (prefix, query) => (hostedPrefixes.has(prefix) ? getCatalog?.(prefix) : cache.get(keyOf(prefix, query))),
    async read(prefix, signal, query) {
      if (signal.aborted) throw abortReason(signal);
      if (hostedPrefixes.has(prefix)) {
        const pending = waitForCatalog?.(daemon, scope, signal);
        if (pending) await pending.catch(() => undefined);
        if (signal.aborted) throw abortReason(signal);
        const supplied = getCatalog?.(prefix);
        if (supplied === undefined) throw new Error('not read for this ferret yet');
        return supplied;
      }
      const key = keyOf(prefix, query);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      if (client === undefined) return NO_ENTRIES;
      // A catalog read goes through ONE daemon's client: a scope naming another daemon would list that ferret's files here.
      assertClientDaemon(client, scope, 'reference catalog');
      let shared = inFlight.get(key);
      if (shared === undefined) {
        // The read is fenced by its OWN controller: a menu closing mid-read does not cancel the sibling that shares it.
        const controller = new AbortController();
        shared = readReferenceCatalog(client, scope.ferretId, prefix, controller.signal, query)
          .then(answer => {
            cache.set(key, answer.entries);
            return answer.entries;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, shared);
      }
      const entries = await shared;
      if (signal.aborted) throw abortReason(signal);
      return entries;
    },
    reset: () => cache.clear(),
  };
};

// ─── skills and commands ──────────────────────────────────────────────────────────────────────────────────────────

/** Claude invokes `/name`; Codex invokes `$name` (its `/skills` only browses). */
function skillInsertText(harness: ComposerHarness, name: string): string {
  return harness === 'codex' ? `$${name}` : `/${name}`;
}

function skillHarnessLabel(harness: ComposerHarness): string {
  return harness === 'codex' ? 'Codex · inserts $name' : 'Claude · inserts /name';
}

const COMPOSER_HARNESSES: readonly ComposerHarness[] = ['claude', 'codex'];

/** With no harness fact yet, expose only commands supported by every harness. */
function builtinCommandsForHarness(harness?: ComposerHarness): readonly ComposerBuiltinCommand[] {
  return COMPOSER_BUILTIN_COMMANDS.filter(command =>
    harness ? command.harnesses.includes(harness) : COMPOSER_HARNESSES.every(item => command.harnesses.includes(item)),
  );
}

const commandCandidates = (scope: DaemonFerretScope, harness?: ComposerHarness): ComposerAutocompleteCandidate[] =>
  builtinCommandsForHarness(harness).map(command => ({
    id: scopedId('command', scope, command.name),
    kind: 'command',
    label: command.name,
    detail: command.description,
    group: 'Commands',
    replacement: `/${command.name}`,
    append: 'space',
  }));

const commandsResult = (
  scope: DaemonFerretScope,
  harness?: ComposerHarness,
  notice?: string,
): ComposerProviderResult => ({
  candidates: commandCandidates(scope, harness),
  contextLabel: harness ? `${harness === 'codex' ? 'Codex' : 'Claude'} · commands use /name` : 'Built-in commands',
  notice,
});

const SKILL_NAME = /^[a-z0-9][a-z0-9:_-]*$/iu;

const skillCandidates = (
  scope: DaemonFerretScope,
  entries: readonly ReferenceCatalogEntry[],
  harness: ComposerHarness,
): ComposerAutocompleteCandidate[] =>
  [...entries]
    .filter(entry => entry.closed !== true && SKILL_NAME.test(entry.token))
    .sort((a, b) => a.token.localeCompare(b.token, undefined, { sensitivity: 'base' }))
    .map(entry => ({
      id: scopedId('skill', scope, entry.token),
      kind: 'skill',
      label: entry.token,
      ...(entry.detail === undefined && entry.label === '' ? {} : { detail: entry.detail ?? entry.label }),
      keywords: entryKeywords(entry),
      group: 'Skills',
      // THE SIGIL THE READER TYPED IS NOT THE SIGIL THAT INVOKES. A picker inserts what the harness accepts — `/name`
      // on Claude, `$name` on Codex — because an invocation the harness ignores is a broken offer. An AUTHORED `$name`
      // is never rewritten; that rule is about text a reader wrote, and this is text the picker is writing.
      replacement: skillInsertText(harness, entry.token),
      append: 'space',
    }));

/** `/` also carries the harness's built-in commands; `$` is skills only, because `$compact` invokes nothing. */
type ComposerSkillSigil = '/' | '$';

const catalogResult = (
  sigil: ComposerSkillSigil,
  scope: DaemonFerretScope,
  entries: readonly ReferenceCatalogEntry[],
  harness: ComposerHarness | undefined,
): ComposerProviderResult => {
  const inserting = harness ?? 'claude';
  return sigil === '/'
    ? {
        candidates: [...commandCandidates(scope, harness), ...skillCandidates(scope, entries, inserting)],
        contextLabel: skillHarnessLabel(inserting),
      }
    : {
        candidates: skillCandidates(scope, entries, inserting),
        contextLabel: `$ skills · ${skillHarnessLabel(inserting)}`,
      };
};

/** A host-owned catalog nobody could read: an offer that is missing, said out loud. */
const unprovedSkillsResult = (
  sigil: ComposerSkillSigil,
  scope: DaemonFerretScope,
  harness?: ComposerHarness,
): ComposerProviderResult => {
  const notice =
    'Installed skills have not been read for this ferret yet. Skills can still be typed, and /name still works.';
  return sigil === '/' ? commandsResult(scope, harness, notice) : { candidates: [], contextLabel: '$ skills', notice };
};

const skillsProviderFor = (
  sigil: ComposerSkillSigil,
  options: ComposerAutocompleteProvidersOptions,
  source: CatalogSource,
): ComposerAutocompleteProvider => {
  const { scope, harness, suggestions = DEFAULT_COMPOSER_SUGGESTIONS } = options;
  return {
    id: scopedId(sigil === '/' ? 'slash' : 'skill-sigil', scope),
    trigger: sigil,
    label: sigil === '/' ? 'Commands & skills' : 'Skills',
    shouldOpen: (match: ComposerTriggerMatch) => composerSuggestionsAllow(suggestions, match),
    get snapshotKey() {
      return source.hosted(sigil) ? source.known(sigil) : undefined;
    },
    initialCandidates: () => {
      const cached = source.known(sigil);
      if (cached) return catalogResult(sigil, scope, cached, harness);
      // `/` can answer instantly from its built-ins; `$` has nothing to show until a catalog exists.
      return sigil === '/' ? commandsResult(scope, harness, 'Loading installed skills…') : undefined;
    },
    async candidates({ signal }): Promise<ComposerProviderResult> {
      try {
        const entries = await source.read(sigil, signal);
        return catalogResult(sigil, scope, entries, harness);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        // A HOST THAT OWNS THIS FACT and has not read it: unproved, never a second request for the same catalog.
        if (source.hosted(sigil)) return unprovedSkillsResult(sigil, scope, harness);
        const message = failureText(error);
        return sigil === '/'
          ? commandsResult(scope, harness, `Installed skills unavailable: ${message}. Built-in commands still work.`)
          : {
              candidates: [],
              contextLabel: '$ skills',
              notice: `Installed skills unavailable: ${message}. Skills can still be typed, and /name still works.`,
            };
      }
    },
  };
};

// ─── files ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A ferret-root-relative path with `.` and empty segments removed and `..` resolved inside the root. */
const normalizeRel = (input: string | null | undefined): string => {
  if (!input) return '';
  const out: string[] = [];
  for (const part of String(input).split(/[/\\]/)) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
};

/** A path query is a lazy directory request plus a fuzzy final segment. */
export function splitFileQuery(query: string): { directory: string; leaf: string } {
  const slash = query.lastIndexOf('/');
  if (slash < 0) return { directory: '', leaf: query };
  return { directory: normalizeRel(query.slice(0, slash)), leaf: query.slice(slash + 1) };
}

interface ComposerFileSelector {
  /** Canonical suffix, including its leading colon. Empty means plain @path. */
  readonly suffix: string;
  readonly complete: boolean;
  readonly valid: boolean;
  readonly unsupported?: 'column';
}

export interface ComposerFileReferenceQuery {
  readonly directory: string;
  readonly leaf: string;
  readonly selector: ComposerFileSelector;
}

const EMPTY_FILE_SELECTOR: ComposerFileSelector = { suffix: '', complete: true, valid: true };
const COLON_FILE_SELECTOR = /^(.*?):([0-9]*)(?:(:)([0-9]*)|(-)([0-9]*))?$/u;
const HASH_FILE_SELECTOR = /^(.*?)#L([0-9]*)(?:-L?([0-9]*))?$/iu;
/** PATH_MAX-sized ceiling before a query can become repeated ranking work. */
export const MAX_FILE_REFERENCE_QUERY_LENGTH = 4_096;
const UNREPRESENTABLE_FILE_REFERENCE_REASON =
  'cannot be inserted as @file — this path has no unambiguous reference token';
const FILE_REFERENCE_QUERY_TOO_LONG_NOTICE =
  'File reference queries are limited to 4,096 characters; shorten the path before searching.';
const DIRECTORY_REFERENCE_PROBE = 'ferretry-reference-probe';
/** The most files one directory answer carries: today's bound (`REFERENCE_CATALOG_FILE_MAX_ENTRIES`). */
const FILE_LISTING_BOUND = REFERENCE_CATALOG_FILE_MAX_ENTRIES;

const selectorNumber = (value: string): number | null => {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};

/** Strip an optional line/range selector before the lazy directory lookup. */
export function splitFileReferenceQuery(query: string): ComposerFileReferenceQuery {
  const hash = HASH_FILE_SELECTOR.exec(query);
  const colon = hash ? null : COLON_FILE_SELECTOR.exec(query);
  const match = hash ?? colon;
  if (!match || !(match[1] ?? '')) return { ...splitFileQuery(query), selector: EMPTY_FILE_SELECTOR };

  const pathQuery = match[1] ?? '';
  const lineText = match[2] ?? '';
  const separator = hash ? (match[3] === undefined ? '' : '-') : (match[3] ?? match[5] ?? '');
  const tailText = hash ? (match[3] ?? '') : (match[4] ?? match[6] ?? '');
  const line = selectorNumber(lineText);
  const tail = tailText ? selectorNumber(tailText) : null;
  const complete = lineText.length > 0 && (!separator || tailText.length > 0);
  const valid =
    (!lineText || line !== null) &&
    (!tailText || tail !== null) &&
    (separator !== '-' || line === null || tail === null || tail >= line);
  const canonicalSeparator = separator === ':' ? ':' : separator ? '-' : '';
  const unsupported = !hash && separator === ':' ? 'column' : undefined;
  return {
    ...splitFileQuery(pathQuery),
    selector: {
      suffix: `:${lineText}${canonicalSeparator}${tailText}`,
      complete,
      valid,
      ...(unsupported === undefined ? {} : { unsupported }),
    },
  };
}

/** Prove that authored bytes preserve the exact filesystem path and location. */
const isCanonicalFileToken = (token: string, path: string): boolean => {
  const reference = parseReferenceToken(token);
  return reference?.kind === 'file' && reference.path === path && formatReference(reference) === token;
};

const hasUnambiguousPathToken = (path: string): boolean => {
  const reference = parseReferenceToken(`@${path}`);
  return (
    reference?.kind === 'file' &&
    reference.path === path &&
    reference.line === undefined &&
    reference.endLine === undefined
  );
};

const hasUnambiguousFileToken = (path: string, selector: ComposerFileSelector): boolean => {
  if (!hasUnambiguousPathToken(path)) return false;
  // An incomplete selector is intentional composer state. An invalid or unsupported selector gets its own refusal.
  if (!selector.suffix || !selector.complete || !selector.valid || selector.unsupported) return true;
  return isCanonicalFileToken(`@${path}${selector.suffix}`, path);
};

const hasUnambiguousDirectoryToken = (path: string): boolean =>
  // A directory replacement deliberately ends in `/`, which is not a complete reference. Probe a valid child token
  // without claiming that child exists.
  hasUnambiguousPathToken(`${path}/${DIRECTORY_REFERENCE_PROBE}`);

const fileCandidate = (
  scope: DaemonFerretScope,
  entry: ReferenceCatalogEntry,
  selector: ComposerFileSelector,
): ComposerAutocompleteCandidate | undefined => {
  const directoryEntry = entry.token.endsWith('/');
  const path = normalizeRel(entry.token);
  if (path === '') return undefined;
  const name = path.slice(path.lastIndexOf('/') + 1);
  // A listed entry that is not served (denylisted, gitignored, a symlink): its owner says why in `detail`.
  const refusal = entry.closed === true ? (entry.detail ?? 'listed only, not served') : undefined;
  const selectorRefusal =
    selector.unsupported === 'column'
      ? 'column selection is not part of the @file grammar'
      : !selector.valid
        ? 'line selection must use positive lines and an end at or after its start'
        : directoryEntry && selector.suffix
          ? 'line selection applies to files, not folders'
          : undefined;
  const referenceRefusal = (
    directoryEntry
      ? hasUnambiguousDirectoryToken(path)
      : hasUnambiguousFileToken(path, selector)
  )
    ? undefined
    : UNREPRESENTABLE_FILE_REFERENCE_REASON;
  const disabledReason = refusal ?? referenceRefusal ?? selectorRefusal;
  return {
    id: scopedId(directoryEntry ? 'directory' : 'file', scope, `${path}${directoryEntry ? '' : selector.suffix}`),
    kind: directoryEntry ? 'directory' : 'file',
    label: `${entry.label || name}${directoryEntry ? '' : selector.suffix}`,
    detail: disabledReason ?? (directoryEntry ? 'Folder' : (entry.detail ?? `${path}${selector.suffix}`)),
    keywords: path,
    group: 'Files',
    replacement: `@${path}${directoryEntry ? '/' : selector.suffix}`,
    append: directoryEntry || (selector.suffix && !selector.complete) ? 'none' : 'space',
    disabled: !!disabledReason,
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
};

/** Only the direct children of `directory`: a provider that answers deeper paths does not widen the menu. */
const childOf = (directory: string, entry: ReferenceCatalogEntry): boolean => {
  const path = normalizeRel(entry.token);
  const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  return parent === directory;
};

const filesProvider = (scope: DaemonFerretScope, source: CatalogSource): ComposerAutocompleteProvider => ({
  id: scopedId('files', scope),
  trigger: '@',
  label: 'Files',
  // Files can change while the reader composes. The host calls reset after a successful send.
  reset: () => source.reset(),
  async candidates({ query, signal }): Promise<ComposerProviderResult> {
    if (signal.aborted) throw abortReason(signal);
    if (query.length > MAX_FILE_REFERENCE_QUERY_LENGTH)
      return {
        candidates: [],
        filterQuery: '',
        contextLabel: '@ file path',
        notice: FILE_REFERENCE_QUERY_TOO_LONG_NOTICE,
      };
    const { directory, leaf, selector } = splitFileReferenceQuery(query);
    const entries = (await source.read('@', signal, directory)).filter(entry => childOf(directory, entry));
    const candidates = entries.flatMap(entry => fileCandidate(scope, entry, selector) ?? []);
    const lineHelp = selector.suffix
      ? selector.complete
        ? undefined
        : 'Finish the optional line selection (:LINE or :START-END).'
      : 'Optional: add :LINE or :START-END before accepting the file.';
    const bounded =
      entries.length >= FILE_LISTING_BOUND
        ? `${FILE_LISTING_BOUND.toLocaleString('en-US')} entries shown — enter a directory or refine this segment.`
        : undefined;
    const notice = [bounded, lineHelp].filter(Boolean).join(' ');
    return {
      candidates,
      filterQuery: leaf,
      contextLabel: directory ? `@${directory}/` : '@ ferret root',
      notice: notice || undefined,
    };
  },
});

// ─── agents, agenda, tasks ────────────────────────────────────────────────────────────────────────────────────────

const MAX_AGENT_RESULTS = 8;

/** Live ferrets first, finished ones after, each in the order the owner listed them (most recent first). */
const agentCandidates = (
  scope: DaemonFerretScope,
  entries: readonly ReferenceCatalogEntry[],
): ComposerAutocompleteCandidate[] =>
  [...entries.filter(entry => entry.closed !== true), ...entries.filter(entry => entry.closed === true)].flatMap(
    entry => {
      const replacement = tokenOf({ kind: 'agent', name: entry.token });
      if (replacement === undefined) return [];
      return [
        {
          id: scopedId('agent', scope, entry.token.toLowerCase()),
          kind: 'agent',
          label: entry.token.toLowerCase(),
          detail: [entry.label, entry.detail ?? ''].filter(Boolean).join(' · '),
          keywords: entryKeywords(entry),
          group: 'Agents',
          ...(entry.closed === true ? { badge: 'finished' } : {}),
          replacement,
          append: 'space',
        } satisfies ComposerAutocompleteCandidate,
      ];
    },
  );

const agendaCandidates = (
  scope: DaemonFerretScope,
  entries: readonly ReferenceCatalogEntry[],
): ComposerAutocompleteCandidate[] =>
  entries.flatMap(entry => {
    if (entry.closed === true) return [];
    const reference = tokenOf({ kind: 'attention', id: entry.token });
    if (reference === undefined) return [];
    return [
      {
        id: scopedId('attention', scope, entry.token),
        kind: 'attention',
        label: reference,
        detail: entry.label,
        keywords: entryKeywords(entry),
        group: 'Asks',
        ...(entry.detail === undefined ? {} : { badge: entry.detail }),
        replacement: reference,
        append: 'space',
      } satisfies ComposerAutocompleteCandidate,
    ];
  });

/** A project holds dozens of open cards the owner may mean; the menu shows the best of them and the query narrows it. */
const MAX_TASK_RESULTS = 50;

const TASK_MENU_LABELS: ReadonlySet<string> = new Set(['Cards', '& cards']);

/** Whether an open list is the task menu, the only one "Include agent cards" applies to. */
export const isTaskMenuLabel = (label: string | undefined): boolean =>
  label !== undefined && TASK_MENU_LABELS.has(label);

/**
 * Closed work (done, dropped) is hidden until the reader types its id exactly: a finished card is rarely the one
 * being referenced, and ten of them above the live ones would bury the menu's purpose. The board's own order (active
 * first, then most recently touched) is kept.
 *
 * The same holds for a card whose ask the owner did not make (another ferret's, the Warden's, an automatic card):
 * the menu offers what the owner asked for, unless the reader turns "Include agent cards" on.
 */
const taskCandidates = (
  scope: DaemonFerretScope,
  entries: readonly ReferenceCatalogEntry[],
  query: string,
  includeAgentCards: boolean,
): ComposerAutocompleteCandidate[] => {
  const typed = query.toUpperCase();
  return entries
    .filter(
      entry =>
        entry.token.toUpperCase() === typed ||
        (entry.closed !== true && (includeAgentCards || entry.agentAsked !== true)),
    )
    .flatMap(entry => {
      const reference = tokenOf({ kind: 'task', id: entry.token });
      if (reference === undefined) return [];
      return [
        {
          id: scopedId('task', scope, entry.token.toUpperCase()),
          kind: 'task',
          label: reference,
          detail: [entry.label, entry.detail ?? ''].filter(Boolean).join(' · '),
          keywords: entryKeywords(entry),
          group: 'Cards',
          ...(entry.closed === true ? { badge: 'closed' } : {}),
          replacement: reference,
          append: 'space',
        } satisfies ComposerAutocompleteCandidate,
      ];
    });
};

// ─── work search merge ────────────────────────────────────────────────────────────────────────────────────────────

/** The most hits one picker merge asks the daemon for. */
const WORK_PICKER_LIMIT = 20;

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** A card the daemon found by its words: the same row a catalog card is, with its standing as the trailing chip. */
const cardHitCandidate = (
  scope: DaemonFerretScope,
  hit: Extract<WorkHit, { kind: 'card' }>,
  projectNames: ReadonlyMap<string, string> | undefined,
): ComposerAutocompleteCandidate | undefined => {
  const reference = tokenOf({ kind: 'task', id: hit.id });
  if (reference === undefined) return undefined;
  return {
    id: scopedId('task', scope, hit.id.toUpperCase()),
    kind: 'task',
    label: reference,
    detail: [hit.title, workProjectLabel(hit.project, projectNames)].filter(part => part !== '').join(' · '),
    group: 'Cards',
    badge: hit.standing,
    rankPriority: -1,
    prematched: true,
    replacement: reference,
    append: 'space',
  };
};

/** An ask the daemon found by its words: the same row a catalog ask is, with its standing as the chip. */
const askHitCandidate = (
  scope: DaemonFerretScope,
  hit: Extract<WorkHit, { kind: 'ask' }>,
): ComposerAutocompleteCandidate | undefined => {
  const reference = tokenOf({ kind: 'attention', id: hit.id });
  if (reference === undefined) return undefined;
  return {
    id: scopedId('attention', scope, hit.id),
    kind: 'attention',
    label: reference,
    detail: hit.title,
    group: 'Asks',
    badge: hit.standing,
    rankPriority: -1,
    prematched: true,
    replacement: reference,
    append: 'space',
  };
};

/**
 * Catalog rows first, then what the daemon found by the typed WORDS.
 *
 * - Only for words: an empty query or the start of an id keeps the instant list, and so does a machine that cannot
 *   search or a search that fails — the menu never gets worse for asking.
 * - A card is open work only: the menu offers what is live, as the catalog list does.
 * - An ask is this ferret's only: `!A3` is proved against THIS ferret's asks, so another ferret's `A3` would insert a
 *   reference nothing can prove.
 * - A row the catalog list already has wins.
 */
const withWorkHits = async (
  base: ComposerProviderResult,
  context: { readonly query: string; readonly signal: AbortSignal },
  kind: WorkKind,
  scope: DaemonFerretScope,
  port: WorkSearchPort | undefined,
  projectNames: ReadonlyMap<string, string> | undefined,
): Promise<ComposerProviderResult> => {
  if (port === undefined || !isWorkSearchWords(context.query)) return base;
  await sleepUnlessAborted(WORK_SEARCH_DEBOUNCE_MS, context.signal);
  let hits: readonly WorkHit[];
  try {
    hits = (await port.search({ q: context.query, kind, open: true, limit: WORK_PICKER_LIMIT }, context.signal)).hits;
  } catch {
    if (context.signal.aborted) throw abortReason(context.signal);
    return base;
  }
  if (context.signal.aborted) throw abortReason(context.signal);
  const known = new Set(base.candidates.map(candidate => candidate.id));
  const found = hits.flatMap(hit => {
    if (hit.kind !== kind) return [];
    if (hit.kind === 'ask') return hit.ferret === scope.ferretId ? (askHitCandidate(scope, hit) ?? []) : [];
    return cardHitCandidate(scope, hit, projectNames) ?? [];
  });
  const fresh = found.filter(candidate => !known.has(candidate.id));
  return fresh.length === 0 ? base : { ...base, candidates: [...base.candidates, ...fresh] };
};

/**
 * A stable token that changes only when one of the read sources does, so the engine re-asks a provider whose catalog
 * moved and no other.
 */
const snapshotTracker = (scopeKey: string) => {
  let previous: readonly unknown[] = [];
  let token: object = { scopeKey };
  return (sources: readonly unknown[]): object => {
    if (sources.length !== previous.length || sources.some((source, index) => source !== previous[index])) {
      previous = sources;
      token = { scopeKey, sources };
    }
    return token;
  };
};

// ─── the reference families, projected once ───────────────────────────────────────────────────────────────────────

type ReferenceFamily = ':' | '!' | '&';

const FAMILY_LABELS: Readonly<Record<ReferenceFamily, { readonly ladder: string; readonly direct: string }>> = {
  ':': { ladder: 'Agents', direct: ': fleet agents' },
  '!': { ladder: 'Asks', direct: '! open asks' },
  '&': { ladder: 'Cards', direct: '& cards' },
};

const familyResult = (
  family: ReferenceFamily,
  scope: DaemonFerretScope,
  entries: readonly ReferenceCatalogEntry[],
  query: string,
  contextLabel: string,
  includeAgentCards: boolean,
): ComposerProviderResult => {
  if (family === ':')
    return { candidates: agentCandidates(scope, entries), filterQuery: query, limit: MAX_AGENT_RESULTS, contextLabel };
  if (family === '!') return { candidates: agendaCandidates(scope, entries), filterQuery: query, contextLabel };
  return {
    candidates: taskCandidates(scope, entries, query, includeAgentCards),
    filterQuery: query,
    limit: MAX_TASK_RESULTS,
    contextLabel,
  };
};

/** What a family whose read failed says: the reference can still be typed, it just is not offered. */
const unreadFamilyResult = (contextLabel: string, query: string, error: unknown): ComposerProviderResult => ({
  candidates: [],
  filterQuery: query,
  contextLabel,
  notice: `Not read for this ferret: ${failureText(error)}. A reference can still be typed.`,
});

/**
 * One family's answer, shared by the ladder and the direct sigil so the two cannot drift.
 *
 * A FAMILY STILL BEING READ IS UNKNOWN, NOT EMPTY: `initial` answers only from what is already known, so the engine
 * shows `loading` until the read arrives rather than an empty list presented as fact.
 */
const familyAnswers = (
  scope: DaemonFerretScope,
  source: CatalogSource,
  includeAgentCards: () => boolean = () => false,
) => ({
  initial: (family: ReferenceFamily, query: string, contextLabel: string): ComposerProviderResult | undefined => {
    const known = source.known(family);
    return known === undefined
      ? undefined
      : familyResult(family, scope, known, query, contextLabel, includeAgentCards());
  },
  read: async (
    family: ReferenceFamily,
    query: string,
    contextLabel: string,
    signal: AbortSignal,
  ): Promise<ComposerProviderResult> => {
    try {
      return familyResult(family, scope, await source.read(family, signal), query, contextLabel, includeAgentCards());
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      return unreadFamilyResult(contextLabel, query, error);
    }
  },
});

const TIER_FAMILY: Readonly<Record<number, ReferenceFamily>> = { 2: ':', 3: '!', 4: '&' };

export function createReferencesProvider(
  options: ComposerAutocompleteProvidersOptions,
  source: CatalogSource = catalogSource(options),
): ComposerAutocompleteProvider {
  const { daemon, scope, suggestions = DEFAULT_COMPOSER_SUGGESTIONS } = options;
  assertProviderScope(daemon, scope);
  const files = filesProvider(scope, source);
  const families = familyAnswers(scope, source, () => options.getIncludeAgentTasks?.() === true);
  const track = snapshotTracker(daemonFerretKey(scope));
  const overTyped = (tier: number, query: string): ComposerProviderResult => ({
    candidates: [],
    filterQuery: query,
    contextLabel: `${'@'.repeat(Math.min(tier, 8))} has no reference family`,
    // The one place a reader who over-types `@` is already looking, so it is also the cheapest place to teach the
    // family that is not a tier: live surfaces have their own sigil.
    notice: 'Use one to four @ signs. The legend above shows every available tier. For this ferret’s terminals, use %.',
  });
  return {
    id: scopedId('references', scope),
    trigger: '@',
    label: 'References',
    legend: COMPOSER_REFERENCE_TIERS,
    shouldOpen: match => composerSuggestionsAllow(suggestions, match),
    get snapshotKey() {
      return track([
        source.known(':'),
        source.known('!'),
        source.known('&'),
        options.getIncludeAgentTasks?.(),
        options.getWorkSearch?.(),
        options.getProjectNames?.(),
      ]);
    },
    reset: () => files.reset?.(),
    initialCandidates: context => {
      const tier = context.match.referenceTier ?? 0;
      // Tier 1 is the filesystem, which is always read.
      if (tier === 1) return undefined;
      const family = TIER_FAMILY[tier];
      if (family === undefined) return overTyped(tier, context.query);
      return families.initial(family, context.query, FAMILY_LABELS[family].ladder);
    },
    async candidates(context): Promise<ComposerProviderResult> {
      const tier = context.match.referenceTier ?? 0;
      if (tier === 1) return await files.candidates(context);
      const family = TIER_FAMILY[tier];
      if (family === undefined) return overTyped(tier, context.query);
      const local = await families.read(family, context.query, FAMILY_LABELS[family].ladder, context.signal);
      if (family === ':') return local;
      return await withWorkHits(
        local,
        context,
        family === '!' ? 'ask' : 'card',
        scope,
        options.getWorkSearch?.(),
        options.getProjectNames?.(),
      );
    },
  };
}

/**
 * `:` `!` `&` — the same three families, one keystroke instead of two to four.
 *
 * They exist because the tokens themselves start with these sigils: a reader who has learned that an ask is `!A3`
 * should not have to learn `@@@` as well. The ladder stays because it is DISCOVERABLE — one sigil, repeated, teaches
 * four families with a legend — while a direct sigil is what you use once you know. Neither reads a catalog the other
 * does not.
 */
export function createDirectReferenceProviders(
  options: ComposerAutocompleteProvidersOptions,
  source: CatalogSource = catalogSource(options),
): ComposerAutocompleteProvider[] {
  const { daemon, scope, suggestions = DEFAULT_COMPOSER_SUGGESTIONS } = options;
  assertProviderScope(daemon, scope);
  const allow = (match: ComposerTriggerMatch): boolean => composerSuggestionsAllow(suggestions, match);
  const families = familyAnswers(scope, source, () => options.getIncludeAgentTasks?.() === true);
  const direct = (family: ReferenceFamily, id: string): ComposerAutocompleteProvider => ({
    id: scopedId(id, scope),
    trigger: family,
    label: FAMILY_LABELS[family].ladder,
    shouldOpen: allow,
    get snapshotKey() {
      return source.known(family);
    },
    initialCandidates: ({ query }) => families.initial(family, query, FAMILY_LABELS[family].direct),
    candidates: ({ query, signal }) => families.read(family, query, FAMILY_LABELS[family].direct, signal),
  });
  return [direct(':', 'agents'), direct('!', 'attention'), direct('&', 'task')];
}

// ─── surfaces ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one thing a row must not leave unsaid. A reader choosing between two shells is choosing whether to type into
 * one an agent is driving; the owner's `detail` says who opened each, and one it has no record for reads as
 * unrecorded — never as "you opened this".
 */
const SURFACE_PROVENANCE_NOTICE =
  'Ownership is what the daemon recorded when the terminal was opened; one it has no record for reads as unrecorded.';

const SURFACE_PREFIXES = [
  ['%terminal', 'terminal'],
  ['%browser', 'browser'],
] as const;

const surfaceCandidates = (
  scope: DaemonFerretScope,
  surface: 'terminal' | 'browser',
  entries: readonly ReferenceCatalogEntry[],
): ComposerAutocompleteCandidate[] =>
  entries.flatMap(entry => {
    if (entry.closed === true) return [];
    const replacement = tokenOf({ kind: 'surface', surface, key: entry.token });
    if (replacement === undefined) return [];
    return [
      {
        id: scopedId('surface', scope, `${surface}:${entry.token}`),
        kind: 'surface',
        label: entry.label || entry.token,
        detail: [replacement, entry.detail ?? ''].filter(Boolean).join(' · '),
        keywords: `${entryKeywords(entry)} ${surface}`,
        group: 'Surfaces',
        // Small, named, ferret-owned sets stay above anything fuzzier.
        rankPriority: 1,
        badge: surface,
        replacement,
        append: 'space',
      } satisfies ComposerAutocompleteCandidate,
    ];
  });

/**
 * `%` — the surfaces this ferret owns, addressable by their owners' ids (Terminals' `%terminal`, Browsers'
 * `%browser`). Both are read when the menu opens and cached until `reset` (after a send); a row that has since closed
 * is a stale OFFER, never a false claim, because the inserted reference is proved again by whoever renders it.
 */
export function createSurfacesProvider(
  options: ComposerAutocompleteProvidersOptions,
  source: CatalogSource = catalogSource(options),
): ComposerAutocompleteProvider {
  const { daemon, scope } = options;
  assertProviderScope(daemon, scope);
  return {
    id: scopedId('surfaces', scope),
    trigger: '%',
    label: 'Ferret surfaces',
    reset: () => source.reset(),
    async candidates({ query, signal }): Promise<ComposerProviderResult> {
      const answers = await Promise.allSettled(
        SURFACE_PREFIXES.map(async ([prefix, surface]) =>
          surfaceCandidates(scope, surface, await source.read(prefix, signal)),
        ),
      );
      if (signal.aborted) throw abortReason(signal);
      const candidates = answers.flatMap(answer => (answer.status === 'fulfilled' ? answer.value : []));
      const failed = answers.find(answer => answer.status === 'rejected');
      if (failed !== undefined && candidates.length === 0 && answers.every(answer => answer.status === 'rejected'))
        throw failed.reason;
      return {
        candidates,
        filterQuery: query,
        contextLabel: '% ferret surfaces',
        notice:
          candidates.length === 0
            ? 'This ferret has no open terminal to address yet. Open one from the Terminal pane.'
            : SURFACE_PROVENANCE_NOTICE,
      };
    },
  };
}

export function createSkillsProvider(
  options: ComposerAutocompleteProvidersOptions,
  source: CatalogSource = catalogSource(options),
): ComposerAutocompleteProvider {
  assertProviderScope(options.daemon, options.scope);
  return skillsProviderFor('/', options, source);
}

/** `$` — the same insertion contract, one switch away from silent. `/` stays live whatever this switch says. */
export function createSkillSigilProvider(
  options: ComposerAutocompleteProvidersOptions,
  source: CatalogSource = catalogSource(options),
): ComposerAutocompleteProvider {
  assertProviderScope(options.daemon, options.scope);
  return skillsProviderFor('$', options, source);
}

/** Every provider of one composer, over ONE catalog source: one read per prefix, however many menus ask. */
export function createComposerAutocompleteProviders(
  options: ComposerAutocompleteProvidersOptions,
): ComposerAutocompleteProvider[] {
  assertProviderScope(options.daemon, options.scope);
  const source = catalogSource(options);
  return [
    createSkillsProvider(options, source),
    createSkillSigilProvider(options, source),
    createReferencesProvider(options, source),
    ...createDirectReferenceProviders(options, source),
    createSurfacesProvider(options, source),
  ];
}

/** `@` files alone (tier 1 of the ladder), over its own catalog source unless one is shared. */
export function createFilesProvider(
  options: ComposerAutocompleteProvidersOptions,
  source: CatalogSource = catalogSource(options),
): ComposerAutocompleteProvider {
  assertProviderScope(options.daemon, options.scope);
  return filesProvider(options.scope, source);
}
