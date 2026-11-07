/**
 * EVERY SURFACE THE BOARD DRAWS, built once per daemon from the generated client: the two screens (the board, one
 * card), the two panels (a ferret's cards, a card's progress), the Settings tab and the two renderers (the `card`
 * ask, a `&F12` reference). The card is READ-ONLY STATUS: nothing here answers, asks or moves a card (#1552). The
 * owner answers in the Agenda; the ask renderer draws that answer row's one plain reference to the card.
 */

import { useLayoutMode } from '@ferretry/app/ui';
import type { AppComponent, PanelProps, PluginClient, RendererProps, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { CARD_ID_PATTERN, type CardAskRef, formatCardRef, writtenProgressParts } from '../../contract/index.ts';
import { useBoardCard } from '../hooks/use-board.ts';
import { useChatCard } from '../hooks/use-chat-card.ts';
import { readChatTasksUrl } from '../lib/board-chat-url.ts';
import { ferretNamer } from '../lib/board-present.ts';
import { THIS_MACHINE } from '../lib/machine.ts';
import { navigateTo } from '../lib/navigate.ts';
import { boardCardPath, boardPath, cardPagePath } from '../lib/paths.ts';
import { BoardPage } from './board-page.tsx';
import { ChatTasks } from './chat-tasks.tsx';
import { BoardDetail } from './detail/board-detail.tsx';
import { useLocationSearch } from './location.ts';
import { cardProse } from './prose.tsx';
import { type BoardRuntime, createBoardRuntime, type FerretRow } from './runtime.ts';
import { RouteLink } from '@ferretry/app/ui';

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

/** The project names for the card detail's byline. */
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

/** `/board/:project?` — the board; a card id in the address opens that card as a drawer (a page on a phone). */
const boardScreen = (runtime: BoardRuntime): AppComponent<ScreenProps> =>
  function BoardScreen({ params }: ScreenProps): ReactNode {
    const [search, setSearch] = useLocationSearch();
    const phone = useLayoutMode() === 'drawer';
    const callsigns = useCallsigns(useFerrets(runtime));
    const named = params.project;
    const openCard = named !== undefined && CARD_ID_PATTERN.test(named.toUpperCase()) ? named.toUpperCase() : null;
    const withProject = useMemo(() => {
      if (named === undefined || openCard !== null) return search;
      const next = new URLSearchParams(search);
      if (next.get('project') === null) next.set('project', named);
      return next.toString();
    }, [named, openCard, search]);
    return (
      <BoardPage
        callsigns={callsigns}
        machines={MACHINES}
        onNavigate={navigateTo}
        onSearch={setSearch}
        openCard={openCard === null ? null : { daemonId: THIS_MACHINE.daemonId, taskId: openCard }}
        phone={phone}
        search={withProject}
        store={runtime.store}
      />
    );
  };

/** `/card/:id` — one card on a page of its own. */
const cardScreen = (runtime: BoardRuntime): AppComponent<ScreenProps> =>
  function CardScreen({ params }: ScreenProps): ReactNode {
    const callsigns = useCallsigns(useFerrets(runtime));
    const names = useMemo(() => ferretNamer(callsigns), [callsigns]);
    const projectName = useProjectNames(runtime);
    const [now] = useState(() => Date.now());
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
        taskId={params.id ?? ''}
      />
    );
  };

