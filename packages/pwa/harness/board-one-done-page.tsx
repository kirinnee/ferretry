/**
 * The Board's answer rows over one board, drawn by the real `KanbanView`, `PhoneKanban` and `BoardSideTab`
 * (`board-one-done-screenshot.ts` bundles this). `?lanes=merged|older` picks the lane set (Released · to test as one
 * lane, or Released and To test apart), `?surface=kanban|panel|expanded` the view, `?phone=1` the touch layout.
 */

import { LANE_TEMPLATES, type LaneSet } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { PhoneKanban } from '../src/features/board/board-phone.tsx';
import { BoardSideTab } from '../src/features/board/board-side-tab.tsx';
import { type BoardCardEnv, KanbanView } from '../src/features/board/board-views.tsx';
import { type BoardChat, chatCards, chatChip } from '../src/lib/board-chat.ts';
import { boardDone, doneLaneOf, isReleaseLane, notGoodLaneOf } from '../src/lib/board-done.ts';
import { mergeBoard, NO_BOARD_FILTERS } from '../src/lib/board-model.ts';
import { moveChoices } from '../src/lib/board-move.ts';
import { ferretNamer } from '../src/lib/board-present.ts';
import { cardPlaces } from '../src/lib/board-view.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import { COUNTS, card, laneSetFor, laptop, PROJECT } from '../tests/unit/board-support.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const SELF = 'mvuc7tsf-0c3d50df';
const params = new URLSearchParams(window.location.search);
const merged = params.get('lanes') !== 'older';
const phone = params.get('phone') !== null;
const surface = params.get('surface') ?? 'kanban';

const laneSet: LaneSet = merged ? { ...laneSetFor(), ...LANE_TEMPLATES['pr-release-verify'] } : laneSetFor();
const SHIPPED = { version: '4.110.0', tag: 'v4.110.0', at: ago(90) };
const VERIFY = merged ? 'released' : 'tested';

const cards = [
  card('F301', { title: 'Fix tunnel reconnect', laneId: 'implement', owner: SELF, lastTouchedAt: ago(5) }),
  card('F302', { title: 'Merged, not shipped', laneId: 'merged', owner: SELF, lastTouchedAt: ago(30) }),
  card('F303', {
    title: 'Pairing code expires early',
    laneId: VERIFY,
    owner: SELF,
    shippedIn: SHIPPED,
    lastTouchedAt: ago(80),
  }),
  card('F304', {
    title: 'Tasks tab dark flicker',
    laneId: VERIFY,
    owner: SELF,
    shippedIn: SHIPPED,
    lastTouchedAt: ago(70),
  }),
  ...(merged
    ? []
    : [
        card('F305', {
          title: 'Shipped, not tried',
          laneId: 'released',
          owner: SELF,
          shippedIn: SHIPPED,
          lastTouchedAt: ago(85),
        }),
      ]),
];

const model = mergeBoard(
  [
    {
      daemonId: laptop.daemonId,
      machine: 'laptop',
      version: '4.110.0',
      cards,
      laneSets: new Map([[PROJECT, laneSet]]),
      counts: COUNTS,
      quarantined: [],
    },
  ],
  NO_BOARD_FILTERS,
);

const env: BoardCardEnv = {
  names: ferretNamer(new Map([[SELF, 'denisha']])),
  now: NOW,
  showMachine: false,
  touch: phone,
  hrefFor: entry => `/d/laptop/board/${entry.task.id}`,
  onNavigate: () => undefined,
  places: cardPlaces(model),
  dragging: null,
  movesFor: (entry, place) =>
    place.group.laneSet === null || place.category === 'closed'
      ? undefined
      : {
          choices: moveChoices(place.group.laneSet, entry.task.laneId),
          onMove: () => undefined,
          closeLaneId: doneLaneOf(place.group.laneSet),
          reworkLaneId: notGoodLaneOf(place.group.laneSet),
          onDragStart: () => undefined,
          onDragEnd: () => undefined,
        },
  doneFor: (entry, place) => {
    const done = boardDone({
      laneSet: place.group.laneSet,
      category: place.category,
      dropped: entry.task.dropped !== null,
    });
    return done === null
      ? undefined
      : { done, press: () => undefined, atRelease: isReleaseLane(place.group.laneSet, entry.task.laneId) };
  },
};

const chatCardsOf = chatCards(model, {
  daemonId: laptop.daemonId,
  sessionId: SELF,
  focus: null,
  relatives: new Set(),
  agents: false,
});
const chat: BoardChat = {
  chip: chatChip(undefined, chatCardsOf.focus, undefined, 'ready'),
  cards: chatCardsOf,
  status: 'ready',
  refresh: () => undefined,
  agents: false,
  splitsAgents: false,
};

const surfaces = {
  kanban: phone ? (
    <PhoneKanban
      at={params.get('at') ?? VERIFY}
      env={env}
      hideClosed
      model={model}
      onLane={() => undefined}
      projectName={() => 'Ferretry'}
    />
  ) : (
    <KanbanView env={env} hideClosed model={model} onDropCard={() => undefined} projectName={() => 'Ferretry'} />
  ),
  panel: (
    <BoardSideTab
      callsigns={new Map([[SELF, 'denisha']])}
      chat={chat}
      density="side"
      doneFor={env.doneFor}
      movesFor={env.movesFor}
      now={NOW}
      onAgents={() => undefined}
      onOpenCard={() => undefined}
      onView={() => undefined}
      scope={daemonSessionScope(laptop, SELF)}
      view="list"
    />
  ),
  expanded: (
    <BoardSideTab
      callsigns={new Map([[SELF, 'denisha']])}
      chat={chat}
      density="page"
      doneFor={env.doneFor}
      movesFor={env.movesFor}
      now={NOW}
      onAgents={() => undefined}
      onExpand={() => undefined}
      onOpenCard={() => undefined}
      onView={() => undefined}
      scope={daemonSessionScope(laptop, SELF)}
      view="kanban"
    />
  ),
} as const;

const root = document.getElementById('root');
if (root === null) throw new Error('no root');
createRoot(root).render(
  <div data-fixture="" style={{ padding: phone ? 0 : 16, maxWidth: surface === 'panel' ? 380 : undefined }}>
    {surfaces[surface === 'panel' || surface === 'expanded' ? surface : 'kanban']}
  </div>,
);
