/**
 * Daemon-bound candidate providers for the composer autocomplete engine.
 *
 * Every family is reachable two ways, and both ways read ONE source. `/` merges
 * harness-valid built-in commands with the exact session account's discovered
 * skills, and `$` offers those same skills from the same catalog read. A
 * repeated `@` run selects one reference family — Files, Agents, Tasks,
 * Attention — and `:`, `&` and `!` open the last three of those directly, from
 * the same host getters the ladder reads. A second read would be a second
 * definition: a menu that offers `&F12` beside a transcript that cannot prove
 * it is exactly the disagreement this repository keeps finding.
 *
 * Every provider, candidate, cache key and store callback carries the complete
 * daemon/session scope; equal session ids on two paired daemons are unrelated
 * identities.
 */

import type { AttentionItem, SessionView, TaskSummary, TerminalListView } from '@ferretry/protocol';
import { taskReference } from '../features/tasks/task-board-model.ts';
import { TASK_STATUS_META } from '../features/tasks/task-presentation.ts';
import { agentReferenceIdentityKey, createAgentReferenceResolver } from '../lib/agent-references.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import { daemonRequest } from '../lib/daemon-transport.ts';
import { formatReference, parseReferenceToken } from '../lib/references.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from '../lib/runtime-models.ts';
import { describeSurfaceOwnership, type SessionSurface, sessionSurfaces } from '../lib/surface-references.ts';
import { listSessionTerminals } from '../lib/web-terminals.ts';
import { rankSessions, recentSessions, type SessionEntry } from '../shell/palette-ranking.ts';
import { TERMINAL_STATUSES } from '../shell/status-mark.tsx';
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
import { type FsListing, fsApi } from './files-api.ts';
import { entryRefusal, joinRel, normalizeRel } from './files-model.ts';

type ComposerHarness = 'claude' | 'codex';

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

export type ComposerTaskSummary = Pick<TaskSummary, 'id' | 'title' | 'status'>;
export type ComposerAttentionItem = Pick<AttentionItem, 'id' | 'subject' | 'source'>;

/** Exactly the facts the daemon's skills route reports. */
interface ComposerSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly scope?: 'global' | 'project';
  readonly origin?: 'claude' | 'codex' | 'both' | 'unknown';
}

interface ComposerSkillsResponse {
  readonly harness: ComposerHarness;
  readonly harnessHomeResolved?: boolean;
  readonly skills: readonly ComposerSkillSummary[];
}

/** Normalized catalog shared by autocomplete and any future full surface. */
export interface ComposerSkillsCatalog {
  readonly harness: ComposerHarness;
  readonly harnessHomeResolved?: boolean;
  readonly skills: readonly ComposerSkillSummary[];
}

type ComposerScopedGetter<Value> = (scope: DaemonSessionScope) => readonly Value[];
type ComposerProviderWarmup = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal: AbortSignal,
) => Promise<void> | undefined;

export interface ComposerProviderScopeOptions {
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly fetcher?: DaemonFetch;
  /** Which families may OFFER suggestions. Absent means all of them; a
   *  suppressed family still parses, proves and links what a reader authored. */
  readonly suggestions?: ComposerSuggestionSwitches;
}

/** One catalog per (daemon, session), shared by whichever skill sigils exist so
 *  `/` and `$` are one request rather than two. Deliberately not exported: it is
 *  named only by the option type below, and an exported alias nobody imports is
 *  dead surface the repo's own gate refuses. */
type ComposerSkillsCache = Map<string, ComposerSkillsCatalog>;

export interface ComposerSkillsProviderOptions extends ComposerProviderScopeOptions {
  readonly harness?: ComposerHarness;
  /**
   * A catalog the HOST already read, so a page that loads skills once for the
   * transcript's `/skill` resolver does not make the composer fetch them again.
   * `undefined` means "not read yet", never "there are none" — the provider
   * then warms and finally falls back to its own request, which is what keeps a
   * standalone Composer honest with no page around it.
   */
  readonly getSkills?: (scope: DaemonSessionScope) => ComposerSkillsCatalog | undefined;
  readonly waitForSkills?: ComposerProviderWarmup;
  /** Shared between the `/` and `$` providers of one composer. */
  readonly catalog?: ComposerSkillsCache;
}

