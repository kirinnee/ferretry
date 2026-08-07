/**
 * Current-session file and task search (handover #6).
 *
 * kteam has no matching surface to port: its FilesTab has no name/path search
 * and SessionTasks has no task-prose search.  This module therefore keeps one
 * explicitly daemon-scoped search model and exposes the same visible control
 * to the app bar, Tasks, and Files.  Task summaries deliberately omit the
 * description, original ask, and clarifications, so a usable search reads each
 * task detail rather than silently pretending the summaries are complete.
 */

import {
  FY_REQUEST_ID_HEADER,
  ScopedTaskDetailResponseSchema,
  ScopedTaskSummarySchema,
  type ScopedTaskView,
  ScopedTaskViewSchema,
  type TaskSummary,
} from '@ferretry/protocol';
import { LoaderCircle, Search, TriangleAlert } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type FsListing, fsApi } from '../../components/files-api.ts';
import { SessionTaskKanban, SessionTaskList } from '../../components/session-tasks.tsx';
import { taskReference } from '../../features/tasks/task-board-model.ts';
import { TaskQuickSummary } from '../../features/tasks/task-row.tsx';
import { useInputModality } from '../../hooks/use-input-modality.ts';
import { useLayoutMode } from '../../hooks/use-layout-mode.ts';
import { addReferenceMessage, addReferenceToComposer } from '../../lib/composer-references.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { nextActiveIndex, paletteCountLabel } from '../../shell/palette-model.ts';
import { type FuzzyField, scoreFields } from '../../shell/palette-ranking.ts';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from '../../shell/palette-shortcut.ts';

export type SessionSearchResourceState = 'loading' | 'ready' | 'unavailable';

export interface SessionSearchFile {
  readonly kind: 'file';
  readonly path: string;
  readonly name: string;
}

interface SessionSearchTask {
  readonly kind: 'task';
  readonly task: ScopedTaskView;
}

export type SessionSearchResult = SessionSearchFile | SessionSearchTask;

export interface SessionSearchOpeners {
  readonly openFile: (path: string) => void;
  readonly openTasks: () => void;
}

interface SearchSnapshot {
  readonly taskState: SessionSearchResourceState;
  readonly fileState: SessionSearchResourceState;
  readonly taskError: string | null;
  readonly fileError: string | null;
  readonly tasks: readonly ScopedTaskView[];
  readonly files: readonly SessionSearchFile[];
}

const INITIAL: SearchSnapshot = {
  taskState: 'loading',
  fileState: 'loading',
  taskError: null,
  fileError: null,
  tasks: [],
  files: [],
};

/**
 * A snapshot CARRIES the session it describes.
 *
 * The snapshot used to be a bare piece of state cleared by the load effect. That
 * made the scope prop and the evidence two facts with two update schedules: a
 * render published the new scope immediately while the effect that clears the
 * old evidence is passive, so one committed render paired daemon beta's scope
 * with daemon alpha's ready task list. Everything downstream then read that pair
 * as the truth — the reference surface proved `&F6` against a session that has
 * no F6, and an Add to chat or Mark Done fired in that window addressed beta
 * with a task it took from alpha.
 *
 * Keying it makes the mismatch unrepresentable rather than merely brief: the
 * render derives INITIAL whenever the stored key is not the key being rendered,
 * so "we have not read THIS session yet" is a synchronous consequence of the
 * scope rather than the outcome of an effect that has not run.
 */
interface KeyedSnapshot {
  /** `daemonSessionKey(scope)`, or `''` for no scope — never a real key. */
  readonly key: string;
  readonly snapshot: SearchSnapshot;
}

/** The key a scope's evidence is filed under. `null` gets one no scope can equal. */
const snapshotKey = (scope: DaemonSessionScope | null): string => (scope === null ? '' : daemonSessionKey(scope));

const taskText = (task: ScopedTaskView): string =>
  [
    task.id,
    task.title,
    task.description,
    task.ask.text,
    ...task.clarifications.map(clarification => clarification.text),
  ]
    .join('\n')
    .toLocaleLowerCase();

export const matchesSessionSearch = (value: string, query: string): boolean =>
  value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

/**
 * How many rows the popup presents at once.
 *
 * The palette caps its session rows at eight for the reason stated in
 * `palette-ranking.ts`: a surface that can show forty rows is a list view with a
 * text box on top. This popup mixes two kinds, so it is a little taller — and
 * the count it is hiding is always printed, because a silently truncated result
 * set is indistinguishable from a complete one.
 */
export const MAX_SESSION_SEARCH_RESULTS = 12;

/**
 * What each field is worth when ordering matches.
 *
 * NOT `palette-ranking.ts`'s `FIELD_WEIGHTS`: that table is session-shaped
 * (teammate, label, folder) and these are files and tasks. The ALGORITHM is
 * single-sourced — `scoreFields` and its word-start/substring/subsequence ladder
 * are imported, not re-derived — while the weights are this surface's own, which
 * is the "two legitimate input domains need two named things" split rather than
 * a second copy of one decision.
 *
 * A name outranks a path, and prose ranks below both: a reader typing `auth`
 * wants `auth.ts` before a task whose description mentions authentication.
 */
