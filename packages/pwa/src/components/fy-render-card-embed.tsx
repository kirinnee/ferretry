/**
 * A `card` OR `board` BLOCK, DRAWN LIVE: the board's own card, inline in a message or an agenda body.
 *
 * It is not an illustration, so it has none of an illustration's chrome (no source panel, no fullscreen, no sandbox): the
 * block is a POINTER (`fy-render-embed.ts`) and everything drawn is read from the board. The card is the real
 * `BoardCard` — the one the Board page, the phone and the per-chat tab draw — read-only, so it shows the
 * title, the lane, the progress and the PRs the board says it has, and nothing an author typed.
 *
 *  - PROOF BEFORE LINK. The daemon's answer is the proof: a card that was read is linked and opened exactly as
 *    `&F12` is (`onTaskOpen`); one that was not — missing, unreadable, or not yet answered — is never a link.
 *    A card that cannot be shown is a quiet row saying so, the same shape a media file this reader cannot see
 *    takes, never a broken frame.
 *  - LIVE, WITHOUT A TIMER. Each card is watched with `beat: false`, so it is re-read only when the fleet feed
 *    names it in a `board.changed` (the app already routes every event to the store), and a block that
 *    scrolls away or unmounts releases its watch. A board built from a parent card joins one shared whole-board
 *    view the same way and shows the children that view holds. Both board forms draw ONE mini board: a frame,
 *    the Board's own lane header, the cards under their lanes. The ages tick on a local clock, never a read.
 *  - ONE RENDERER. A host that has no board to read (`cardEmbed` absent) never reaches this file: the fence
 *    stays an ordinary code fence, as any block this build cannot draw does.
 */

import type { BoardTaskId } from '@ferretry/protocol';
import { FileWarning } from 'lucide-react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

import { BoardCard } from '../features/board/board-card.tsx';
import { BoardLane } from '../features/board/board-lane.tsx';
import { useBoard, useBoardTask, useBoardTasks } from '../hooks/use-board.ts';
import { useFerretCallsigns } from '../hooks/use-ferret-callsigns.ts';
import { useNow } from '../hooks/use-now.ts';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import { type FerretNames, ferretNamer } from '../lib/board-present.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { BoardCardOf } from '../lib/board-view.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { FyRenderEmbedBlock } from '../lib/fy-render.ts';
import { FY_RENDER_LIMITS } from '../lib/fy-render-bounds.ts';
import { type EmbedEntry, type EmbedLane, embedCardOf, groupEmbedLanes } from '../lib/fy-render-embed-lanes.ts';
import { daemonBoardCardPath } from '../lib/pages/routes.ts';
import { useOptionalAppStore } from '../lib/store.tsx';

/** What a host that can read a board lends a block: where to read, and the machine to read it from. */
export interface FyRenderCardEmbedHost {
  readonly store: DaemonBoardStore;
  readonly connection: DaemonConnection;
  /** Ferret callsigns by session id; without it they come from the app's fleet, else the start of the id. */
  readonly callsigns?: ReadonlyMap<string, string>;
}

export interface FyRenderCardEmbedProps {
  readonly block: FyRenderEmbedBlock;
  readonly host: FyRenderCardEmbedHost;
  /** Opens a card the way a written `&F12` does; absent, the card is still a plain link to its page. */
  readonly onTaskOpen?: ((id: string, opener?: HTMLElement | null) => void) | undefined;
}

type OpenCard = FyRenderCardEmbedProps['onTaskOpen'];

/** Sub-cards are private bookkeeping, and a closed one is still a child worth showing. */
const CHILD_FILTERS = Object.freeze({ ...NO_BOARD_FILTERS, state: 'all' as const, agents: true });

const asTaskId = (id: string): BoardTaskId => id as BoardTaskId;

interface Note {
  readonly id: string;
  readonly sentence: string;
}

const noteRow = (id: string, sentence: string) => (
  <div className="fy-render-row" data-fy-card-embed-note={id} role="note" key={`note-${id}`}>
    <FileWarning aria-hidden="true" className="fy-render-row-icon" data-tone="warn" size={18} />
    <div className="fy-render-row-body">
      <span className="fy-render-row-name">&{id}</span>
      <span className="fy-render-row-meta">{sentence}</span>
    </div>
  </div>
);