export interface ComposerReferenceProviderOptions extends ComposerProviderScopeOptions {
  /** Must return only the fleet slice belonging to `scope.daemonId`. */
  readonly getSessions?: ComposerScopedGetter<SessionView>;
  readonly getTasks?: ComposerScopedGetter<ComposerTaskSummary>;
  readonly getAttentionItems?: ComposerScopedGetter<ComposerAttentionItem>;
  readonly waitForTasks?: ComposerProviderWarmup;
  readonly waitForAttentionItems?: ComposerProviderWarmup;
}

/** Injected so a test can drive the surfaces family without a live daemon; the
 *  default is the one authenticated terminal listing call. Deliberately not
 *  exported: it is named only by the option types below, and an exported alias
 *  nobody imports is dead surface the repo's own gate refuses. */
type ComposerTerminalLister = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch,
) => Promise<TerminalListView>;

export interface ComposerSurfacesProviderOptions extends ComposerProviderScopeOptions {
  readonly listTerminals?: ComposerTerminalLister;
}

export interface ComposerAutocompleteProvidersOptions
  extends ComposerReferenceProviderOptions, Omit<ComposerSkillsProviderOptions, 'catalog'> {
  readonly listTerminals?: ComposerTerminalLister;
}

/**
 * The one thing a row must not leave unsaid.
 *
 * A reader choosing between two shells is choosing whether to type into one an
 * agent is driving. The daemon attests who opened each, so the row says which —
 * and says "unrecorded" for a pane it carries no record of. Printing "you opened
 * this" in that case would be a guess that happens to be right most of the time,
 * which is worse than the absence.
 */
const SURFACE_PROVENANCE_NOTICE =
  'Ownership is what the daemon recorded when the terminal was opened; one it has no record for reads as unrecorded.';

const surfaceCandidate =
  (scope: DaemonSessionScope) =>
  (surface: SessionSurface): ComposerAutocompleteCandidate => ({
    id: scopedId('surface', scope, `${surface.surface}:${surface.key}`),
    kind: 'surface',
    label: surface.title,
    detail: [
      surface.token,
      surface.viewers === 1 ? '1 viewer' : `${surface.viewers} viewers`,
      describeSurfaceOwnership(surface.ownership).text.toLowerCase(),
    ].join(' · '),
    keywords: `${surface.key} ${surface.title} ${surface.surface}`,
    group: 'Surfaces',
    // Small, named, session-owned sets stay above anything fuzzier.
    rankPriority: 1,
    badge: surface.surface,
    replacement: surface.token,
    append: 'space',
  });

const EMPTY_SESSIONS: readonly SessionView[] = [];
const EMPTY_TASKS: readonly ComposerTaskSummary[] = [];
const EMPTY_ATTENTION: readonly ComposerAttentionItem[] = [];
const noSessions: ComposerScopedGetter<SessionView> = () => EMPTY_SESSIONS;
const noTasks: ComposerScopedGetter<ComposerTaskSummary> = () => EMPTY_TASKS;
const noAttention: ComposerScopedGetter<ComposerAttentionItem> = () => EMPTY_ATTENTION;

const assertProviderScope = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('composer scope must belong to the requested daemon');
  if (scope.sessionId.trim() === '') throw new Error('composer scope requires a session');
};

/** HTML-safe identity whose decoded payload is the canonical daemon/session tuple. */
const providerScopeIdentity = (scope: DaemonSessionScope): string => encodeURIComponent(daemonSessionKey(scope));

const scopedId = (kind: string, scope: DaemonSessionScope, local?: string): string =>
  `${kind}:${providerScopeIdentity(scope)}${local === undefined ? '' : `:${encodeURIComponent(local)}`}`;

