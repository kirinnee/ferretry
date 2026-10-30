/**
 * Current-session file and task search (handover #6).
 *
 * One explicitly daemon-scoped search model, exposed as the same visible control to the app bar and
 * Files. The tasks it searches are THIS FERRET'S CARDS on the board (one `/v1/board` read through the
 * store, `useFerretCards`): the browser matches them against the typed query, like the file index.
 */

import {
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  matchesSessionSearchQuery,
  type SessionFileIndexCoverage,
  type SessionFileIndexEntry,
  SessionFileIndexResponseSchema,
  type SessionFileIndexSkip,
  SessionSearchQuerySchema,
  sessionSearchFileHaystack,
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
import { fsApi } from '../../components/files-api.ts';
import { useFerretCards } from '../../hooks/use-ferret-cards.ts';
import type { DaemonBoardStore } from '../../lib/board-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import type { SessionCard } from '../../lib/session-cards.ts';
import { useDaemonFetch } from '../../lib/store.tsx';
import { nextActiveIndex, paletteCountLabel } from '../../shell/palette-model.ts';
import { type FuzzyField, SUBSTRING_SCORE, scoreFields, WORD_START_SCORE } from '../../shell/palette-ranking.ts';

export type SessionSearchResourceState = 'loading' | 'ready' | 'unavailable';

interface SessionSearchFile {
  readonly kind: 'file';
  readonly path: string;
  readonly name: string;
}

interface SessionSearchTask {
  readonly kind: 'task';
  readonly task: SessionCard;
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
  /** This ferret's cards, whatever their lane; empty until the board is read. */
  readonly tasks: readonly SessionCard[];
  readonly files: readonly SessionFileIndexEntry[];
  readonly coverage: SessionFileIndexCoverage;
  readonly skipped: readonly SessionFileIndexSkip[];
}

const INITIAL: SearchSnapshot = {
  taskState: 'loading',
  fileState: 'loading',
  taskError: null,
  fileError: null,
  tasks: [],
  files: [],
  coverage: 'complete',
  skipped: [],
};

/**
 * A snapshot CARRIES the session it describes.
 *
 * The file index is a bare piece of state cleared by the load effect. That would make the scope prop and
 * the evidence two facts with two update schedules: a render would publish the new scope immediately while
 * the effect that clears the old evidence is passive, so one committed render could pair daemon beta's
 * scope with daemon alpha's files.
 *
 * Keying it makes the mismatch unrepresentable rather than merely brief: the render derives INITIAL
 * whenever the stored key is not the key being rendered, so "we have not read THIS session yet" is a
 * synchronous consequence of the scope rather than the outcome of an effect that has not run.
 */
interface KeyedSnapshot {
  /** `daemonSessionKey(scope)`, or `''` for no scope — never a real key. */
  readonly key: string;
  readonly snapshot: Pick<SearchSnapshot, 'fileState' | 'fileError' | 'files' | 'coverage' | 'skipped'>;
}

/** The key a scope's evidence is filed under. `null` gets one no scope can equal. */
const snapshotKey = (scope: DaemonSessionScope | null): string => (scope === null ? '' : daemonSessionKey(scope));

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
 * A name outranks a path. A card that matches only in its summary or lane sits between those two; see
 * {@link PROSE_TASK_MATCH_SCORE}.
 */
const SESSION_SEARCH_WEIGHTS = {
  fileName: 3,
  taskTitle: 3,
  filePath: 1.2,
  /** Ids only answer to an anchored query; see `FuzzyField.anchored`. */
  taskId: 1,
} as const;

/**
 * What a card that matched on its summary or lane is worth when its title and id do not match.
 *
 * This midpoint outranks the best path-only word start while staying below the weakest filename
 * substring, preserving the intended name → card prose → path order on the ranker's real scale.
 */
const PROSE_TASK_MATCH_SCORE =
  (SESSION_SEARCH_WEIGHTS.filePath * WORD_START_SCORE + SESSION_SEARCH_WEIGHTS.fileName * SUBSTRING_SCORE) / 2;

const taskFields = (task: SessionCard): readonly FuzzyField[] => [
  { value: task.title, weight: SESSION_SEARCH_WEIGHTS.taskTitle },
  { value: task.id, weight: SESSION_SEARCH_WEIGHTS.taskId, anchored: true },
  ...(task.legacyId === null ? [] : [{ value: task.legacyId, weight: SESSION_SEARCH_WEIGHTS.taskId, anchored: true }]),
];

const taskHaystack = (task: SessionCard): string =>
  [task.id, task.legacyId ?? '', task.title, task.summary, task.lane].join(' ');

const fileFields = (file: SessionSearchFile): readonly FuzzyField[] => [
  { value: file.name, weight: SESSION_SEARCH_WEIGHTS.fileName },
  { value: file.path, weight: SESSION_SEARCH_WEIGHTS.filePath },
];

const resultScore = (result: SessionSearchResult, query: string): number =>
  result.kind === 'file'
    ? scoreFields(fileFields(result), query)
    : Math.max(scoreFields(taskFields(result.task), query), PROSE_TASK_MATCH_SCORE);

/** Stable within one result set, and distinct across two mounts of one control. */
export const sessionSearchResultKey = (result: SessionSearchResult): string =>
  result.kind === 'file' ? `file:${result.path}` : `task:${result.task.id}`;

/**
 * Ranked, with one membership rule for both kinds: the protocol-owned matcher over a haystack (a file's
 * name and path; a card's id, old id, title, summary and lane). Ranking changes only order: it never
 * rejects a member.
 */
export const filterSessionSearchResults = (
  tasks: readonly SessionCard[],
  files: readonly SessionFileIndexEntry[],
  query: string,
): readonly SessionSearchResult[] => {
  if (!SessionSearchQuerySchema.safeParse(query).success) return [];
  const members: readonly SessionSearchResult[] = [
    ...tasks
      .filter(task => matchesSessionSearchQuery(taskHaystack(task), query))
      .map(task => ({ kind: 'task' as const, task })),
    ...files
      .filter(file => matchesSessionSearchQuery(sessionSearchFileHaystack(file), query))
      .map(file => ({ kind: 'file' as const, name: file.name, path: file.path })),
  ];
  return members
    .map((result, index) => ({ result, index, score: resultScore(result, query) }))
    .sort((left, right) => (right.score === left.score ? left.index - right.index : right.score - left.score))
    .map(entry => entry.result);
};

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

interface FileIndexRead {
  readonly files: readonly SessionFileIndexEntry[];
  readonly coverage: SessionFileIndexCoverage;
  readonly skipped: readonly SessionFileIndexSkip[];
}

const readFiles = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal: AbortSignal,
  fetcher: DaemonFetch,
): Promise<FileIndexRead> => {
  const parsed = SessionFileIndexResponseSchema.safeParse(await fsApi.index(daemon, scope, signal, fetcher));
  if (!parsed.success) throw new Error('The daemon returned an unreadable file index.');
  if (parsed.data.sessionId !== scope.sessionId)
    throw new Error('The daemon returned a file index from another session.');
  return {
    files: parsed.data.files,
    coverage: parsed.data.coverage,
    skipped: parsed.data.skipped,
  };
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
  /**
   * Which mount currently PRESENTS the popup, or `null` for none.
   *
   * The query is shared by every mount. Two mounts rendering a popup from one query is what the app bar
   * and the open Files pane did; dismissal therefore has to release PRESENTATION rather than clear the
   * query, or dismissing the app bar's popup would silently clear the Files pane's box.
   */
  readonly presenting: string | null;
  readonly activeIndex: number;
  /** The board read already in flight for `scope`, or nothing once it settled. */
  readonly waitForTasks: () => Promise<void> | undefined;
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
  board,
  focusSignal = 0,
  children,
}: {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope | null;
  /** The board store the cards are read through; absent, the host has no board and no cards. */
  readonly board?: DaemonBoardStore;
  readonly focusSignal?: number;
  readonly children: ReactNode;
}) {
  const fetcher = useDaemonFetch();
  const [stored, setStored] = useState<KeyedSnapshot>({ key: '', snapshot: INITIAL });
  const [query, setQueryState] = useState('');
  const [presenting, setPresenting] = useState<string | null>(null);
  // Identity, not position: file and card reads settle independently and a
  // newly ranked row may be inserted before the reader's active result. An
  // index would then make Enter open a different result than the one still
  // highlighted a moment earlier.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const openers = useRef<SessionSearchOpeners | null>(null);
  const key = snapshotKey(scope);
  const currentKey = useRef(key);
  currentKey.current = key;
  const ferret = useFerretCards(board, connection, scope?.sessionId ?? null);
  // The board read in flight for THIS session. Menus await it rather than offer an invented empty list.
  const taskPending = useRef<{
    readonly key: string;
    readonly promise: Promise<void>;
    readonly settle: () => void;
  } | null>(null);
  useEffect(() => {
    const held = taskPending.current;
    if (ferret.state !== 'loading') {
      if (held?.key === key) held.settle();
      if (held?.key === key) taskPending.current = null;
      return;
    }
    if (held?.key === key || scope === null) return;
    held?.settle();
    let settle: () => void = () => undefined;
    const promise = new Promise<void>(resolve => {
      settle = resolve;
    });
    taskPending.current = { key, promise, settle };
    return () => {
      if (taskPending.current?.key === key) {
        taskPending.current.settle();
        taskPending.current = null;
      }
    };
  }, [ferret.state, key, scope]);
  const waitForTasks = useCallback((): Promise<void> | undefined => {
    const held = taskPending.current;
    return held?.key === currentKey.current ? held.promise : undefined;
  }, []);
  // DERIVED, not cleared. Evidence filed under another session is not this session's evidence, and this is
  // the line that says so during the very render that publishes the new scope.
  const files = stored.key === key ? stored.snapshot : INITIAL;
  const snapshot = useMemo<SearchSnapshot>(
    () => ({
      ...files,
      taskState: scope === null ? 'loading' : ferret.state,
      taskError: ferret.error,
      tasks: scope === null ? [] : ferret.cards,
    }),
    [files, scope, ferret],
  );

  // Every async completion publishes to the key that STARTED it. A read that finishes after the reader
  // moved on can therefore only ever write under the session it asked about.
  const publish = useCallback(
    (forKey: string, update: (current: KeyedSnapshot['snapshot']) => KeyedSnapshot['snapshot']): void => {
      setStored(current => ({
        key: forKey,
        snapshot: update(current.key === forKey ? current.snapshot : INITIAL),
      }));
    },
    [],
  );

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
    const forKey = daemonSessionKey(scope);
    void readFiles(connection, scope, controller.signal, fetcher).then(
      read => {
        if (!controller.signal.aborted)
          publish(forKey, current => ({
            ...current,
            fileState: 'ready',
            fileError: null,
            files: read.files,
            coverage: read.coverage,
            skipped: read.skipped,
          }));
      },
      reason => {
        if (!controller.signal.aborted)
          publish(forKey, current => ({
            ...current,
            fileState: 'unavailable',
            fileError: failureMessage(reason),
            files: [],
            coverage: 'complete',
            skipped: [],
          }));
      },
    );
    return () => controller.abort();
  }, [connection, fetcher, publish, scope]);

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
  const ranked = useMemo(
    () => filterSessionSearchResults(snapshot.tasks, snapshot.files, query),
    [snapshot.tasks, snapshot.files, query],
  );
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
 * loading the board and the daemon-built index. A settled query has its own
 * An unavailable half is never folded into empty.
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

