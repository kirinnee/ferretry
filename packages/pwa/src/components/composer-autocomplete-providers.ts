/**
 * Daemon-bound candidate providers for the composer autocomplete engine.
 *
 * `/` merges harness-valid built-in commands with the exact session account's
 * discovered skills. A repeated `@` run selects one reference family: Files,
 * Agents, Tasks, Attention, then Pins. Every provider, candidate, cache key and
 * store callback carries the complete daemon/session scope; equal session ids
 * on two paired daemons are unrelated identities.
 */

import type { AttentionItem, Pin, SessionView, TaskSummary, TerminalListView } from '@ferretry/protocol';
import { taskReference } from '../features/tasks/task-board-model.ts';
import { TASK_STATUS_META } from '../features/tasks/task-presentation.ts';
import { agentReferenceIdentityKey, createAgentReferenceResolver } from '../lib/agent-references.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import { daemonRequest } from '../lib/daemon-transport.ts';
import { pinReferenceMarkdown } from '../lib/pin-links.ts';
import { resolvedPinReference } from '../lib/pin-reference-context.ts';
import { formatReference, parseReferenceToken } from '../lib/references.ts';
import { type DaemonFetch, DaemonResponseError } from '../lib/runtime-models.ts';
import { describeSurfaceOwnership, type SessionSurface, sessionSurfaces } from '../lib/surface-references.ts';
import { listSessionTerminals } from '../lib/web-terminals.ts';
import { rankSessions, recentSessions, type SessionEntry } from '../shell/palette-ranking.ts';
import { TERMINAL_STATUSES } from '../shell/status-mark.tsx';
import {
  COMPOSER_REFERENCE_TIERS,
  type ComposerAutocompleteCandidate,
  type ComposerAutocompleteProvider,
  type ComposerProviderResult,
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
type ComposerPinSummary = Pin;

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
}

export interface ComposerSkillsProviderOptions extends ComposerProviderScopeOptions {
  readonly harness?: ComposerHarness;
}