const scopedCacheKey = (scope: DaemonSessionScope, local: string): string => `${daemonSessionKey(scope)}\u0000${local}`;

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { readonly name?: string })?.name === 'AbortError';

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const parseSkillsResponse = (value: unknown): ComposerSkillsResponse => {
  const root = asObject(value);
  const rows = root?.skills ?? [];
  if (!root || !Array.isArray(rows)) throw new DaemonResponseError(502, 'daemon returned an invalid skills catalog');

  const skills: ComposerSkillSummary[] = rows.map(row => {
    const item = asObject(row);
    const name = nonEmptyString(item?.name);
    if (!item || !name || typeof item.description !== 'string')
      throw new DaemonResponseError(502, 'daemon returned an invalid skill');
    const scope = item.scope;
    const origin = item.origin;
    if (scope !== undefined && scope !== 'global' && scope !== 'project')
      throw new DaemonResponseError(502, 'daemon returned an invalid skill scope');
    if (origin !== undefined && origin !== 'claude' && origin !== 'codex' && origin !== 'both' && origin !== 'unknown')
      throw new DaemonResponseError(502, 'daemon returned an invalid skill origin');
    return {
      name,
      description: item.description,
      ...(scope === undefined ? {} : { scope }),
      ...(origin === undefined ? {} : { origin }),
    };
  });

  // Older daemons did not constrain this field. Preserve the original safe
  // fallback: anything other than the one Codex fact uses Claude insertion.
  const harness: ComposerHarness = root.harness === 'codex' ? 'codex' : 'claude';
  return {
    harness,
    ...(typeof root.harnessHomeResolved === 'boolean' ? { harnessHomeResolved: root.harnessHomeResolved } : {}),
    skills,
  };
};

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

const skillsPath = (scope: DaemonSessionScope): string => `/v1/sessions/${encodeURIComponent(scope.sessionId)}/skills`;

const fallbackMessage = (status: number): string => {
  if (status === 401) return 'the daemon rejected this device credential';
  if (status === 403) return 'this paired device may not enumerate session skills';
  if (status === 404) return 'skill suggestions are unavailable on this daemon';
  return `HTTP ${status}`;
};

const skillsRequest = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal: AbortSignal,
  fetcher: DaemonFetch,
): Promise<ComposerSkillsResponse> => {
  assertProviderScope(daemon, scope);
  if (signal.aborted) throw abortReason(signal);
  const request = daemonRequest(daemon, skillsPath(scope), { signal });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { readonly error?: unknown; readonly code?: unknown };
    const message =
      typeof body.error === 'string' && body.error.trim() !== '' ? body.error : fallbackMessage(response.status);
    const code = typeof body.code === 'string' ? body.code : undefined;
    throw new DaemonResponseError(response.status, message, code);
  }
  return parseSkillsResponse(await response.json());
};

/** Fetch and normalize the exact daemon/session account's skill catalog. */
export async function loadSkillsCatalog(
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal: AbortSignal,
  fetcher: DaemonFetch = browserFetch,
): Promise<ComposerSkillsCatalog> {
  const response = await skillsRequest(daemon, scope, signal, fetcher);
  return {
    harness: response.harness,
    ...(response.harnessHomeResolved === undefined ? {} : { harnessHomeResolved: response.harnessHomeResolved }),
    skills: [...response.skills].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
  };
}

const commandCandidates = (scope: DaemonSessionScope, harness?: ComposerHarness): ComposerAutocompleteCandidate[] =>
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
  scope: DaemonSessionScope,
  harness?: ComposerHarness,
  notice?: string,
): ComposerProviderResult => ({
  candidates: commandCandidates(scope, harness),
  contextLabel: harness ? `${harness === 'codex' ? 'Codex' : 'Claude'} · commands use /name` : 'Built-in commands',
  notice,
});

const skillCandidates = (scope: DaemonSessionScope, catalog: ComposerSkillsCatalog): ComposerAutocompleteCandidate[] =>
  catalog.skills.map(skill => ({
    id: scopedId('skill', scope, skill.name),
    kind: 'skill',
    label: skill.name,
    detail: skill.description,
    group: 'Skills',
    // THE SIGIL THE READER TYPED IS NOT THE SIGIL THAT INVOKES. A picker inserts
    // what the harness accepts — `/name` on Claude, `$name` on Codex — because
    // an invocation the harness ignores is a broken offer, not a preserved
    // authoring choice. An AUTHORED `$name` is never rewritten; that rule is
    // about text a reader wrote, and this is text the picker is writing.
    replacement: skillInsertText(catalog.harness, skill.name),
    append: 'space',
  }));

