/**
 * EVERY SURFACE THE BOARD DRAWS, built once per daemon from the generated client: the two screens (the board, one
 * task), the two panels (a ferret's tasks, a task's progress), the Settings tab and the two renderers (the `task`
 * ask, a `&F12` reference, the `task` and `board` blocks of a chat). The task is READ-ONLY STATUS: nothing here answers, asks or moves a task (#1552). The
 * owner answers in the Agenda; the ask renderer draws that answer row's one plain reference to the task.
 */

import { Loading, RouteLink, useLayoutMode, useNow } from '@ferretry/app/ui';
import type {
  AppComponent,
  PanelProps,
  PluginClient,
  RendererProps,
  ScreenProps,
  SettingsProps,
} from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { TASK_ID_PATTERN, type TaskAskRef, formatTaskRef, writtenProgressParts } from '../../contract/index.ts';
import { useBoardTask, useTaskReferenceProof } from '../hooks/use-board.ts';
import { useChatTask } from '../hooks/use-chat-task.ts';
import { embedSpecOf } from '../lib/embed-lanes.ts';
import { readChatTasksUrl } from '../lib/board-chat-url.ts';
import { ferretNamer } from '../lib/board-present.ts';
import { THIS_MACHINE } from '../lib/machine.ts';
import { navigateTo, replaceTo } from '../lib/navigate.ts';
import { boardTaskPath, boardPath, taskPagePath, projectLanesPath } from '../lib/paths.ts';
import { BoardPage } from './board-page.tsx';
import { createBoardSettings } from './board-settings.tsx';
import { LaneEditorPage } from './lane-editor.tsx';
import { ChatTasks } from './chat-tasks.tsx';
import { TaskEmbed } from './embed.tsx';
import { BoardDetail } from './detail/board-detail.tsx';
import { useLocationSearch } from './location.ts';
import { taskProse } from './prose.tsx';
import { type BoardRuntime, boardRuntimeOf, type FerretRow } from './runtime.ts';

const MACHINE = { connection: THIS_MACHINE, name: 'This machine' } as const;
const MACHINES = [MACHINE] as const;

/** The ferrets' callsigns by id, read once from the daemon. */
const useFerrets = (runtime: BoardRuntime): readonly FerretRow[] => {
  const [rows, setRows] = useState<readonly FerretRow[]>([]);
  useEffect(() => {
    let live = true;
    void runtime.ferrets().then(found => {
      if (live) setRows(found);
    });
    return () => {
      live = false;
    };
  }, [runtime]);
  return rows;
};

const useCallsigns = (rows: readonly FerretRow[]): ReadonlyMap<string, string> =>
  useMemo(() => new Map(rows.map(row => [row.id, row.name] as const)), [rows]);

/** The project names for the task detail's byline. */
const useProjectNames = (runtime: BoardRuntime): ((id: string) => string) => {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const release = runtime.store.watchProjects(THIS_MACHINE);
    const read = (): void => {
      const projects = runtime.store.projectsState(THIS_MACHINE.daemonId).projects ?? [];
      setNames(new Map(projects.map(project => [project.id, project.name] as const)));
    };
    read();
    const stop = runtime.store.subscribe(read);
    return () => {
      stop();
      release();
    };
  }, [runtime]);
  return useCallback((id: string) => names.get(id) ?? id.slice(0, 8), [names]);
};

/** `/board/:project?` — the board; a task id in the address opens that task as a drawer (a page on a phone). */
const boardScreen = (runtime: BoardRuntime): AppComponent<ScreenProps> =>
  function BoardScreen({ params }: ScreenProps): ReactNode {
    const [search, setSearch] = useLocationSearch();
    const phone = useLayoutMode() === 'drawer';
    const callsigns = useCallsigns(useFerrets(runtime));
    const named = params.project;
    const openTask = named !== undefined && TASK_ID_PATTERN.test(named.toUpperCase()) ? named.toUpperCase() : null;
    const editingLanes = openTask === null && named !== undefined && new URLSearchParams(search).get('lanes') === '1';
    const withProject = useMemo(() => {
      if (named === undefined || openTask !== null) return search;
      const next = new URLSearchParams(search);
      if (next.get('project') === null) next.set('project', named);
      return next.toString();
    }, [named, openTask, search]);
    if (editingLanes)
      return (
        <LaneEditorPage
          callsigns={callsigns}
          connection={THIS_MACHINE}
          onBack={() => navigateTo(`${boardPath()}/${encodeURIComponent(named)}`)}
          projectId={named}
          store={runtime.store}
        />
      );
    const page = (
      <BoardPage
        callsigns={callsigns}
        machines={MACHINES}
        onNavigate={navigateTo}
        onSearch={setSearch}
        openCard={openTask === null ? null : { daemonId: THIS_MACHINE.daemonId, taskId: openTask }}
        phone={phone}
        search={withProject}
        store={runtime.store}
      />
    );
    if (named === undefined || openTask !== null) return page;
    return (
      <>
        <p data-board-lanes-link={named}>
          <RouteLink onNavigate={navigateTo} to={projectLanesPath(named)}>
            Edit lanes
          </RouteLink>
        </p>
        {page}
      </>
    );
  };