const SESSION_SEARCH_WEIGHTS = {
  fileName: 3,
  taskTitle: 3,
  filePath: 1.2,
  /** Ids only answer to an anchored query; see `FuzzyField.anchored`. */
  taskId: 1,
  taskProse: 0.8,
} as const;

const taskFields = (task: ScopedTaskView): readonly FuzzyField[] => [
  { value: task.title, weight: SESSION_SEARCH_WEIGHTS.taskTitle },
  { value: task.id, weight: SESSION_SEARCH_WEIGHTS.taskId, anchored: true },
  { value: task.description, weight: SESSION_SEARCH_WEIGHTS.taskProse },
  { value: task.ask.text, weight: SESSION_SEARCH_WEIGHTS.taskProse },
  ...task.clarifications.map(clarification => ({
    value: clarification.text,
    weight: SESSION_SEARCH_WEIGHTS.taskProse,
  })),
];

const fileFields = (file: SessionSearchFile): readonly FuzzyField[] => [
  { value: file.name, weight: SESSION_SEARCH_WEIGHTS.fileName },
  { value: file.path, weight: SESSION_SEARCH_WEIGHTS.filePath },
];

const resultFields = (result: SessionSearchResult): readonly FuzzyField[] =>
  result.kind === 'file' ? fileFields(result) : taskFields(result.task);

/** Stable within one result set, and distinct across two mounts of one control. */
export const sessionSearchResultKey = (result: SessionSearchResult): string =>
  result.kind === 'file' ? `file:${result.path}` : `task:${result.task.id}`;

/**
 * Ranked, and with EXACTLY the membership the substring rule already produced.
 *
 * Ordering is layered on top of matching rather than replacing it: `scoreFields`
 * answers 0 whenever a term matches no single field, and the membership rule
 * matches across the joined haystack, so a scored-only list would silently drop
 * rows that used to be found. A zero-scored member therefore keeps its place at
 * the end in its original order, and the sort is stable, so two equal scores
 * stay tasks-then-files exactly as before.
 */
export const filterSessionSearchResults = (
  tasks: readonly ScopedTaskView[],
  files: readonly SessionSearchFile[],
  query: string,
): readonly SessionSearchResult[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const members: readonly SessionSearchResult[] = [
    ...tasks.filter(task => taskText(task).includes(normalized)).map(task => ({ kind: 'task' as const, task })),
    ...files.filter(file => matchesSessionSearch(`${file.name}\n${file.path}`, normalized)),
  ];
  return members
    .map((result, index) => ({ result, index, score: scoreFields(resultFields(result), query) }))
    .sort((left, right) => (right.score === left.score ? left.index - right.index : right.score - left.score))
    .map(entry => entry.result);
};

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const taskPath = (scope: DaemonSessionScope): string => `/v1/sessions/${encodeURIComponent(scope.sessionId)}/tasks`;

/** Optimistic state has the same daemon/session identity as the task it shadows. */
const taskOverlayKey = (scope: DaemonSessionScope, taskId: string): string =>
  JSON.stringify([scope.daemonId, scope.sessionId, taskId]);

const readJson = async <Value,>(daemon: DaemonConnection, path: string, signal: AbortSignal): Promise<Value> => {
  const target = daemonRequest(daemon, path, { signal });
  const response = await fetch(target.url, target.init);
  if (!response.ok) throw new Error(`The daemon could not read current-session search data (HTTP ${response.status}).`);
  return (await response.json()) as Value;
};

const readTasks = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal: AbortSignal,
): Promise<readonly ScopedTaskView[]> => {
  const listing = (await readJson(daemon, taskPath(scope), signal)) as {
    tasks?: unknown;
  };
  if (!Array.isArray(listing.tasks)) throw new Error('The daemon returned an unreadable task list.');
  const summaries = listing.tasks.map((candidate, index) => {
    const parsed = ScopedTaskSummarySchema.safeParse(candidate);
    if (!parsed.success) throw new Error(`The daemon returned an unreadable task summary at position ${index + 1}.`);
    if (parsed.data.sessionId !== scope.sessionId) throw new Error('The daemon returned a task from another session.');
    return parsed.data;
  });
  return await Promise.all(
    summaries.map(async summary => {
      const detail = ScopedTaskDetailResponseSchema.safeParse(
        await readJson(daemon, `${taskPath(scope)}/${encodeURIComponent(summary.id)}`, signal),
      );
      if (!detail.success) throw new Error(`The daemon returned unreadable detail for task ${summary.id}.`);
      if (detail.data.sessionId !== scope.sessionId || detail.data.task.sessionId !== scope.sessionId)
        throw new Error('The daemon returned task detail from another session.');
      // The detail response permits `null` for a fleet read; this is a scoped
      // endpoint we just proved, so normalize the carried identity to its
      // exact daemon/session scope before it reaches the shared model.
      return { ...detail.data.task, sessionId: scope.sessionId };
    }),
  );
};

