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
 *    view the same way and shows the children that view holds, grouped by lane.
 *  - ONE RENDERER. A host that has no board to read (`cardEmbed` absent) never reaches this file: the fence
 *    stays an ordinary code fence, as any block this build cannot draw does.
 */

import type { BoardTaskId } from '@ferretry/protocol';
import { FileWarning } from 'lucide-react';
import { useMemo } from 'react';

import { BoardCard } from '../features/board/board-card.tsx';
import { useBoard, useBoardTask } from '../hooks/use-board.ts';
import { boardCardKey, NO_BOARD_FILTERS } from '../lib/board-model.ts';
import { fallbackFerretName } from '../lib/board-present.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { BoardCardOf } from '../lib/board-view.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { FY_RENDER_LIMITS } from '../lib/fy-render-bounds.ts';
import type { FyRenderEmbedBlock } from '../lib/fy-render.ts';
import { daemonBoardCardPath } from '../lib/pages/routes.ts';

/** What a host that can read a board lends a block: where to read, and the machine to read it from. */
export interface FyRenderCardEmbedHost {
  readonly store: DaemonBoardStore;
  readonly connection: DaemonConnection;
}

export interface FyRenderCardEmbedProps {
  readonly block: FyRenderEmbedBlock;
  readonly host: FyRenderCardEmbedHost;
  /** Opens a card the way a written `&F12` does; absent, the card is still a plain link to its page. */
  readonly onTaskOpen?: ((id: string, opener?: HTMLElement | null) => void) | undefined;
}

/** Sub-cards are private bookkeeping, and a closed one is still a child worth showing. */
const CHILD_FILTERS = Object.freeze({ ...NO_BOARD_FILTERS, state: 'all' as const, agents: true });

const asTaskId = (id: string): BoardTaskId => id as BoardTaskId;

const noteRow = (id: string, sentence: string) => (
  <div className="fy-render-row" data-fy-card-embed-note={id} role="note">
    <FileWarning aria-hidden="true" className="fy-render-row-icon" data-tone="warn" size={18} />
    <div className="fy-render-row-body">
      <span className="fy-render-row-name">&{id}</span>
      <span className="fy-render-row-meta">{sentence}</span>
    </div>
  </div>
);

function CardRow({
  id,
  host,
  onTaskOpen,
  showLane,
}: {
  readonly id: string;
  readonly host: FyRenderCardEmbedHost;
  readonly onTaskOpen: FyRenderCardEmbedProps['onTaskOpen'];
  readonly showLane: boolean;
}) {
  const { connection, store } = host;
  const state = useBoardTask(store, connection, asTaskId(id), { beat: false });
  const card: BoardCardOf | null = useMemo(
    () =>
      state.task === null
        ? null
        : {
            key: boardCardKey(connection.daemonId, state.task.id),
            daemonId: connection.daemonId,
            machine: connection.daemonId,
            task: state.task,
            runningOn: [],
          },
    [state.task, connection.daemonId],
  );
  if (card === null || state.task === null) {
    if (state.missing) return noteRow(id, 'No card with this id.');
    if (state.status === 'error') return noteRow(id, 'This card could not be read.');
    return <div className="fy-card-embed-loading" data-fy-card-embed-loading={id} aria-hidden="true" />;
  }
  const task = state.task;
  const lane = state.laneSet?.lanes.find(candidate => candidate.id === task.laneId);
  return (
    <ul className="fy-card-embed-list" data-fy-card-embed-card={task.id}>
      <BoardCard
        card={card}
        density="page"
        category={lane?.category ?? null}
        names={fallbackFerretName}
        now={Date.now()}
        showMachine={false}
        href={daemonBoardCardPath(connection.daemonId, task.id)}
        {...(onTaskOpen === undefined ? {} : { onNavigate: () => onTaskOpen(task.id) })}
        {...(showLane && lane !== undefined ? { lane: lane.name } : {})}
      />
    </ul>
  );
}

function ChildrenBoard({
  parent,
  host,
  onTaskOpen,
}: {
  readonly parent: string;
  readonly host: FyRenderCardEmbedHost;
  readonly onTaskOpen: FyRenderCardEmbedProps['onTaskOpen'];
}) {
  const { connection, store } = host;
  const machines = useMemo(() => [{ connection, name: connection.daemonId }], [connection]);
  const { model, status } = useBoard(store, machines, CHILD_FILTERS, { beat: false });
  const lanes = useMemo(() => {
    const wanted = (card: BoardCardOf) => card.task.parent?.id === parent;
    return model.groups.flatMap(group => [
      ...group.lanes.map(lane => ({
        key: `${group.key}/${lane.id}`,
        name: lane.name,
        category: lane.category,
        cards: lane.cards.filter(wanted),
      })),
      { key: `${group.key}/unplaced`, name: 'Elsewhere', category: null, cards: group.unplaced.filter(wanted) },
    ]);
  }, [model, parent]);
  const shown = lanes.filter(lane => lane.cards.length > 0);
  if (shown.length === 0)
    return status === 'ready' || status === 'error' ? (
      noteRow(parent, status === 'error' ? 'Its cards could not be read.' : 'No cards under this one.')
    ) : (
      <div className="fy-card-embed-loading" data-fy-card-embed-loading={parent} aria-hidden="true" />
    );
  const total = shown.reduce((sum, lane) => sum + lane.cards.length, 0);
  let budget = FY_RENDER_LIMITS.embedChildren;
  return (
    <div className="fy-card-embed-board" data-fy-card-embed-board={parent}>
      {shown.map(lane => {
        const cards = lane.cards.slice(0, Math.max(0, budget));
        budget -= cards.length;
        if (cards.length === 0) return null;
        return (
          <section key={lane.key} className="fy-card-embed-lane" data-category={lane.category ?? 'unplaced'}>
            <h4 className="fy-card-embed-lane-name">
              {lane.name} <span className="fy-card-embed-lane-count">{lane.cards.length}</span>
            </h4>
            <ul className="fy-card-embed-list">
              {cards.map(card => (
                <BoardCard
                  key={card.key}
                  card={card}
                  density="page"
                  category={lane.category}
                  names={fallbackFerretName}
                  now={Date.now()}
                  showMachine={false}
                  href={daemonBoardCardPath(connection.daemonId, card.task.id)}
                  {...(onTaskOpen === undefined ? {} : { onNavigate: () => onTaskOpen(card.task.id) })}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {total > FY_RENDER_LIMITS.embedChildren ? (
        <p className="fy-card-embed-more">{total - FY_RENDER_LIMITS.embedChildren} more on the board.</p>
      ) : null}
    </div>
  );
}

export function FyRenderCardEmbed({ block, host, onTaskOpen }: FyRenderCardEmbedProps) {
  const { embed } = block;
  const open = onTaskOpen;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend; this is a plain labelled group of cards.
    <div className="fy-card-embed" data-fy-card-embed={block.type} role="group" aria-label={block.alt}>
      {embed.kind === 'card' ? <CardRow id={embed.id} host={host} onTaskOpen={open} showLane /> : null}
      {embed.kind === 'cards'
        ? embed.ids.map(id => <CardRow key={id} id={id} host={host} onTaskOpen={open} showLane />)
        : null}
      {embed.kind === 'children' ? <ChildrenBoard parent={embed.parent} host={host} onTaskOpen={open} /> : null}
    </div>
  );
}