/** `/` also carries the harness's built-in commands; `$` is skills only,
 *  because `$compact` invokes nothing on either harness. */
type ComposerSkillSigil = '/' | '$';

const catalogResult = (
  sigil: ComposerSkillSigil,
  scope: DaemonSessionScope,
  catalog: ComposerSkillsCatalog,
): ComposerProviderResult =>
  sigil === '/'
    ? {
        candidates: [...commandCandidates(scope, catalog.harness), ...skillCandidates(scope, catalog)],
        contextLabel: skillHarnessLabel(catalog.harness),
      }
    : {
        candidates: skillCandidates(scope, catalog),
        contextLabel: `$ skills · ${skillHarnessLabel(catalog.harness)}`,
      };

const skillsProviderFor = (
  sigil: ComposerSkillSigil,
  {
    daemon,
    scope,
    harness,
    fetcher = browserFetch,
    suggestions = DEFAULT_COMPOSER_SUGGESTIONS,
    getSkills,
    waitForSkills,
    catalog = new Map(),
  }: ComposerSkillsProviderOptions,
): ComposerAutocompleteProvider => {
  const cacheKey = daemonSessionKey(scope);
  const known = (): ComposerSkillsCatalog | undefined => getSkills?.(scope) ?? catalog.get(cacheKey);
  return {
    id: scopedId(sigil === '/' ? 'slash' : 'skill-sigil', scope),
    trigger: sigil,
    label: sigil === '/' ? 'Commands & skills' : 'Skills',
    // One predicate answers for both sigils: it is `$` that a switch governs,
    // and it says so itself, so `/` needs no exemption written here.
    shouldOpen: (match: ComposerTriggerMatch) => composerSuggestionsAllow(suggestions, match),
    get snapshotKey() {
      return getSkills?.(scope);
    },
    initialCandidates: () => {
      const cached = known();
      if (cached) return catalogResult(sigil, scope, cached);
      // `/` can answer instantly from its built-ins; `$` has nothing to show
      // until a catalog exists, so it reports loading rather than "no skills".
      return sigil === '/' ? commandsResult(scope, harness, 'Loading installed skills…') : undefined;
    },
    async candidates({ signal }): Promise<ComposerProviderResult> {
      try {
        if (signal.aborted) throw abortReason(signal);
        const pending = waitForSkills?.(daemon, scope, signal);
        if (pending) await pending.catch(() => undefined);
        if (signal.aborted) throw abortReason(signal);
        const supplied = getSkills?.(scope);
        if (supplied) return catalogResult(sigil, scope, supplied);
        const cached = catalog.get(cacheKey) ?? (await loadSkillsCatalog(daemon, scope, signal, fetcher));
        if (signal.aborted) throw abortReason(signal);
        catalog.set(cacheKey, cached);
        return catalogResult(sigil, scope, cached);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
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

export function createSkillsProvider(options: ComposerSkillsProviderOptions): ComposerAutocompleteProvider {
  assertProviderScope(options.daemon, options.scope);
  return skillsProviderFor('/', options);
}

/** `$` — the same catalog, the same insertion contract, one switch away from
 *  silent. `/` stays live whatever this switch says, so a skill is never
 *  unreachable; only the second way in is. */
export function createSkillSigilProvider(options: ComposerSkillsProviderOptions): ComposerAutocompleteProvider {
  assertProviderScope(options.daemon, options.scope);
  return skillsProviderFor('$', options);
}

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
  // An incomplete selector is intentional composer state. An invalid or
  // unsupported selector gets its own refusal rather than blaming the path.
  if (!selector.suffix || !selector.complete || !selector.valid || selector.unsupported) return true;
  return isCanonicalFileToken(`@${path}${selector.suffix}`, path);
};

const hasUnambiguousDirectoryToken = (path: string): boolean => {
  // A directory replacement deliberately ends in `/`, which is not a complete
  // reference. Probe a valid child token without claiming that child exists.
  const probePath = `${path}/${DIRECTORY_REFERENCE_PROBE}`;
  return hasUnambiguousPathToken(probePath);
};

export function createFilesProvider({
  daemon,
  scope,
  fetcher = browserFetch,
}: ComposerProviderScopeOptions): ComposerAutocompleteProvider {
  assertProviderScope(daemon, scope);
  const cache = new Map<string, FsListing>();
  return {
    id: scopedId('files', scope),
    trigger: '@',
    label: 'Files',
    // Files can change while the reader composes. The host calls reset after a
    // successful send so a later turn cannot reuse the preceding turn's tree.
    reset: () => cache.clear(),
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
      const key = scopedCacheKey(scope, directory);
      let listing = cache.get(key);
      if (!listing) {
        listing = await fsApi.list(daemon, scope, directory, signal, fetcher);
        if (signal.aborted) throw abortReason(signal);
        cache.set(key, listing);
      }
      const candidates = listing.entries.map((entry): ComposerAutocompleteCandidate => {
        const path = joinRel(directory, entry.name);
        const refusal = entryRefusal(entry) ?? undefined;
        const directoryEntry = entry.type === 'dir';
        const selectorRefusal =
          selector.unsupported === 'column'
            ? 'column selection is not part of the @file grammar'
            : !selector.valid
              ? 'line selection must use positive lines and an end at or after its start'
              : directoryEntry && selector.suffix
                ? 'line selection applies to files, not folders'
                : undefined;
        const referenceRefusal = (
          directoryEntry ? hasUnambiguousDirectoryToken(path) : hasUnambiguousFileToken(path, selector)
        )
          ? undefined
          : UNREPRESENTABLE_FILE_REFERENCE_REASON;
        const disabledReason = refusal ?? referenceRefusal ?? selectorRefusal;
        return {
          id: scopedId(directoryEntry ? 'directory' : 'file', scope, `${path}${directoryEntry ? '' : selector.suffix}`),
          kind: directoryEntry ? 'directory' : 'file',
          label: `${entry.name}${directoryEntry ? '' : selector.suffix}`,
          detail:
            disabledReason ??
            (directoryEntry ? 'Folder' : entry.type === 'symlink' ? 'Symlink' : `${path}${selector.suffix}`),
          keywords: path,
          group: 'Files',
          replacement: `@${path}${directoryEntry ? '/' : selector.suffix}`,
          append: directoryEntry || (selector.suffix && !selector.complete) ? 'none' : 'space',
          disabled: !!disabledReason,
          disabledReason,
        };
      });
      const lineHelp = selector.suffix
        ? selector.complete
          ? undefined
          : 'Finish the optional line selection (:LINE or :START-END).'
        : 'Optional: add :LINE or :START-END before accepting the file.';
      const bounded = listing.truncated ? '2,000 entries shown — enter a directory or refine this segment.' : undefined;
      const notice = [bounded, lineHelp].filter(Boolean).join(' ');
      return {
        candidates,
        filterQuery: leaf,
        contextLabel: directory ? `@${directory}/` : '@ session root',
        notice: notice || undefined,
      };
    },
  };
}

const MAX_AGENT_RESULTS = 8;
const TEAMMATE_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;

interface RankedAgentSession extends SessionEntry {
  readonly view: SessionView;
}

const activityAt = (view: SessionView): number => {
  const raw =
    view.state.lastActivityAt ??
    view.state.finishedAt ??
    view.state.startedAt ??
    view.config.updatedAt ??
    view.config.createdAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

const agentEntries = (sessions: readonly SessionView[]): RankedAgentSession[] =>
  sessions.flatMap(view => {
    const teammate = view.config.teammate?.trim().toLowerCase() ?? '';
    if (!TEAMMATE_NAME.test(teammate)) return [];
    const finished = TERMINAL_STATUSES.has(view.state.status);
    return [
      {
        id: view.config.id,
        teammate,
        task: view.config.name,
        label: view.config.label?.trim() ?? '',
        folder: view.config.cwd,
        activityAt: activityAt(view),
        active: !finished,
        finished,
        view,
      },
    ];
  });

const rankedAgents = (sessions: readonly SessionView[], query: string): RankedAgentSession[] => {
  const entries = agentEntries(sessions);
  if (!query) return recentSessions(entries, MAX_AGENT_RESULTS);
  // A completed exact-name duplicate must not jump above the live holder.
  const live = rankSessions(
    entries.filter(entry => !entry.finished),
    query,
    { limit: MAX_AGENT_RESULTS },
  );
  const finished = rankSessions(
    entries.filter(entry => entry.finished),
    query,
    { limit: MAX_AGENT_RESULTS },
  );
  return [...live, ...finished].slice(0, MAX_AGENT_RESULTS);
};

const agentCandidates = (
  scope: DaemonSessionScope,
  sessions: readonly SessionView[],
  query: string,
): ComposerAutocompleteCandidate[] => {
  const resolve = createAgentReferenceResolver(scope.daemonId, sessions);
  return rankedAgents(sessions, query).flatMap(({ view, teammate }) => {
    const target = resolve({ sessionId: view.config.id });
    if (!target || target.daemonId !== scope.daemonId) return [];
    const label = view.config.label?.trim() || 'no label';
    const task = view.config.name.trim() || 'No task title';
    const model = view.state.observedModel || view.config.model || view.config.modelHint;
    const account = view.config.agent;
    return [
      {
        id: scopedId('agent', scope, target.sessionId),
        kind: 'agent',
        label: teammate,
        detail: [label, task, [model, account].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
        keywords: [teammate, label, task, view.state.status, model, account, view.state.activity]
          .filter(Boolean)
          .join(' '),
        group: 'Agents',
        badge: view.state.status.replaceAll('_', ' '),
        replacement: formatReference({ kind: 'agent', name: target.name }),
        append: 'space',
      } satisfies ComposerAutocompleteCandidate,
    ];
  });
};

const taskCandidates = (
  scope: DaemonSessionScope,
  tasks: readonly ComposerTaskSummary[],
): ComposerAutocompleteCandidate[] =>
  tasks.map(task => {
    const reference = taskReference(task.id);
    return {
      id: scopedId('task', scope, task.id),
      kind: 'task',
      label: reference,
      detail: task.title,
      keywords: `${task.id} ${task.title} ${task.status}`,
      group: 'Tasks',
      badge: TASK_STATUS_META[task.status].label,
      replacement: reference,
      append: 'space',
    } satisfies ComposerAutocompleteCandidate;
  });

const attentionCandidates = (
  scope: DaemonSessionScope,
  items: readonly ComposerAttentionItem[],
): ComposerAutocompleteCandidate[] =>
  items.map(item => {
    const reference = formatReference({ kind: 'attention', id: item.id });
    return {
      id: scopedId('attention', scope, item.id),
      kind: 'attention',
      label: reference,
      detail: item.subject,
      keywords: `${item.id} ${item.subject} ${item.source}`,
      group: 'Attention',
      badge: item.source,
      replacement: reference,
      append: 'space',
    } satisfies ComposerAutocompleteCandidate;
  });

/**
 * The three store-backed families, projected once.
 *
 * The repeated-`@` ladder and the direct sigils are two ways into the SAME
 * three facts, so the projection is written here and read from both. Two
 * copies would drift exactly one way — a `&F12` offered by one menu and not
 * the other — and nothing would fail until a reader noticed.
 */
const agentsResult = (
  scope: DaemonSessionScope,
  sessions: readonly SessionView[],
  query: string,
  contextLabel: string,
): ComposerProviderResult => ({
  candidates: agentCandidates(scope, sessions, query),
  filterQuery: query,
  contextLabel,
});

const tasksResult = (
  scope: DaemonSessionScope,
  tasks: readonly ComposerTaskSummary[],
  query: string,
  contextLabel: string,
): ComposerProviderResult => ({ candidates: taskCandidates(scope, tasks), filterQuery: query, contextLabel });

const attentionResult = (
  scope: DaemonSessionScope,
  items: readonly ComposerAttentionItem[],
  query: string,
  contextLabel: string,
): ComposerProviderResult => ({ candidates: attentionCandidates(scope, items), filterQuery: query, contextLabel });

/** A stable token that changes only when one of the read sources does, so the
 *  engine re-asks a provider whose store moved and no other. */
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

export function createReferencesProvider({
  daemon,
  scope,
  fetcher = browserFetch,
  suggestions = DEFAULT_COMPOSER_SUGGESTIONS,
  getSessions = noSessions,
  getTasks = noTasks,
  getAttentionItems = noAttention,
  waitForTasks,
  waitForAttentionItems,
}: ComposerReferenceProviderOptions): ComposerAutocompleteProvider {
  assertProviderScope(daemon, scope);
  const files = createFilesProvider({ daemon, scope, fetcher });
  const track = snapshotTracker(daemonSessionKey(scope));

  const tierResult = (tier: number, query: string): ComposerProviderResult => {
    if (tier === 2) return agentsResult(scope, getSessions(scope), query, '@@ fleet agents');
    if (tier === 3) return tasksResult(scope, getTasks(scope), query, '@@@ fleet tasks');
    if (tier === 4) return attentionResult(scope, getAttentionItems(scope), query, '@@@@ unresolved attention');
    return {
      candidates: [],
      filterQuery: query,
      contextLabel: `${'@'.repeat(Math.min(tier, 8))} has no reference family`,
      // The one place a reader who over-types `@` is already looking, so it is
      // also the cheapest place to teach the two families that are not tiers:
      // live surfaces have their own sigil, and so does every tier below.
      notice:
        'Use one to four @ signs. The legend above shows every available tier, and each family also has its own sigil. For this session’s terminals, use %.',
    };
  };

  return {
    id: scopedId('references', scope),
    trigger: '@',
    label: 'References',
    legend: COMPOSER_REFERENCE_TIERS,
    shouldOpen: match => composerSuggestionsAllow(suggestions, match),
    get snapshotKey() {
      const sessions = getSessions(scope);
      return track([
        sessions,
        getTasks(scope),
        getAttentionItems(scope),
        agentReferenceIdentityKey(scope.daemonId, sessions),
      ]);
    },
    reset: () => files.reset?.(),
    initialCandidates: context =>
      context.match.referenceTier === 1 ? undefined : tierResult(context.match.referenceTier ?? 0, context.query),
    async candidates(context): Promise<ComposerProviderResult> {
      const tier = context.match.referenceTier ?? 0;
      if (tier === 1) return await files.candidates(context);
      const warmup = tier === 3 ? waitForTasks : tier === 4 ? waitForAttentionItems : undefined;
      const pending = warmup?.(daemon, scope, context.signal);
      if (pending) await pending.catch(() => undefined);
      if (context.signal.aborted) throw abortReason(context.signal);
      return tierResult(tier, context.query);
    },
  };
}

/**
 * `:` `&` `!` — the same three families, one keystroke instead of two to four.
 *
 * They exist because the tokens themselves start with these sigils: a reader
 * who has learned that a task is `&F12` should not have to learn `@@@` as well,
 * and an agent reading the same transcript writes `:zelda` rather than `@@`.
 * The ladder stays because it is DISCOVERABLE — one sigil, repeated, teaches
 * four families with a legend — while a direct sigil is what you use once you
 * know. Neither reads a store the other does not.
 */
export function createDirectReferenceProviders({
  daemon,
  scope,
  suggestions = DEFAULT_COMPOSER_SUGGESTIONS,
  getSessions = noSessions,
  getTasks = noTasks,
  getAttentionItems = noAttention,
  waitForTasks,
  waitForAttentionItems,
}: ComposerReferenceProviderOptions): ComposerAutocompleteProvider[] {
  assertProviderScope(daemon, scope);
  const scopeKey = daemonSessionKey(scope);
  const trackAgents = snapshotTracker(scopeKey);
  const trackTasks = snapshotTracker(scopeKey);
  const trackAttention = snapshotTracker(scopeKey);
  const allow = (match: ComposerTriggerMatch): boolean => composerSuggestionsAllow(suggestions, match);
  const warmed = async (
    warmup: ComposerProviderWarmup | undefined,
    signal: AbortSignal,
    result: () => ComposerProviderResult,
  ): Promise<ComposerProviderResult> => {
    const pending = warmup?.(daemon, scope, signal);
    if (pending) await pending.catch(() => undefined);
    if (signal.aborted) throw abortReason(signal);
    return result();
  };
  return [
    {
      id: scopedId('agents', scope),
      trigger: ':',
      label: 'Agents',
      shouldOpen: allow,
      get snapshotKey() {
        const sessions = getSessions(scope);
        return trackAgents([sessions, agentReferenceIdentityKey(scope.daemonId, sessions)]);
      },
      candidates: ({ query }) => agentsResult(scope, getSessions(scope), query, ': fleet agents'),
    },
    {
      id: scopedId('tasks', scope),
      trigger: '&',
      label: 'Tasks',
      shouldOpen: allow,
      get snapshotKey() {
        return trackTasks([getTasks(scope)]);
      },
      initialCandidates: ({ query }) => tasksResult(scope, getTasks(scope), query, '& fleet tasks'),
      candidates: ({ query, signal }) =>
        warmed(waitForTasks, signal, () => tasksResult(scope, getTasks(scope), query, '& fleet tasks')),
    },
    {
      id: scopedId('attention', scope),
      trigger: '!',
      label: 'Attention',
      shouldOpen: allow,
      get snapshotKey() {
        return trackAttention([getAttentionItems(scope)]);
      },
      initialCandidates: ({ query }) =>
        attentionResult(scope, getAttentionItems(scope), query, '! unresolved attention'),
      candidates: ({ query, signal }) =>
        warmed(waitForAttentionItems, signal, () =>
          attentionResult(scope, getAttentionItems(scope), query, '! unresolved attention'),
        ),
    },
  ];
}

/**
 * `%` — the surfaces this session owns, addressable by their daemon-issued ids.
 *
 * IT ASKS THE DAEMON ITSELF rather than taking a host getter, which is a
 * deliberate difference from the agent, task, attention and pin families. Those
 * read stores the host must wire up, and nothing wires them today, so they offer
 * an empty list in the shipped composer. A terminal listing is one authenticated
 * request away, so this family is honest the moment it is mounted.
 *
 * WHAT A ROW PROMISES. It offers exactly what the daemon listed: a real terminal,
 * with its title, how many viewers are attached right now (the co-control signal —
 * a reader can see they are about to share a shell) and how provenance stands.
 * The listing is cached per token like the files tree is, and `reset` clears it
 * after a send; a row that has since closed is a stale OFFER, never a false claim,
 * because the inserted reference is proved again by whoever renders it.
 */
export function createSurfacesProvider({
  daemon,
  scope,
  fetcher = browserFetch,
  listTerminals = listSessionTerminals,
}: ComposerSurfacesProviderOptions): ComposerAutocompleteProvider {
  assertProviderScope(daemon, scope);
  const cache = new Map<string, TerminalListView>();
  const cacheKey = daemonSessionKey(scope);
  return {
    id: scopedId('surfaces', scope),
    trigger: '%',
    label: 'Session surfaces',
    reset: () => cache.clear(),
    async candidates({ query, signal }): Promise<ComposerProviderResult> {
      if (signal.aborted) throw abortReason(signal);
      let listing = cache.get(cacheKey);
      if (!listing) {
        listing = await listTerminals(daemon, scope, fetcher);
        if (signal.aborted) throw abortReason(signal);
        cache.set(cacheKey, listing);
      }
      const surfaces = sessionSurfaces(scope, listing);
      return {
        candidates: surfaces.map(surfaceCandidate(scope)),
        filterQuery: query,
        contextLabel: '% session surfaces',
        notice:
          surfaces.length === 0
            ? 'This session has no open terminal to address yet. Open one from the Terminal pane.'
            : SURFACE_PROVENANCE_NOTICE,
      };
    },
  };
}

export function createComposerAutocompleteProviders(
  options: ComposerAutocompleteProvidersOptions,
): ComposerAutocompleteProvider[] {
  const { daemon, scope, fetcher, listTerminals } = options;
  // ONE catalog for both skill sigils. Two independent caches would answer the
  // same question with two requests, and — the part that would actually be
  // noticed — could answer it differently, since each would fail on its own.
  const skills: ComposerSkillsProviderOptions = { ...options, catalog: new Map() };
  return [
    createSkillsProvider(skills),
    createSkillSigilProvider(skills),
    createReferencesProvider(options),
    ...createDirectReferenceProviders(options),
    createSurfacesProvider({ daemon, scope, fetcher, ...(listTerminals === undefined ? {} : { listTerminals }) }),
  ];
}
