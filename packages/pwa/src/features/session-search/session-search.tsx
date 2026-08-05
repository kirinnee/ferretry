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
  ScopedTaskDetailResponseSchema,
  ScopedTaskSummarySchema,
  type ScopedTaskView,
  ScopedTaskViewSchema,
  type TaskSummary,
} from '@ferretry/protocol';
import { LoaderCircle, Search, TriangleAlert } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type FsListing, fsApi } from '../../components/files-api.ts';
import { SessionTaskKanban, SessionTaskList } from '../../components/session-tasks.tsx';
import { TaskQuickSummary } from '../../features/tasks/task-row.tsx';
import { useLayoutMode } from '../../hooks/use-layout-mode.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';

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

export const filterSessionSearchResults = (
  tasks: readonly ScopedTaskView[],
  files: readonly SessionSearchFile[],
  query: string,
): readonly SessionSearchResult[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return [
    ...tasks.filter(task => taskText(task).includes(normalized)).map(task => ({ kind: 'task' as const, task })),
    ...files.filter(file => matchesSessionSearch(`${file.name}\n${file.path}`, normalized)),
  ];
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
  readonly results: readonly SessionSearchResult[];
  readonly focusSignal: number;
  readonly setQuery: (query: string) => void;
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
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(INITIAL);
  const [query, setQuery] = useState('');
  const openers = useRef<SessionSearchOpeners | null>(null);

  useEffect(() => {
    setQuery('');
    if (scope === null) {
      setSnapshot(INITIAL);
      return;
    }
    const controller = new AbortController();
    setSnapshot(INITIAL);
    void readTasks(connection, scope, controller.signal).then(
      tasks => {
        if (!controller.signal.aborted)
          setSnapshot(current => ({ ...current, taskState: 'ready', taskError: null, tasks }));
      },
      reason => {
        if (!controller.signal.aborted)
          setSnapshot(current => ({
            ...current,
            taskState: 'unavailable',
            taskError: failureMessage(reason),
            tasks: [],
          }));
      },
    );
    void readFiles(connection, scope, controller.signal).then(
      files => {
        if (!controller.signal.aborted)
          setSnapshot(current => ({ ...current, fileState: 'ready', fileError: null, files }));
      },
      reason => {
        if (!controller.signal.aborted)
          setSnapshot(current => ({
            ...current,
            fileState: 'unavailable',
            fileError: failureMessage(reason),
            files: [],
          }));
      },
    );
    return () => controller.abort();
  }, [connection, scope]);

  const setOpeners = useCallback((next: SessionSearchOpeners | null) => {
    openers.current = next;
  }, []);
  const openResult = useCallback((result: SessionSearchResult) => {
    if (result.kind === 'file') openers.current?.openFile(result.path);
    else openers.current?.openTasks();
  }, []);
  const results = useMemo(() => filterSessionSearchResults(snapshot.tasks, snapshot.files, query), [query, snapshot]);
  const value = useMemo<SessionSearchContextValue>(
    () => ({
      ...snapshot,
      connection,
      active: scope !== null,
      scope,
      query,
      results,
      focusSignal,
      setQuery,
      setOpeners,
      openResult,
    }),
    [connection, focusSignal, openResult, query, results, scope, setOpeners, snapshot],
  );
  return <SessionSearchContext.Provider value={value}>{children}</SessionSearchContext.Provider>;
}

const stateCopy = (state: SessionSearchResourceState, noun: string): string =>
  state === 'loading' ? `Loading ${noun}…` : state === 'unavailable' ? `${noun} unavailable.` : '';

/** One component, three mounts: the app bar, Tasks, and Files share its query and results. */
export function SessionSearchControl({ className = '' }: { readonly className?: string }) {
  const search = useSessionSearch();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!search.active || search.focusSignal === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [search.active, search.focusSignal]);
  if (!search.active) return null;
  const loading = search.taskState === 'loading' || search.fileState === 'loading';
  const unavailable = search.taskState === 'unavailable' || search.fileState === 'unavailable';
  return (
    <div className={`relative min-w-0 ${className}`} data-current-session-search="">
      <label className="sr-only" htmlFor="current-session-search">
        Search current-session files and tasks
      </label>
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted">
        <Search aria-hidden="true" size={15} />
      </span>
      <input
        className="kt-input h-control w-full min-w-0 pl-8 pr-14 text-ui"
        id="current-session-search"
        onChange={event => search.setQuery(event.target.value)}
        placeholder="Search files & tasks"
        ref={input}
        value={search.query}
        aria-keyshortcuts="Meta+K Control+K"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center mono text-2xs text-muted">
        ⌘K
      </span>
      {search.query.trim() && (
        <div className="absolute left-0 right-0 z-[80] mt-1 max-h-72 overflow-y-auto rounded-panel border border-border bg-surface shadow-panel">
          {loading && (
            <p className="m-0 flex items-center gap-2 px-3 py-2 text-ui text-muted" role="status">
              <LoaderCircle className="animate-spin" size={14} /> Searching current-session data…
            </p>
          )}
          {unavailable && (
            <p className="m-0 flex items-start gap-2 px-3 py-2 text-ui text-warn" role="alert">
              <TriangleAlert className="mt-0.5 shrink-0" size={14} />
              {stateCopy(search.taskState, 'Tasks')} {stateCopy(search.fileState, 'Files')}
            </p>
          )}
          {!loading && search.results.length === 0 && !unavailable && (
            <p className="m-0 px-3 py-2 text-ui text-muted">
              No current-session files or tasks match “{search.query}”.
            </p>
          )}
          {search.results.map(result => (
            <button
              className="flex min-h-[44px] w-full flex-col gap-0.5 border-0 border-b border-border-soft bg-transparent px-3 py-2 text-left last:border-b-0 hover:bg-surface-2"
              key={result.kind === 'file' ? `file:${result.path}` : `task:${result.task.id}`}
              onClick={() => search.openResult(result)}
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
      try {
        const target = daemonRequest(search.connection, `${taskPath(scope)}/${encodeURIComponent(task.id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
      <div className="min-h-0 overflow-auto">
        {view === 'list' ? (
          <SessionTaskList
            daemonId={search.scope.daemonId}
            markingDoneId={markingDoneId}
            onMarkDone={markDone}
            onOpen={setSelectedId}
            tasks={tasks}
          />
        ) : (
          <SessionTaskKanban
            compact={compact}
            daemonId={search.scope.daemonId}
            markingDoneId={markingDoneId}
            onMarkDone={markDone}
            onOpen={setSelectedId}
            tasks={tasks}
          />
        )}
      </div>
    </section>
  );
}