export interface ComposerReferenceProviderOptions extends ComposerProviderScopeOptions {
  /** Must return only the fleet slice belonging to `scope.daemonId`. */
  readonly getSessions?: ComposerScopedGetter<SessionView>;
  readonly getTasks?: ComposerScopedGetter<ComposerTaskSummary>;
  readonly getAttentionItems?: ComposerScopedGetter<ComposerAttentionItem>;
  readonly getPins?: ComposerScopedGetter<ComposerPinSummary>;
  readonly waitForTasks?: ComposerProviderWarmup;
  readonly waitForAttentionItems?: ComposerProviderWarmup;
  readonly waitForPins?: ComposerProviderWarmup;
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

export interface ComposerAutocompleteProvidersOptions extends ComposerReferenceProviderOptions {
  readonly harness?: ComposerHarness;
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
const EMPTY_PINS: readonly ComposerPinSummary[] = [];
const noSessions: ComposerScopedGetter<SessionView> = () => EMPTY_SESSIONS;
const noTasks: ComposerScopedGetter<ComposerTaskSummary> = () => EMPTY_TASKS;
const noAttention: ComposerScopedGetter<ComposerAttentionItem> = () => EMPTY_ATTENTION;
const noPins: ComposerScopedGetter<ComposerPinSummary> = () => EMPTY_PINS;

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
  fetcher: DaemonFetch = fetch,
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

const slashCatalogResult = (scope: DaemonSessionScope, catalog: ComposerSkillsCatalog): ComposerProviderResult => ({
  candidates: [
    ...commandCandidates(scope, catalog.harness),
    ...catalog.skills.map(
      (skill): ComposerAutocompleteCandidate => ({
        id: scopedId('skill', scope, skill.name),
        kind: 'skill',
        label: skill.name,
        detail: skill.description,
        group: 'Skills',
        replacement: skillInsertText(catalog.harness, skill.name),
        append: 'space',
      }),
    ),
  ],
  contextLabel: skillHarnessLabel(catalog.harness),
});

export function createSkillsProvider({
  daemon,
  scope,
  harness,
  fetcher = fetch,
}: ComposerSkillsProviderOptions): ComposerAutocompleteProvider {
  assertProviderScope(daemon, scope);
  const cache = new Map<string, ComposerSkillsCatalog>();
  const cacheKey = daemonSessionKey(scope);
  return {
    id: scopedId('slash', scope),
    trigger: '/',
    label: 'Commands & skills',
    initialCandidates: () => {
      const cached = cache.get(cacheKey);
      return cached ? slashCatalogResult(scope, cached) : commandsResult(scope, harness, 'Loading installed skills…');
    },
    async candidates({ signal }): Promise<ComposerProviderResult> {
      try {
        if (signal.aborted) throw abortReason(signal);
        const catalog = cache.get(cacheKey) ?? (await loadSkillsCatalog(daemon, scope, signal, fetcher));
        if (signal.aborted) throw abortReason(signal);
        cache.set(cacheKey, catalog);
        return slashCatalogResult(scope, catalog);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return commandsResult(
          scope,
          harness,
          `Installed skills unavailable: ${message}. Built-in commands still work.`,
        );
      }
    },
  };
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
  fetcher = fetch,
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

const pinCandidates = (
  scope: DaemonSessionScope,
  pins: readonly ComposerPinSummary[],
): ComposerAutocompleteCandidate[] =>
  pins.map(pin => {
    const reference = resolvedPinReference(scope, pin);
    const markdown = pinReferenceMarkdown(reference);
    const kind = pin.kind === 'message' ? 'Message pin' : 'Note pin';
    const provenance =
      pin.by === 'agent' ? (pin.createdByName ? `Pinned by ${pin.createdByName}` : 'Pinned by an agent') : '';
    return {
      id: scopedId('pin', scope, reference.pinId),
      kind: 'pin',
      label: markdown,
      detail: [kind, provenance].filter(Boolean).join(' · '),
      keywords: `${pin.id} ${reference.label} ${pin.kind} ${pin.createdByName ?? ''}`,
      group: 'Pins',
      badge: pin.kind,
      replacement: markdown,
      append: 'space',
    } satisfies ComposerAutocompleteCandidate;
  });

export function createReferencesProvider({
  daemon,
  scope,
  fetcher = fetch,
  getSessions = noSessions,
  getTasks = noTasks,
  getAttentionItems = noAttention,
  getPins = noPins,
  waitForTasks,
  waitForAttentionItems,
  waitForPins,
}: ComposerReferenceProviderOptions): ComposerAutocompleteProvider {
  assertProviderScope(daemon, scope);
  const files = createFilesProvider({ daemon, scope, fetcher });
  const scopeKey = daemonSessionKey(scope);
  let previousSessions: readonly SessionView[] | undefined;
  let previousTasks: readonly ComposerTaskSummary[] | undefined;
  let previousAttention: readonly ComposerAttentionItem[] | undefined;
  let previousPins: readonly ComposerPinSummary[] | undefined;
  let previousAgentIdentity: string | undefined;
  let snapshotToken: object = { scopeKey };

  const tierResult = (tier: number, query: string): ComposerProviderResult => {
    if (tier === 2)
      return {
        candidates: agentCandidates(scope, getSessions(scope), query),
        filterQuery: query,
        contextLabel: '@@ fleet agents',
      };
    if (tier === 3)
      return {
        candidates: taskCandidates(scope, getTasks(scope)),
        filterQuery: query,
        contextLabel: '@@@ fleet tasks',
      };
    if (tier === 4)
      return {
        candidates: attentionCandidates(scope, getAttentionItems(scope)),
        filterQuery: query,
        contextLabel: '@@@@ unresolved attention',
      };
    if (tier === 5) {
      const candidates = pinCandidates(scope, getPins(scope));
      return {
        candidates,
        filterQuery: query,
        contextLabel: '@@@@@ session pins',
        notice: candidates.length === 0 ? 'No proven pins are available for this session yet.' : undefined,
      };
    }
    return {
      candidates: [],
      filterQuery: query,
      contextLabel: `${'@'.repeat(Math.min(tier, 8))} has no reference family`,
      // The one place a reader who over-types `@` is already looking, so it is
      // also the cheapest place to teach that live surfaces have their own sigil.
      notice:
        'Use one to five @ signs. The legend above shows every available tier. For this session’s terminals, use %.',
    };
  };

  return {
    id: scopedId('references', scope),
    trigger: '@',
    label: 'References',
    legend: COMPOSER_REFERENCE_TIERS,
    get snapshotKey() {
      const sessions = getSessions(scope);
      const tasks = getTasks(scope);
      const attention = getAttentionItems(scope);
      const pins = getPins(scope);
      const agentIdentity = agentReferenceIdentityKey(scope.daemonId, sessions);
      if (
        sessions !== previousSessions ||
        tasks !== previousTasks ||
        attention !== previousAttention ||
        pins !== previousPins ||
        agentIdentity !== previousAgentIdentity
      ) {
        previousSessions = sessions;
        previousTasks = tasks;
        previousAttention = attention;
        previousPins = pins;
        previousAgentIdentity = agentIdentity;
        snapshotToken = { scopeKey, agentIdentity };
      }
      return snapshotToken;
    },
    reset: () => files.reset?.(),
    initialCandidates: context =>
      context.match.referenceTier === 1 ? undefined : tierResult(context.match.referenceTier ?? 0, context.query),
    async candidates(context): Promise<ComposerProviderResult> {
      const tier = context.match.referenceTier ?? 0;
      if (tier === 1) return await files.candidates(context);
      const warmup =
        tier === 3 ? waitForTasks : tier === 4 ? waitForAttentionItems : tier === 5 ? waitForPins : undefined;
      const pending = warmup?.(daemon, scope, context.signal);
      if (pending) await pending.catch(() => undefined);
      if (context.signal.aborted) throw abortReason(context.signal);
      return tierResult(tier, context.query);
    },
  };
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
  fetcher = fetch,
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
  const { daemon, scope, harness, fetcher, listTerminals } = options;
  return [
    createSkillsProvider({ daemon, scope, harness, fetcher }),
    createReferencesProvider(options),
    createSurfacesProvider({ daemon, scope, fetcher, ...(listTerminals === undefined ? {} : { listTerminals }) }),
  ];
}