const SEARCH_QUERY_INVALID_COPY = `Search text must be between 1 and ${MAX_SESSION_SEARCH_QUERY_LENGTH} characters without control characters.`;

const skippedCopy = (skipped: readonly SessionFileIndexSkip[]): string =>
  `Not indexed: ${skipped.map(entry => `${entry.count} ${entry.reason}`).join(', ')}.`;

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
}: {
  readonly className?: string;
  /**
   * The ONE mount a provider `focusSignal` focuses. The shell no longer sends one
   * (Cmd/Ctrl+K opens the global finder), but a host that does still reaches one
   * input rather than every mounted copy racing to claim focus and presentation.
   */
  readonly shortcutTarget?: boolean;
}) {
  const search = useSessionSearch();
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
  const queryPresent = search.query.trim() !== '';
  const queryValid = SessionSearchQuerySchema.safeParse(search.query).success;
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
    if (
      !presenting ||
      !queryValid ||
      search.taskState !== 'ready' ||
      search.fileState !== 'ready' ||
      search.coverage !== 'complete'
    ) {
      setAnnouncement('');
      return;
    }
    const timer = setTimeout(
      () => setAnnouncement(paletteCountLabel(resultCount)),
      SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [presenting, queryValid, resultCount, search.coverage, search.fileState, search.taskState]);

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
  const partial = search.fileState === 'ready' && search.coverage === 'partial';
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
      {/* THE TRAILING SLOT SAYS ONE TRUE THING: the index is still being built. Cmd/Ctrl+K opens the
          global finder, not this box, so no shortcut is printed here. */}
      <span
        className="pointer-events-none absolute inset-y-0 right-2 flex items-center mono text-2xs text-muted"
        data-search-trailing=""
      >
        {loading ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={13} data-search-indexing="" />
        ) : null}
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
          {queryPresent && !queryValid && (
            <p className="m-0 px-3 py-2 text-ui text-warn" data-search-query-invalid="">
              {SEARCH_QUERY_INVALID_COPY}
            </p>
          )}
          {!queryPresent && !loading && !unavailable && (
            <p className="m-0 px-3 py-2 text-ui text-muted">Type to search this session's files and tasks.</p>
          )}
          {queryValid &&
            !loading &&
            search.taskState === 'ready' &&
            results.length === 0 &&
            !unavailable &&
            !partial && (
              <p className="m-0 px-3 py-2 text-ui text-muted">
                No current-session files or tasks match “{search.query}”.
              </p>
            )}
          {queryValid &&
            !loading &&
            search.taskState === 'ready' &&
            results.length === 0 &&
            !unavailable &&
            partial && (
              <p className="m-0 px-3 py-2 text-ui text-muted">No match in the indexed portion of this session.</p>
            )}
          {partial && (
            <p className="m-0 px-3 py-2 text-ui text-muted" data-search-coverage="">
              File results are incomplete: the index did not finish.
            </p>
          )}
          {search.fileState === 'ready' && search.skipped.length > 0 && (
            <p className="m-0 px-3 py-2 text-ui text-muted" data-search-skips="">
              {skippedCopy(search.skipped)}
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
                  {result.kind === 'file' ? result.path : `&${result.task.id} · ${result.task.lane}`}
                </span>
              </button>
            ))}
          </div>
          {hidden > 0 && (
            <p className="m-0 border-t border-border-soft px-3 py-2 text-2xs text-muted" data-search-capped="">
              {partial ? 'From the indexed portion, showing' : 'Showing'} the {results.length} closest matches. {hidden}{' '}
              more match{hidden === 1 ? '' : 'es'} — keep typing to narrow them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
