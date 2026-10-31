import { afterEach, describe, expect, it } from 'bun:test';
import { LANE_TEMPLATES, type LaneSet } from '@ferretry/protocol';
import { BoardCard } from '../../../src/features/board/board-card.tsx';
import { BoardSideTab } from '../../../src/features/board/board-side-tab.tsx';
import { TableView } from '../../../src/features/board/board-table.tsx';
import { type BoardCardEnv, KanbanView } from '../../../src/features/board/board-views.tsx';
import { type BoardChat, chatCards, chatChip } from '../../../src/lib/board-chat.ts';
import { boardDone, doneLaneOf, isReleaseLane, notGoodLaneOf } from '../../../src/lib/board-done.ts';
import { mergeBoard, NO_BOARD_FILTERS } from '../../../src/lib/board-model.ts';
import { moveChoices } from '../../../src/lib/board-move.ts';
import { ferretNamer } from '../../../src/lib/board-present.ts';
import { cardPlaces } from '../../../src/lib/board-view.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';
import { COUNTS, card, laneSetFor, laptop, PROJECT } from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const SELF = 's1';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const MERGED: LaneSet = {
  ...laneSetFor(),
  ...LANE_TEMPLATES['pr-release-verify'],
};
const OLDER: LaneSet = laneSetFor();

const SHIPPED = { version: '4.110.0', tag: 'v4.110.0', at: '2026-08-01T09:00:00.000Z' };

const modelOf = (laneSet: LaneSet, laneIds: readonly string[]) =>
  mergeBoard(
    [
      {
        daemonId: laptop.daemonId,
        machine: 'laptop',
        version: '4.110.0',
        cards: laneIds.map((laneId, index) =>
          card(`F${index + 1}`, { laneId, owner: SELF, shippedIn: SHIPPED, title: `Card in ${laneId}` }),
        ),
        laneSets: new Map([[PROJECT, laneSet]]),
        counts: COUNTS,
        quarantined: [],
      },
    ],
    NO_BOARD_FILTERS,
  );

/** The env the Board page builds: the same moves and the same Done wiring. */
const envOf = (model: ReturnType<typeof modelOf>): BoardCardEnv => ({
  names: ferretNamer(new Map()),
  now: NOW,
  showMachine: false,
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
      : {
          done,
          press: () => undefined,
          atRelease: isReleaseLane(place.group.laneSet, entry.task.laneId),
        };
  },
});

/** Every control that answers "it works": the verdict Done and the Done-only button, never the ⋯ menu item. */
const doneButtons = (root: Element): readonly Element[] => [
  ...root.querySelectorAll('[data-verdict="works"], .fy-board-done[data-done="done"]'),
];

const perCard = (root: HTMLElement): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const node of root.querySelectorAll<HTMLElement>('[data-task]')) {
    const id = must(node.dataset.task, 'a task id');
    counts.set(id, (counts.get(id) ?? 0) + doneButtons(node).length);
  }
  return counts;
};

const BOARDS = [
  {
    name: 'the merged Released · to test lane',
    laneSet: MERGED,
    verify: 'released',
    laneIds: ['implement', 'merged', 'released'],
  },
  {
    name: 'an older board with Released and To test apart',
    laneSet: OLDER,
    verify: 'tested',
    laneIds: ['implement', 'released', 'tested'],
  },
] as const;

describe.each(BOARDS)('one Done per card on $name', ({ laneSet, verify, laneIds }) => {
  const check = (root: HTMLElement, expectVerify: string) => {
    const counts = perCard(root);
    expect(counts.size).toBeGreaterThan(0);
    for (const [, count] of counts) expect(count).toBeLessThanOrEqual(1);
    const verifyCard = [...root.querySelectorAll<HTMLElement>('[data-task]')].find(node =>
      node.textContent?.includes(`Card in ${expectVerify}`),
    );
    if (verifyCard !== undefined) {
      expect(doneButtons(verifyCard)).toHaveLength(1);
      expect(verifyCard.querySelectorAll('[data-verdict="not-good"]')).toHaveLength(1);
      expect(verifyCard.querySelectorAll('.fy-board-card__verdict')).toHaveLength(1);
    }
  };

  it('Kanban', async () => {
    const model = await modelOf(laneSet, laneIds);
    view = await mount(
      <KanbanView
        env={envOf(model)}
        hideClosed={false}
        model={model}
        onDropCard={() => undefined}
        projectName={() => 'ferretry'}
      />,
    );
    check(view.container, verify);
  });

  it('Table', async () => {
    const model = await modelOf(laneSet, laneIds);
    view = await mount(<TableView env={envOf(model)} model={model} onWindow={() => undefined} window="7d" />);
    check(view.container, verify);
  });

  it.each(['side', 'page'] as const)(
    'the Info › Tasks panel at %s density, as a list and as a kanban',
    async density => {
      const model = await modelOf(laneSet, laneIds);
      const env = envOf(model);
      for (const sideView of ['list', 'kanban'] as const) {
        const cards = chatCards(model, {
          daemonId: laptop.daemonId,
          sessionId: SELF,
          focus: null,
          relatives: new Set(),
          agents: false,
        });
        const chat: BoardChat = {
          chip: chatChip(undefined, cards.focus, undefined, 'ready'),
          cards,
          status: 'ready',
          refresh: () => undefined,
          agents: false,
          splitsAgents: false,
        };
        view = await mount(
          <BoardSideTab
            callsigns={new Map()}
            chat={chat}
            density={density}
            doneFor={env.doneFor}
            movesFor={env.movesFor}
            now={NOW}
            onAgents={() => undefined}
            onOpenCard={() => undefined}
            onView={() => undefined}
            scope={daemonSessionScope(laptop, SELF)}
            view={sideView}
          />,
        );
        check(view.container, verify);
        await view.unmount();
        view = null;
      }
    },
  );

  it('a lone card in the verify lane, with and without the ability to move it', async () => {
    const model = await modelOf(laneSet, [verify]);
    const env = envOf(model);
    const entry = must(model.cards[0], 'the card');
    const place = must(env.places.get(entry.key), 'its place');
    for (const movable of [true, false]) {
      view = await mount(
        <ul>
          <BoardCard
            card={entry}
            category={place.category}
            density="page"
            done={env.doneFor?.(entry, place)}
            href="/x"
            moves={movable ? env.movesFor(entry, place) : undefined}
            names={env.names}
            now={NOW}
            showMachine={false}
          />
        </ul>,
      );
      expect(doneButtons(view.container).length).toBe(movable ? 1 : doneButtons(view.container).length);
      expect(doneButtons(view.container).length).toBeLessThanOrEqual(1);
      await view.unmount();
      view = null;
    }
  });
});

describe('the Released lane of an older board keeps its Done-only row', () => {
  it('draws Done without Not good', async () => {
    const model = await modelOf(OLDER, ['released']);
    const env = envOf(model);
    const entry = must(model.cards[0], 'the card');
    const place = must(env.places.get(entry.key), 'its place');
    view = await mount(
      <ul>
        <BoardCard
          card={entry}
          category={place.category}
          density="page"
          done={env.doneFor?.(entry, place)}
          href="/x"
          moves={env.movesFor(entry, place)}
          names={env.names}
          now={NOW}
          showMachine={false}
        />
      </ul>,
    );
    expect(doneButtons(view.container)).toHaveLength(1);
    expect(view.container.querySelector('[data-verdict="not-good"]')).toBeNull();
  });
});