/** One task on a page of its own: `/task/:id`, and `/card/:id` while it moves the address. */
function TaskPage({ runtime, id }: { readonly runtime: BoardRuntime; readonly id: string }): ReactNode {
  const callsigns = useCallsigns(useFerrets(runtime));
  const names = useMemo(() => ferretNamer(callsigns), [callsigns]);
  const projectName = useProjectNames(runtime);
  const now = useNow();
  return (
    <BoardDetail
      machine={MACHINE}
      names={names}
      now={now}
      onClose={() => navigateTo(boardPath())}
      onNavigate={navigateTo}
      phone
      projectName={projectName}
      siblings={[]}
      store={runtime.store}
      taskId={id}
    />
  );
}

/** `/task/:id` — one task on a page of its own. */
const taskScreen = (runtime: BoardRuntime): AppComponent<ScreenProps> =>
  function TaskScreen({ params }: ScreenProps): ReactNode {
    return <TaskPage id={params.id ?? ''} runtime={runtime} />;
  };

/**
 * `/card/:id` — the address a link made before the rename still carries (transcripts and agenda text keep them): it
 * shows the task and moves the address to `/task/:id`.
 */
const formerCardScreen = (runtime: BoardRuntime): AppComponent<ScreenProps> =>
  function FormerCardScreen({ params }: ScreenProps): ReactNode {
    const id = params.id ?? '';
    useEffect(() => {
      if (id !== '') replaceTo(taskPagePath(id));
    }, [id]);
    return <TaskPage id={id} runtime={runtime} />;
  };

/** `ferret.side` — the tasks of the ferret the panel sits beside. */
const tasksOfFerret = (runtime: BoardRuntime): AppComponent<PanelProps> =>
  function TasksOfFerret({ subject }: PanelProps): ReactNode {
    const rows = useFerrets(runtime);
    const callsigns = useCallsigns(rows);
    const now = useNow();
    const [agents, setAgents] = useState(() => readChatTasksUrl(globalThis.location?.search ?? '').agents);
    const [expanded, setExpanded] = useState(() => readChatTasksUrl(globalThis.location?.search ?? '').expanded);
    const ferret = subject ?? '';
    const chat = useChatTask({
      store: runtime.store,
      connection: THIS_MACHINE,
      machineName: MACHINE.name,
      ferret,
      focus: null,
      ferrets: rows,
      agents,
    });
    return (
      <ChatTasks
        callsigns={callsigns}
        chat={chat}
        expanded={expanded}
        machine={MACHINE}
        now={now}
        onAgents={setAgents}
        onExpand={() => setExpanded(!expanded)}
        onNavigate={navigateTo}
        phone={false}
        scope={{ daemonId: THIS_MACHINE.daemonId, ferret }}
        store={runtime.store}
      />
    );
  };

/** `card.detail` — one task's progress: now, done so far, next, as its ferret last wrote it. */
const taskProgress = (runtime: BoardRuntime): AppComponent<PanelProps> =>
  function TaskProgress({ subject }: PanelProps): ReactNode {
    const id = (subject ?? '').toUpperCase();
    const state = useBoardTask(runtime.store, THIS_MACHINE, id);
    if (state.task === null)
      return state.missing ? <p role="status">No task {id}.</p> : <Loading kind="bar" label={`Reading ${id}…`} />;
    const parts = writtenProgressParts(state.task.progress);
    if (parts.length === 0) return <p role="status">{formatTaskRef({ id })} has no progress yet.</p>;
    return (
      <section aria-label={`Progress of ${formatTaskRef({ id })}`} className="fy-card__status" data-card-progress={id}>
        {parts.map(part => (
          <div className="fy-card__status-part" data-progress-part={part.key} key={part.key}>
            <h5 className="fy-card__status-label">{part.label}</h5>
            {taskProse(part.text)}
          </div>
        ))}
      </section>
    );
  };