const loading = (id: string) => (
  <div className="fy-card-embed-loading" data-fy-card-embed-loading={id} aria-hidden="true" />
);

interface CardDressing {
  readonly names: FerretNames;
  readonly now: number;
}

/** The ferret names and the clock every card in one block shares, read once per block. */
const DressingContext = createContext<CardDressing>({ names: ferretNamer(new Map()), now: 0 });

function useCardDressing(host: FyRenderCardEmbedHost): CardDressing {
  const fromApp = useFerretCallsigns(useOptionalAppStore());
  const callsigns = host.callsigns ?? fromApp;
  const names = useMemo(() => ferretNamer(callsigns), [callsigns]);
  const now = useNow();
  return useMemo(() => ({ names, now }), [names, now]);
}

function EmbeddedCard({
  card,
  category,
  lane,
  host,
  onTaskOpen,
}: {
  readonly card: BoardCardOf;
  readonly category: EmbedLane['category'];
  readonly lane?: string | undefined;
  readonly host: FyRenderCardEmbedHost;
  readonly onTaskOpen: OpenCard;
}) {
  const { names, now } = useContext(DressingContext);
  return (
    <BoardCard
      card={card}
      density="page"
      category={category}
      names={names}
      now={now}
      showMachine={false}
      href={daemonBoardCardPath(host.connection.daemonId, card.task.id)}
      {...(onTaskOpen === undefined ? {} : { onNavigate: () => onTaskOpen(card.task.id) })}
      {...(lane === undefined ? {} : { lane })}
    />
  );
}

function CardRow({
  id,
  host,
  onTaskOpen,
}: {
  readonly id: string;
  readonly host: FyRenderCardEmbedHost;
  readonly onTaskOpen: OpenCard;
}) {
  const { connection, store } = host;
  const state = useBoardTask(store, connection, asTaskId(id), { beat: false });
  if (state.task === null) {
    if (state.missing) return noteRow(id, 'No card with this id.');
    if (state.status === 'error') return noteRow(id, 'This card could not be read.');
    return loading(id);
  }
  const task = state.task;
  const lane = state.laneSet?.lanes.find(candidate => candidate.id === task.laneId);
  return (
    <ul className="fy-card-embed-list" data-fy-card-embed-card={task.id}>
      <EmbeddedCard
        card={embedCardOf(connection, task)}
        category={lane?.category ?? null}
        lane={lane?.name}
        host={host}
        onTaskOpen={onTaskOpen}
      />
    </ul>
  );
}

/** The one mini board both forms draw: a frame, the lanes with their cards, then the notes. */
function MiniBoard({
  anchor,
  lanes,
  notes,
  footer,
  host,
  onTaskOpen,
}: {
  readonly anchor: string;
  readonly lanes: readonly EmbedLane[];
  readonly notes: readonly Note[];
  readonly footer: ReactNode;
  readonly host: FyRenderCardEmbedHost;
  readonly onTaskOpen: OpenCard;
}) {
  const total = lanes.reduce((sum, lane) => sum + lane.cards.length, 0);
  let budget = FY_RENDER_LIMITS.embedChildren;
  return (
    <div className="fy-card-embed-board" data-fy-card-embed-board={anchor}>
      {lanes.map(lane => {
        const cards = lane.cards.slice(0, Math.max(0, budget));
        budget -= cards.length;
        if (cards.length === 0) return null;
        return (
          <BoardLane key={lane.key} name={lane.name} category={lane.category} count={lane.cards.length} density="page">
            {cards.map(card => (
              <EmbeddedCard key={card.key} card={card} category={lane.category} host={host} onTaskOpen={onTaskOpen} />
            ))}
          </BoardLane>
        );
      })}
      {notes.map(note => noteRow(note.id, note.sentence))}
      {total > FY_RENDER_LIMITS.embedChildren ? (
        <p className="fy-card-embed-more">{total - FY_RENDER_LIMITS.embedChildren} more on the board.</p>
      ) : null}
      {footer}
    </div>
  );
}