/** `ferret.side` — the cards of the ferret the panel sits beside. */
const cardsOfFerret = (runtime: BoardRuntime): AppComponent<PanelProps> =>
  function CardsOfFerret({ subject }: PanelProps): ReactNode {
    const rows = useFerrets(runtime);
    const callsigns = useCallsigns(rows);
    const [now] = useState(() => Date.now());
    const [agents, setAgents] = useState(() => readChatTasksUrl(globalThis.location?.search ?? '').agents);
    const [expanded, setExpanded] = useState(() => readChatTasksUrl(globalThis.location?.search ?? '').expanded);
    const ferret = subject ?? '';
    const chat = useChatCard({
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

/** `card.detail` — one card's progress: now, done so far, next, as its ferret last wrote it. */
const cardProgress = (runtime: BoardRuntime): AppComponent<PanelProps> =>
  function CardProgress({ subject }: PanelProps): ReactNode {
    const id = (subject ?? '').toUpperCase();
    const state = useBoardCard(runtime.store, THIS_MACHINE, id);
    if (state.task === null) return state.missing ? <p role="status">No card {id}.</p> : <p role="status">Reading {id}…</p>;
    const parts = writtenProgressParts(state.task.progress);
    if (parts.length === 0) return <p role="status">{formatCardRef({ id })} has no progress yet.</p>;
    return (
      <section aria-label={`Progress of ${formatCardRef({ id })}`} className="fy-card__status" data-card-progress={id}>
        {parts.map(part => (
          <div className="fy-card__status-part" data-progress-part={part.key} key={part.key}>
            <h5 className="fy-card__status-label">{part.label}</h5>
            {cardProse(part.text)}
          </div>
        ))}
      </section>
    );
  };

/** Settings › Board: what the board watches. The GitHub watch is configured in `config/board.yaml`. */
const boardSettings = (): AppComponent<SettingsProps> =>
  function BoardSettings(): ReactNode {
    return (
      <section aria-label="Board" data-settings="board">
        <p>
          The board shows the work you asked for as cards in lanes. Ferretry watches the pull requests a card links
          through GitHub and moves the card when one is opened, passes, merges or ships.
        </p>
        <p>
          The watch is on by default and polls about once a minute. To change it, edit <code>github</code> in{' '}
          <code>config/board.yaml</code>.
        </p>
      </section>
    );
  };

/** The shape of what an ask renderer is handed: the `card` source's reference, possibly inside its envelope. */
const cardOfAsk = (value: unknown): string | null => {
  const direct = value as Partial<CardAskRef> | null;
  const nested = (value as { readonly ref?: Partial<CardAskRef> } | null)?.ref;
  const id = nested?.card ?? direct?.card;
  return typeof id === 'string' ? id.toUpperCase() : null;
};

/**
 * `ask:card` — the Agenda's one answer row for an ask a card raised. The card is named once, as a plain reference
 * and its title; there is no heading, no button and no lane talk here (owner words, #1552).
 */
const cardAskRenderer = (runtime: BoardRuntime): AppComponent<RendererProps> =>
  function CardAsk({ value }: RendererProps): ReactNode {
    const id = cardOfAsk(value);
    const state = useBoardCard(runtime.store, THIS_MACHINE, id ?? 'F1', { beat: false });
    if (id === null) return null;
    return (
      <span data-ask-card={id}>
        <RouteLink to={boardCardPath(undefined, id)}>{formatCardRef({ id })}</RouteLink>
        {state.task === null ? null : <> {state.task.title}</>}
      </span>
    );
  };

/** `reference:&` — a `&F12` written anywhere: a link when the card exists on this machine, plain text when not. */
const cardReferenceRenderer = (runtime: BoardRuntime): AppComponent<RendererProps> =>
  function CardReference({ value }: RendererProps): ReactNode {
    const written = String(typeof value === 'string' ? value : ((value as { id?: unknown } | null)?.id ?? '')).replace(/^&/u, '').toUpperCase();
    const known = CARD_ID_PATTERN.test(written);
    const state = useBoardCard(runtime.store, THIS_MACHINE, known ? written : 'F1', { beat: false });
    if (!known) return <>{`&${written}`}</>;
    if (state.task === null) return <>{formatCardRef({ id: written })}</>;
    return (
      <RouteLink title={state.task.title} to={cardPagePath(written)}>
        {formatCardRef({ id: written })}
      </RouteLink>
    );
  };

export interface BoardSurfaces {
  readonly screens: { readonly board: AppComponent<ScreenProps>; readonly card: AppComponent<ScreenProps> };
  readonly panels: {
    readonly 'cards-of-ferret': AppComponent<PanelProps>;
    readonly 'card-progress': AppComponent<PanelProps>;
  };
  readonly settings: { readonly board: AppComponent<SettingsProps> };
  readonly renderers: {
    readonly 'ask:card': AppComponent<RendererProps>;
    readonly 'reference:&': AppComponent<RendererProps>;
  };
}

export const createSurfaces = (client: PluginClient): BoardSurfaces => {
  const runtime = createBoardRuntime(client);
  return {
    screens: { board: boardScreen(runtime), card: cardScreen(runtime) },
    panels: { 'cards-of-ferret': cardsOfFerret(runtime), 'card-progress': cardProgress(runtime) },
    settings: { board: boardSettings() },
    renderers: { 'ask:card': cardAskRenderer(runtime), 'reference:&': cardReferenceRenderer(runtime) },
  };
};