/** The shape of what an ask renderer is handed: the `task` source's reference, possibly inside its envelope. */
const taskOfAsk = (value: unknown): string | null => {
  const direct = value as Partial<TaskAskRef> | null;
  const nested = (value as { readonly ref?: Partial<TaskAskRef> } | null)?.ref;
  const id = nested?.card ?? direct?.card;
  return typeof id === 'string' ? id.toUpperCase() : null;
};

/**
 * `ask:card` — the Agenda's one answer row for an ask a task raised. The task is named once, as a plain reference
 * and its title; there is no heading, no button and no lane talk here (owner words, #1552).
 */
const taskAskRenderer = (runtime: BoardRuntime): AppComponent<RendererProps> =>
  function TaskAsk({ value }: RendererProps): ReactNode {
    const id = taskOfAsk(value);
    const state = useBoardTask(runtime.store, THIS_MACHINE, id ?? 'F1', { beat: false });
    if (id === null) return null;
    return (
      <span data-ask-card={id}>
        <RouteLink to={boardTaskPath(undefined, id)}>{formatTaskRef({ id })}</RouteLink>
        {state.task === null ? null : <> {state.task.title}</>}
      </span>
    );
  };

/** `reference:&` — a `&F12` written anywhere: a link when the task exists on this machine, plain text when not. */
const taskReferenceRenderer = (runtime: BoardRuntime): AppComponent<RendererProps> =>
  function TaskReference({ value }: RendererProps): ReactNode {
    const written = String(typeof value === 'string' ? value : ((value as { id?: unknown } | null)?.id ?? ''))
      .replace(/^&/u, '')
      .toUpperCase();
    const known = TASK_ID_PATTERN.test(written);
    const state = useBoardTask(runtime.store, THIS_MACHINE, known ? written : 'F1', { beat: false });
    const read = useMemo(() => (state.task === null ? [] : [state.task]), [state.task]);
    const proves = useTaskReferenceProof(runtime.store, THIS_MACHINE, read);
    if (!known) return <>{`&${written}`}</>;
    // Syntax is not proof: it links only when the task is one of this machine's, and reads as plain text otherwise.
    if (!proves(written)) return <>{formatTaskRef({ id: written })}</>;
    return (
      <RouteLink title={state.task?.title} to={taskPagePath(written)}>
        {formatTaskRef({ id: written })}
      </RouteLink>
    );
  };

/** `reference:&board` — a `task` or `board` block in chat: the mini board and its lanes, drawn from the board. */
const taskEmbedRenderer = (runtime: BoardRuntime): AppComponent<RendererProps> =>
  function TaskEmbedRenderer({ value }: RendererProps): ReactNode {
    const callsigns = useCallsigns(useFerrets(runtime));
    const names = useMemo(() => ferretNamer(callsigns), [callsigns]);
    const spec = embedSpecOf(value);
    return spec === null ? null : <TaskEmbed names={names} spec={spec} store={runtime.store} />;
  };

export interface BoardSurfaces {
  readonly screens: {
    readonly board: AppComponent<ScreenProps>;
    readonly task: AppComponent<ScreenProps>;
    readonly card: AppComponent<ScreenProps>;
  };
  readonly panels: {
    readonly 'cards-of-ferret': AppComponent<PanelProps>;
    readonly 'card-progress': AppComponent<PanelProps>;
  };
  readonly settings: { readonly board: AppComponent<SettingsProps> };
  readonly renderers: {
    readonly 'ask:card': AppComponent<RendererProps>;
    readonly 'reference:&': AppComponent<RendererProps>;
    readonly 'reference:&board': AppComponent<RendererProps>;
  };
}

export const createSurfaces = (client: PluginClient): BoardSurfaces => {
  const runtime = boardRuntimeOf(client);
  return {
    screens: { board: boardScreen(runtime), task: taskScreen(runtime), card: formerCardScreen(runtime) },
    panels: { 'cards-of-ferret': tasksOfFerret(runtime), 'card-progress': taskProgress(runtime) },
    settings: { board: createBoardSettings(client) },
    renderers: {
      'ask:card': taskAskRenderer(runtime),
      'reference:&': taskReferenceRenderer(runtime),
      'reference:&board': taskEmbedRenderer(runtime),
    },
  };
};