const joinPath = (directory: string, name: string): string => (directory ? `${directory}/${name}` : name);

const readFiles = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal: AbortSignal,
): Promise<readonly SessionSearchFile[]> => {
  const queue = [''];
  const visited = new Set<string>();
  const files: SessionSearchFile[] = [];
  while (queue.length > 0) {
    if (signal.aborted) throw signal.reason;
    const directory = queue.shift() as string;
    if (visited.has(directory)) continue;
    visited.add(directory);
    const listing: FsListing = await fsApi.list(daemon, scope, directory, signal);
    if (listing.truncated) throw new Error('The daemon returned an incomplete file listing.');
    for (const entry of listing.entries) {
      const path = joinPath(directory, entry.name);
      if (entry.type === 'dir') queue.push(path);
      else if (entry.type === 'file') files.push({ kind: 'file', name: entry.name, path });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

interface SessionSearchContextValue extends SearchSnapshot {
  readonly connection: DaemonConnection;
  readonly active: boolean;
  readonly scope: DaemonSessionScope | null;
  readonly query: string;
  /** Ranked and capped to {@link MAX_SESSION_SEARCH_RESULTS}. */
  readonly results: readonly SessionSearchResult[];
  /** How many matched before the cap, so the popup can say what it is hiding. */
  readonly resultTotal: number;
  readonly focusSignal: number;
  /** The task read already in flight for `scope`, or nothing once it settled. */
  readonly waitForTasks: () => Promise<void> | undefined;
  /**
   * Which mount currently PRESENTS the popup, or `null` for none.
   *
   * The query is shared by every mount, and it also drives the Tasks list's own
   * filter. Two mounts rendering a popup from one query is what the app bar and
   * the open Files pane did; dismissal therefore has to release PRESENTATION
   * rather than clear the query, or dismissing the app bar's popup would
   * silently unfilter the Tasks list nobody touched.
   */
  readonly presenting: string | null;
  readonly activeIndex: number;
  readonly setQuery: (query: string) => void;
  readonly setActiveIndex: (index: number) => void;
  readonly present: (instanceId: string) => void;
  readonly dismiss: (instanceId: string) => void;
  readonly setOpeners: (openers: SessionSearchOpeners | null) => void;
  readonly openResult: (result: SessionSearchResult) => void;
}

const SessionSearchContext = createContext<SessionSearchContextValue | null>(null);

export function useSessionSearch(): SessionSearchContextValue {
  const value = useContext(SessionSearchContext);
  if (value === null) throw new Error('SessionSearchProvider is required for current-session search.');
  return value;
}

export function SessionSearchProvider({
  connection,
  scope,
  focusSignal,
  children,
}: {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope | null;
  readonly focusSignal: number;
  readonly children: ReactNode;
}) {
  const [stored, setStored] = useState<KeyedSnapshot>({ key: '', snapshot: INITIAL });
  const [query, setQueryState] = useState('');
  const [presenting, setPresenting] = useState<string | null>(null);
  // Identity, not position: task and file reads settle independently and a
  // newly ranked row may be inserted before the reader's active result. An
  // index would then make Enter open a different result than the one still
  // highlighted a moment earlier.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const openers = useRef<SessionSearchOpeners | null>(null);
  const key = snapshotKey(scope);
  const currentKey = useRef(key);
  const taskPending = useRef<{ readonly key: string; readonly promise: Promise<void> } | null>(null);
  currentKey.current = key;
  const waitForTasks = useCallback((): Promise<void> | undefined => {
    const held = taskPending.current;
    return held?.key === currentKey.current ? held.promise : undefined;
  }, []);
  // DERIVED, not cleared. Evidence filed under another session is not this
  // session's evidence, and this is the line that says so during the very render
  // that publishes the new scope.
  const snapshot = stored.key === key ? stored.snapshot : INITIAL;

  // Every async completion publishes to the key that STARTED it, and builds on
  // that key's own snapshot — never on whatever happens to be stored. A read
  // that finishes after the reader moved on can therefore only ever write under
  // the session it asked about.
  const publish = useCallback((forKey: string, update: (current: SearchSnapshot) => SearchSnapshot): void => {
    setStored(current => ({
      key: forKey,
      snapshot: update(current.key === forKey ? current.snapshot : INITIAL),
    }));
  }, []);

  // A new query is a new list; start at the top of it. Owned here rather than in
  // the control, because every mount reads one query and they must agree on
  // which row is active.
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setActiveKey(null);
  }, []);

  useEffect(() => {
    setQueryState('');
    // The popup and its active row belong to the query that opened them, so a
    // session change closes both rather than pointing a live selection at
    // another session's evidence.
    setPresenting(null);
    setActiveKey(null);
    if (scope === null) return;
    const controller = new AbortController();
    // No `setStored(INITIAL)` here: the loading state for a session this
    // provider has not read yet is already what `snapshot` derives above, and
    // writing it would be a second, later answer to the same question.
    const forKey = daemonSessionKey(scope);
    const taskRead = readTasks(connection, scope, controller.signal).then(
      tasks => {
        if (!controller.signal.aborted)
          publish(forKey, current => ({ ...current, taskState: 'ready', taskError: null, tasks }));
      },
      reason => {
        if (!controller.signal.aborted)
          publish(forKey, current => ({
            ...current,
            taskState: 'unavailable',
            taskError: failureMessage(reason),
            tasks: [],
          }));
      },
    );
    const pending = { key: forKey, promise: taskRead };
    taskPending.current = pending;
    void taskRead.finally(() => {
      if (taskPending.current === pending) taskPending.current = null;
    });
    void readFiles(connection, scope, controller.signal).then(
      files => {
        if (!controller.signal.aborted)
          publish(forKey, current => ({ ...current, fileState: 'ready', fileError: null, files }));
      },
      reason => {
        if (!controller.signal.aborted)
          publish(forKey, current => ({
            ...current,
            fileState: 'unavailable',
            fileError: failureMessage(reason),
            files: [],
          }));
      },
    );
    return () => {
      controller.abort();
      if (taskPending.current === pending) taskPending.current = null;
    };
  }, [connection, publish, scope]);

  const setOpeners = useCallback((next: SessionSearchOpeners | null) => {
    openers.current = next;
  }, []);
  const openResult = useCallback((result: SessionSearchResult) => {
    if (result.kind === 'file') openers.current?.openFile(result.path);
    else openers.current?.openTasks();
  }, []);
  const present = useCallback((instanceId: string) => setPresenting(instanceId), []);
  // Only the mount that is presenting may dismiss: a blur handler racing another
  // mount's focus handler would otherwise close the popup that just opened.
  const dismiss = useCallback(
    (instanceId: string) => setPresenting(current => (current === instanceId ? null : current)),
    [],
  );
  const ranked = useMemo(() => filterSessionSearchResults(snapshot.tasks, snapshot.files, query), [query, snapshot]);
  const results = useMemo(() => ranked.slice(0, MAX_SESSION_SEARCH_RESULTS), [ranked]);
  const activeIndex = useMemo(() => {
    if (activeKey === null) return 0;
    const preserved = results.findIndex(result => sessionSearchResultKey(result) === activeKey);
    return preserved < 0 ? 0 : preserved;
  }, [activeKey, results]);
  const setActiveIndex = useCallback(
    (index: number) => setActiveKey(results[index] === undefined ? null : sessionSearchResultKey(results[index])),
    [results],
  );
  const value = useMemo<SessionSearchContextValue>(
    () => ({
      ...snapshot,
      connection,
      active: scope !== null,
      scope,
      query,
      results,
      resultTotal: ranked.length,
      presenting,
      activeIndex,
      focusSignal,
      waitForTasks,
      setQuery,
      setActiveIndex,
      present,
      dismiss,
      setOpeners,
      openResult,
    }),
    [
      activeIndex,
      connection,
      dismiss,
      focusSignal,
      openResult,
      present,
      presenting,
      query,
      ranked.length,
      results,
      scope,
      setActiveIndex,
      setOpeners,
      setQuery,
      snapshot,
      waitForTasks,
    ],
  );
  return <SessionSearchContext.Provider value={value}>{children}</SessionSearchContext.Provider>;
}

/**
 * What a resource that is not READY is called, in the reader's terms.
 *
 * "Indexing" rather than "searching": before a query is typed this control is
 * walking the session's tree and reading its board, and calling that searching
 * described an activity that had not started. An unavailable half is named as
 * unavailable, never folded into the empty state — a failed index and a genuine
 * no-match answer the same question with opposite meanings. Only the evidence
 * still moving is named because the two reads settle independently.
 */
const indexingCopy = (taskState: SessionSearchResourceState, fileState: SessionSearchResourceState): string =>
  taskState === 'loading'
    ? fileState === 'loading'
      ? "Indexing this session's files and tasks…"
      : "Indexing this session's tasks…"
    : "Indexing this session's files…";

/**
 * Both halves' state, said in one sentence, with the ready half left out and
 * the daemon's own reason carried through.
 *
 * A bare "Tasks unavailable." tells a reader that something is wrong and
 * nothing about what — and the reason is the only part they can act on.
 */
const unavailableCopy = (
  taskState: SessionSearchResourceState,
  fileState: SessionSearchResourceState,
  taskError: string | null,
  fileError: string | null,
): string =>
  [
    [taskState === 'unavailable' ? 'Tasks unavailable.' : '', taskError],
    [fileState === 'unavailable' ? 'Files unavailable.' : '', fileError],
  ]
    .map(([copy, reason]) =>
      copy ? (reason ? `${copy.slice(0, -1)}: ${reason.trim().replace(/[.!?]*$/u, '.')}` : copy) : '',
    )
    .filter(Boolean)
    .join(' ');

/**
 * How long a settled result count waits before it is announced.
 *
 * The same 300ms the palette uses, and for the same reason its own constant
 * states: a fast typist should hear one settled count, not a stream of
 * intermediate ones.
 */
export const SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS = 300;

/**
 * The DOM id of one row, scoped to the mount that drew it.
 *
 * `aria-activedescendant` is an IDREF, so the value may not contain whitespace —
 * and a session file path legitimately can. Percent-encoding the key keeps the
 * id derived from the RESULT (two renders of one query agree) rather than from
 * render order, while staying a legal IDREF.
 */
const resultDomId = (instanceId: string, result: SessionSearchResult): string =>
  `${instanceId}-${encodeURIComponent(sessionSearchResultKey(result))}`;

/**
 * One component, three mounts: the app bar, Tasks, and Files share its query and results.
 *
 * COMBOBOX, NOT A LIST OF BUTTONS. Focus stays in the text box for the whole
 * interaction and the active row is pointed at with `aria-activedescendant`,
 * which is the pattern `shell/command-palette.tsx` already established here:
 * typing and arrowing interleave constantly, and focus that jumps out of the
 * input on every arrow key is what breaks IMEs and screen-reader typing echo.
 * The row elements stay real buttons so a pointer reader keeps an ordinary
 * click target, but they are removed from the tab order — two tab stops per
 * result is not navigation.
 */
export function SessionSearchControl({
  className = '',
  shortcutTarget = false,
  touchAffected,
}: {
  readonly className?: string;
  /**
   * The ONE mount a global Cmd/Ctrl+K focuses. Pane copies stay fully usable,
   * but a shared focus signal may not make every mounted input race to claim
   * focus and presentation; the app-bar copy owns that global entry point.
   */
  readonly shortcutTarget?: boolean;
  /**
   * Overrides the measured input modality. Every mount leaves it out; it exists
   * so a test can state a device instead of the module-level modality store
   * having to be reconfigured, and so the store's own conservative default
   * (unknown ⇒ touch) is not the only branch this file can ever execute.
   */
  readonly touchAffected?: boolean;
}) {
  const search = useSessionSearch();
  const modality = useInputModality();
  const touch = touchAffected ?? modality.touchAffected;
  const input = useRef<HTMLInputElement>(null);
  // React spells a generated id with delimiters that are legal in an HTML id and
  // awkward everywhere else (`:r0:` before 19, `«r0»` after). Reduced to word
  // characters so the same value is safe in an id, an IDREF and a selector.
  const instanceId = useId().replace(/[^\w-]/g, '');
  const inputId = `current-session-search-${instanceId}`;
  const listboxId = `current-session-search-results-${instanceId}`;
  const [announcement, setAnnouncement] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const currentScopeKey = snapshotKey(search.scope);
  const returnFocusScope = useRef(currentScopeKey);
  // A focusSignal is an EDGE, not an "open forever" flag. Seeding from the
  // mounted value consumes any old request left behind while the reader was on
  // a non-session route; only a later increment is a new Cmd/Ctrl+K.
  const consumedFocusSignal = useRef(search.focusSignal);

  const presenting = search.presenting === instanceId;
  const hasQuery = search.query.trim() !== '';
  const results = search.results;
  const activeResult = presenting ? results[search.activeIndex] : undefined;

  /**
   * AN EXPLICIT SHORTCUT ALWAYS TAKES FOCUS, on every device.
   *
   * `paletteFocusPolicy` deliberately withholds focus from a touch-affected
   * reader, and that is right for a dialog the palette OPENS: autofocusing an
   * input on a phone puts the on-screen keyboard over the results. This is the
   * other input domain — the reader pressed a key chord, which is proof of a
   * keyboard — so applying that policy here would ignore a deliberate keystroke
   * on any tablet that reports a coarse pointer.
   */
  useEffect(() => {
    const requested = consumedFocusSignal.current !== search.focusSignal;
    consumedFocusSignal.current = search.focusSignal;
    if (!requested || !shortcutTarget || !search.active) return;
    if (typeof document !== 'undefined') {
      const previous = document.activeElement;
      if (previous instanceof HTMLElement && previous !== document.body && previous !== input.current) {
        returnFocus.current = previous;
        returnFocusScope.current = currentScopeKey;
      }
    }
    input.current?.focus();
    input.current?.select();
    search.present(instanceId);
  }, [currentScopeKey, instanceId, search.active, search.focusSignal, search.present, shortcutTarget]);

  // A focus return belongs to the scope that opened the palette. If navigation
  // replaces that scope, no later Escape may focus a control from the old page.
  useEffect(() => {
    if (returnFocusScope.current === currentScopeKey) return;
    returnFocusScope.current = currentScopeKey;
    returnFocus.current = null;
  }, [currentScopeKey]);

  const dismiss = useCallback(() => {
    returnFocus.current = null;
    search.dismiss(instanceId);
  }, [instanceId, search.dismiss]);

  const dismissAndReturnFocus = useCallback(() => {
    const previous = returnFocusScope.current === currentScopeKey ? returnFocus.current : null;
    returnFocus.current = null;
    search.dismiss(instanceId);
    if (previous !== null && typeof document !== 'undefined' && document.contains(previous)) previous.focus();
  }, [currentScopeKey, instanceId, search.dismiss]);

  // Keep the active row inside the popup's own scroller. `block: 'nearest'`
  // moves this list and nothing else.
  //
  // The document is reached through a guard rather than assumed: this component
  // is rendered by a DOM-free renderer in its own tests, and scrolling a row
  // into view is a nicety that has no meaning without a viewport anyway.
  useEffect(() => {
    if (!presenting || activeResult === undefined || typeof document === 'undefined') return;
    document.getElementById(resultDomId(instanceId, activeResult))?.scrollIntoView({ block: 'nearest' });
  }, [activeResult, instanceId, presenting]);

  const resultCount = search.resultTotal;
  useEffect(() => {
    // A partial index cannot honestly announce an empty or complete count.
    // Visible loading/refusal copy owns that interval; count only once both
    // evidence sets are settled and complete.
    if (!presenting || !hasQuery || search.taskState !== 'ready' || search.fileState !== 'ready') {
      setAnnouncement('');
      return;
    }
    const timer = setTimeout(
      () => setAnnouncement(paletteCountLabel(resultCount)),
      SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [hasQuery, presenting, resultCount, search.fileState, search.taskState]);

  // A pointer landing anywhere outside this control dismisses it, exactly like
  // clicking off any other transient surface. Captured at the document so a
  // handler that stops propagation cannot strand an open popup.
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!presenting || typeof document === 'undefined') return;
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && container.current?.contains(target)) return;
      dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [dismiss, presenting]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // An IME candidate window owns the arrow and Enter keys while it is up.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        // Presentation only. The query is shared with the Tasks list's filter,
        // so clearing it here would unfilter a surface nobody dismissed.
        if (!presenting) return;
        event.preventDefault();
        dismissAndReturnFocus();
        return;
      }
      if (!presenting) return;
      if (event.key === 'Enter') {
        if (activeResult === undefined) return;
        event.preventDefault();
        dismiss();
        search.openResult(activeResult);
        return;
      }
      const next = nextActiveIndex(search.activeIndex, results.length, event.key);
      if (next === null) return;
      event.preventDefault();
      search.setActiveIndex(next);
    },
    [activeResult, dismiss, dismissAndReturnFocus, presenting, results.length, search],
  );

  if (!search.active) return null;
  const loading = search.taskState === 'loading' || search.fileState === 'loading';
  const unavailable = search.taskState === 'unavailable' || search.fileState === 'unavailable';
  const hidden = search.resultTotal - results.length;
  return (
    <div className={`relative min-w-0 ${className}`} data-current-session-search="" ref={container}>
      <label className="sr-only" htmlFor={inputId}>
        Search current-session files and tasks
      </label>
      <span
        className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted"
        data-search-leading=""
      >
        <Search aria-hidden="true" size={15} />
      </span>
      <input
        aria-activedescendant={activeResult ? resultDomId(instanceId, activeResult) : undefined}
        aria-autocomplete="list"
        aria-controls={presenting ? listboxId : undefined}
        aria-expanded={presenting}
        aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
        autoComplete="off"
        className="kt-input h-control w-full min-w-0 text-ui"
        id={inputId}
        onBlur={event => {
          const next = event.relatedTarget;
          if (typeof Node !== 'undefined' && next instanceof Node && container.current?.contains(next)) return;
          if (presenting) dismiss();
        }}
        onChange={event => {
          search.setQuery(event.target.value);
          // Typing is a claim on the popup as much as focusing is: a reader who
          // types into the Files pane's copy expects THAT one to answer, and a
          // keystroke cannot reach a control the reader is not in.
          search.present(instanceId);
        }}
        onFocus={() => search.present(instanceId)}
        onKeyDown={onKeyDown}
        placeholder="Search files & tasks"
        ref={input}
        role="combobox"
        spellCheck={false}
        style={{
          // `.kt-input` owns a later `padding` shorthand than the utility
          // layer, so `pl-8 pr-14` looked right in JSX and lost in computed
          // CSS. Inline logical padding is intentional here: it reserves both
          // absolutely-positioned slots in LTR and RTL alike.
          paddingInlineEnd: 'calc(var(--pad-control-x) + 2.75rem)',
          paddingInlineStart: 'calc(var(--pad-control-x) + 1.5rem)',
        }}
        value={search.query}
      />
      {/* THE TRAILING SLOT SAYS ONE TRUE THING. While the index is still being
          built that fact outranks a shortcut hint, and on a device with no
          keyboard the hint is a key the reader cannot press — which is the
          exact mistake `palette-shortcut.ts` exists to prevent. */}
      <span
        className="pointer-events-none absolute inset-y-0 right-2 flex items-center mono text-2xs text-muted"
        data-search-trailing=""
      >
        {loading ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={13} data-search-indexing="" />
        ) : touch ? null : (
          <span data-search-shortcut="">{paletteShortcutLabel()}</span>
        )}
      </span>
      {/* Announced, never drawn: the popup below is visible, and a sighted
          reader counting rows does not need the same sentence twice. */}
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
      {presenting && (
        <div
          className="absolute left-0 right-0 z-[80] mt-1 max-h-72 overflow-y-auto rounded-panel border border-border bg-surface shadow-panel"
          data-session-search-popup=""
        >
          {loading && (
            <p className="m-0 flex items-center gap-2 px-3 py-2 text-ui text-muted" role="status">
              <LoaderCircle className="animate-spin" size={14} />
              {indexingCopy(search.taskState, search.fileState)}
            </p>
          )}
          {unavailable && (
            <p className="m-0 flex items-start gap-2 px-3 py-2 text-ui text-warn" role="alert">
              <TriangleAlert className="mt-0.5 shrink-0" size={14} />
              {unavailableCopy(search.taskState, search.fileState, search.taskError, search.fileError)}
            </p>
          )}
          {!hasQuery && !loading && !unavailable && (
            <p className="m-0 px-3 py-2 text-ui text-muted">Type to search this session's files and tasks.</p>
          )}
          {hasQuery && !loading && results.length === 0 && !unavailable && (
            <p className="m-0 px-3 py-2 text-ui text-muted">
              No current-session files or tasks match “{search.query}”.
            </p>
          )}
          <div aria-label="Current-session results" id={listboxId} role="listbox">
            {results.map((result, index) => (
              <button
                aria-selected={index === search.activeIndex}
                className={`flex min-h-[44px] w-full flex-col gap-0.5 border-0 border-b border-border-soft px-3 py-2 text-left last:border-b-0 hover:bg-surface-2 ${
                  index === search.activeIndex ? 'bg-surface-2' : 'bg-transparent'
                }`}
                // Which KIND this row is, stated on the row. Ranking mixes files
                // and tasks by score, so neither a reader's eye nor a test can
                // rely on position to tell them apart.
                data-result-kind={result.kind}
                id={resultDomId(instanceId, result)}
                key={sessionSearchResultKey(result)}
                onClick={() => {
                  dismiss();
                  search.openResult(result);
                }}
                onMouseEnter={() => search.setActiveIndex(index)}
                role="option"
                // The text box owns the tab stop; the rows are pointed at, not
                // tabbed through.
                tabIndex={-1}
                type="button"
              >
                <span className="text-row font-medium text-fg">
                  {result.kind === 'file' ? result.name : result.task.title}
                </span>
                <span className="mono text-2xs text-muted">
                  {result.kind === 'file' ? result.path : `#${result.task.id}`}
                </span>
              </button>
            ))}
          </div>
          {hidden > 0 && (
            <p className="m-0 border-t border-border-soft px-3 py-2 text-2xs text-muted" data-search-capped="">
              Showing the {results.length} closest matches. {hidden} more match{hidden === 1 ? '' : 'es'} — keep typing
              to narrow them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const asSummary = (task: ScopedTaskView): TaskSummary => ({
  ...task,
  descriptionChars: task.description.length,
  askChars: task.ask.text.length,
  askSource: task.ask.source,
  clarificationCount: task.clarifications.length,
});

/** The real Tasks singleton: List and Kanban both consume the shared search control and model. */
export function SessionTasksSearchSurface() {
  const search = useSessionSearch();
  const compact = useLayoutMode() === 'drawer';
  const [view, setView] = useState<'list' | 'kanban'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, ScopedTaskView>>(new Map());
  const [markingDoneKey, setMarkingDoneKey] = useState<string | null>(null);
  const [markDoneError, setMarkDoneError] = useState<string | null>(null);
  const [referenceMessage, setReferenceMessage] = useState('');
  const tasks = useMemo(
    () =>
      search.tasks
        .map(task => (search.scope === null ? task : (optimistic.get(taskOverlayKey(search.scope, task.id)) ?? task)))
        .filter(task => !search.query.trim() || matchesSessionSearch(taskText(task), search.query))
        .map(asSummary),
    [optimistic, search.query, search.scope, search.tasks],
  );
  const selected = tasks.find(task => task.id === selectedId) ?? null;
  const markingDoneId =
    search.scope === null || markingDoneKey === null
      ? null
      : (tasks.find(task => taskOverlayKey(search.scope as DaemonSessionScope, task.id) === markingDoneKey)?.id ??
        null);

  const markDone = useCallback(
    async (task: TaskSummary): Promise<void> => {
      const scope = search.scope;
      if (scope === null || task.phase !== 'live' || markingDoneKey !== null) return;
      const original = search.tasks.find(candidate => candidate.id === task.id);
      if (original === undefined) return;
      const overlayKey = taskOverlayKey(scope, task.id);
      const optimisticTask: ScopedTaskView = {
        ...original,
        phase: 'done',
        status: 'done',
        statusReason: 'Marked done from Tasks.',
        updatedAt: new Date().toISOString(),
      };
      setMarkDoneError(null);
      setMarkingDoneKey(overlayKey);
      setOptimistic(current => new Map(current).set(overlayKey, optimisticTask));
      // ONE id per logical Mark Done, minted here rather than per transport
      // attempt: a retry of the same click is the SAME operation, and the daemon
      // deduplicates on this header. Minting it deeper down would give a
      // re-sent request a fresh identity and complete the task twice.
      const requestId = crypto.randomUUID();
      try {
        const target = daemonRequest(search.connection, `${taskPath(scope)}/${encodeURIComponent(task.id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: requestId },
          body: JSON.stringify({ action: 'phase', phase: 'done', reason: 'Marked done from Tasks.' }),
        });
        const response = await fetch(target.url, target.init);
        if (!response.ok) throw new Error(`The daemon refused to mark this task done (HTTP ${response.status}).`);
        const parsed = ScopedTaskViewSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.sessionId !== scope.sessionId)
          throw new Error('The daemon returned an unreadable completion result.');
        setOptimistic(current => new Map(current).set(overlayKey, parsed.data));
      } catch (reason) {
        // Revert and name the refusal. A silent rollback is a lie, while
        // leaving an unconfirmed task done is worse.
        setOptimistic(current => new Map(current).set(overlayKey, original));
        setMarkDoneError(failureMessage(reason));
      } finally {
        setMarkingDoneKey(null);
      }
    },
    [markingDoneKey, search.connection, search.scope, search.tasks],
  );

  // Add to chat — put THIS task's reference into THIS session's draft.
  //
  // The scope carried here is the one the rows were read under, so the token
  // lands in the composer of the daemon and session that actually owns the
  // task. That is not a nicety: a task id is session-local, so `&F12` delivered
  // into another session's draft names a different piece of work, and the agent
  // reading it would have no way to know.
  //
  // What LANDS in the draft is formatted by the one canonical renderer inside
  // `addReferenceToComposer`, never assembled here, so an id the grammar cannot
  // write down is refused rather than pasted in as prose that never resolves.
  // There is deliberately no second refusal branch on this side: `TaskIdSchema`
  // already parsed every id on this surface, so a local guard would be a claim
  // about a danger the boundary has eliminated. The SPOKEN token comes from
  // `taskReference`, which is also what labels the button, so the sentence and
  // the control it answers can never name the task differently.
  const addToChat = useCallback(
    (task: TaskSummary): void => {
      const scope = search.scope;
      if (scope === null) return;
      const outcome = addReferenceToComposer({ kind: 'task', id: task.id }, scope);
      setReferenceMessage(addReferenceMessage(outcome, taskReference(task.id)));
    },
    [search.scope],
  );

  if (search.scope === null) return null;

  if (search.taskState === 'loading')
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <SessionSearchControl />
        <p className="m-0 flex items-center gap-2 p-2 text-ui text-muted" role="status">
          <LoaderCircle className="animate-spin" size={14} /> Loading task search evidence…
        </p>
      </div>
    );
  if (search.taskState === 'unavailable')
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <SessionSearchControl />
        <p className="m-0 flex items-start gap-2 p-2 text-ui text-warn" role="alert">
          <TriangleAlert className="mt-0.5 shrink-0" size={14} /> Tasks are unavailable: {search.taskError}
        </p>
      </div>
    );
  return (
    <section aria-label="Session tasks" className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <SessionSearchControl />
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div role="tablist" aria-label="Task views" className="flex gap-1">
          {(['list', 'kanban'] as const).map(candidate => (
            <button
              aria-selected={view === candidate}
              className="kt-btn kt-btn--sm"
              key={candidate}
              onClick={() => setView(candidate)}
              role="tab"
              type="button"
            >
              {candidate === 'list' ? 'List' : 'Kanban'}
            </button>
          ))}
        </div>
        <span className="mono text-2xs text-muted">
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
      </div>
      {selected && <TaskQuickSummary task={selected} />}
      {markDoneError !== null ? (
        <p className="m-0 rounded-control border border-err-border bg-err-bg px-2 py-1.5 text-ui text-err" role="alert">
          {markDoneError}
        </p>
      ) : null}
      <p
        className={
          referenceMessage === '' ? 'sr-only' : 'm-0 rounded-control bg-surface-2 px-2 py-1.5 text-ui text-muted'
        }
        data-task-add-status=""
        role="status"
      >
        {referenceMessage}
      </p>
      <div className="min-h-0 overflow-auto">
        {view === 'list' ? (
          <SessionTaskList
            daemonId={search.scope.daemonId}
            markingDoneId={markingDoneId}
            onAddToChat={addToChat}
            onMarkDone={markDone}
            onOpen={setSelectedId}
            tasks={tasks}
          />
        ) : (
          <SessionTaskKanban
            compact={compact}
            daemonId={search.scope.daemonId}
            markingDoneId={markingDoneId}
            onAddToChat={addToChat}
            onMarkDone={markDone}
            onOpen={setSelectedId}
            tasks={tasks}
          />
        )}
      </div>
    </section>
  );
}