function ListedBoard({
  ids,
  host,
  onTaskOpen,
}: {
  readonly ids: readonly string[];
  readonly host: FyRenderCardEmbedHost;
  readonly onTaskOpen: OpenCard;
}) {
  const { connection, store } = host;
  const taskIds = useMemo(() => ids.map(asTaskId), [ids]);
  const states = useBoardTasks(store, connection, taskIds, { beat: false });
  const { lanes, notes, waiting } = useMemo(() => {
    const entries: EmbedEntry[] = [];
    const missing: Note[] = [];
    let pending = 0;
    states.forEach((state, index) => {
      const id = ids[index] ?? '';
      if (state.task !== null) entries.push({ task: state.task, laneSet: state.laneSet });
      else if (state.missing) missing.push({ id, sentence: 'No card with this id.' });
      else if (state.status === 'error') missing.push({ id, sentence: 'This card could not be read.' });
      else pending += 1;
    });
    return { lanes: groupEmbedLanes(connection, entries), notes: missing, waiting: pending };
  }, [states, ids, connection]);
  if (lanes.length === 0 && notes.length === 0) return loading(ids.join(' '));
  return (
    <MiniBoard
      anchor={ids.join(' ')}
      lanes={lanes}
      notes={notes}
      footer={waiting > 0 ? loading(ids.join(' ')) : null}
      host={host}
      onTaskOpen={onTaskOpen}
    />
  );
}

function ChildrenBoard({
  parent,
  host,
  onTaskOpen,
}: {
  readonly parent: string;
  readonly host: FyRenderCardEmbedHost;
  readonly onTaskOpen: OpenCard;
}) {
  const { connection, store } = host;
  const proof = useBoardTask(store, connection, asTaskId(parent), { beat: false });
  const machines = useMemo(() => [{ connection, name: connection.daemonId }], [connection]);
  const { model, status, machines: reads } = useBoard(store, machines, CHILD_FILTERS, { beat: false });
  const truncated = reads.some(read => read.truncated);
  const lanes = useMemo(() => {
    const wanted = (card: BoardCardOf) => card.task.parent?.id === parent;
    return model.groups.flatMap((group): EmbedLane[] => [
      ...group.lanes.map(lane => ({
        key: `${group.key}/${lane.id}`,
        name: lane.name,
        category: lane.category,
        cards: lane.cards.filter(wanted),
      })),
      { key: `${group.key}/unplaced`, name: 'Elsewhere', category: null, cards: group.unplaced.filter(wanted) },
    ]);
  }, [model, parent]);
  if (proof.task === null) {
    if (proof.missing) return noteRow(parent, 'No card with this id.');
    if (proof.status === 'error') return noteRow(parent, 'This card could not be read.');
    return loading(parent);
  }
  const shown = lanes.filter(lane => lane.cards.length > 0);
  const incomplete = truncated ? (
    <p className="fy-card-embed-more" data-fy-card-embed-truncated={parent}>
      The board is too big to read in full, so this list may be incomplete.{' '}
      <a
        href={daemonBoardCardPath(connection.daemonId, parent)}
        onClick={event => {
          if (onTaskOpen === undefined) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          onTaskOpen(parent, event.currentTarget);
        }}
      >
        Open &{parent}
      </a>
    </p>
  ) : null;
  if (shown.length === 0 && status !== 'ready' && status !== 'error') return loading(parent);
  const notes: Note[] =
    shown.length > 0
      ? []
      : [{ id: parent, sentence: status === 'error' ? 'Its cards could not be read.' : 'No cards under this one.' }];
  return (
    <MiniBoard anchor={parent} lanes={shown} notes={notes} footer={incomplete} host={host} onTaskOpen={onTaskOpen} />
  );
}

export function FyRenderCardEmbed({ block, host, onTaskOpen }: FyRenderCardEmbedProps) {
  const { embed } = block;
  const dressing = useCardDressing(host);
  return (
    <DressingContext.Provider value={dressing}>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend; this is a plain labelled group of cards. */}
      <div className="fy-card-embed" data-fy-card-embed={block.type} role="group" aria-label={block.alt}>
        {embed.kind === 'card' ? <CardRow id={embed.id} host={host} onTaskOpen={onTaskOpen} /> : null}
        {embed.kind === 'cards' ? <ListedBoard ids={embed.ids} host={host} onTaskOpen={onTaskOpen} /> : null}
        {embed.kind === 'children' ? <ChildrenBoard parent={embed.parent} host={host} onTaskOpen={onTaskOpen} /> : null}
      </div>
    </DressingContext.Provider>
  );
}
