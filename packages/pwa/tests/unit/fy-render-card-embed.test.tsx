import { afterEach, describe, expect, it } from 'bun:test';
import type { BoardTaskView } from '@ferretry/protocol';

import { FyRenderCardEmbed } from '../../src/components/fy-render-card-embed.tsx';
import { DaemonBoardStore } from '../../src/lib/board-store.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { type AppStore, StoreProvider } from '../../src/lib/store.tsx';
import { sessionView } from '../support/sessions.ts';
import { type FyRenderParsedBlock, isFyRenderEmbedBlock, parseFyRender } from '../../src/lib/fy-render.ts';
import { FY_RENDER_LIMITS } from '../../src/lib/fy-render-bounds.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { installManualClock } from '../support/manual-clock.ts';
import {
  boardAnswer,
  card,
  deferred,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
  OTHER_PROJECT,
  PROJECT,
} from './board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const lanes = laneSetFor();

const blockOf = (type: 'card' | 'board', payload: string) => {
  const result = parseFyRender([`type: ${type}`, 'alt: Live work', '---', payload].join('\n'));
  const block: FyRenderParsedBlock | undefined = result.ok ? result.block : undefined;
  if (block === undefined || !isFyRenderEmbedBlock(block)) throw new Error('fixture is not an embed block');
  return block;
};

const changed = (...taskIds: string[]) => ({ type: 'board.changed', data: { projectId: PROJECT, taskIds } });

/** A store whose machine serves `cards` by id; the map is mutable so a test can move one. */
const serving = (cards: Map<string, BoardTaskView>, fail: Set<string> = new Set()) => {
  const environment = fakeEnvironment();
  const port = fakePort({
    task: async (_daemon, id) => {
      if (fail.has(id)) throw new Error('unreadable');
      const task = cards.get(id);
      return task === undefined ? null : { task, laneSet: lanes };
    },
    board: async () => boardAnswer([...cards.values()], { projectId: PROJECT, laneSet: lanes }),
  });
  return { store: new DaemonBoardStore(port, environment), port, environment };
};

const show = async (
  store: DaemonBoardStore,
  block: ReturnType<typeof blockOf>,
  onTaskOpen?: (id: string) => void,
  callsigns?: ReadonlyMap<string, string>,
) => {
  view = await mount(
    <FyRenderCardEmbed
      block={block}
      host={{ store, connection: laptop, ...(callsigns === undefined ? {} : { callsigns }) }}
      onTaskOpen={onTaskOpen}
    />,
  );
  await interact(() => flush());
  return view;
};

const text = (mounted: Mounted) => mounted.container.textContent ?? '';

describe('FyRenderCardEmbed: a card', () => {
  it('draws the real board card with its title and lane', async () => {
    const { store } = serving(new Map([['F1', card('F1', { title: 'Ship the thing' })]]));
    const mounted = await show(store, blockOf('card', '&F1'));
    expect(mounted.container.querySelector('[data-fy-card-embed="card"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-fy-card-embed-card="F1"]')).not.toBeNull();
    expect(text(mounted)).toContain('Ship the thing');
    expect(text(mounted)).toContain('Implement');
  });

  it('updates when a board.changed event says the card moved lane, without a timer', async () => {
    const cards = new Map([['F1', card('F1', { title: 'Ship the thing' })]]);
    const { store, environment } = serving(cards);
    const mounted = await show(store, blockOf('card', '&F1'));
    expect(text(mounted)).toContain('Implement');
    expect(text(mounted)).not.toContain('Review/CI');
    expect(environment.pending()).toBe(0);

    cards.set('F1', card('F1', { title: 'Ship the thing', laneId: 'review' }));
    await interact(async () => {
      store.noteEvent(laptop.daemonId, changed('F1'));
      await flush();
    });
    expect(text(mounted)).toContain('Review/CI');
    expect(text(mounted)).not.toContain('Implement');
    expect(environment.pending()).toBe(0);
  });

  it('opens the card the way a written reference does when it is clicked', async () => {
    const opened: string[] = [];
    const { store } = serving(new Map([['F1', card('F1')]]));
    const mounted = await show(store, blockOf('card', '&F1'), id => opened.push(id));
    const link = mounted.container.querySelector<HTMLAnchorElement>('[data-fy-card-embed-card="F1"] a');
    expect(link).not.toBeNull();
    await interact(() => link?.click());
    expect(opened).toEqual(['F1']);
  });

  it('says so, in a quiet row and never as a link, when the card does not exist', async () => {
    const { store } = serving(new Map());
    const mounted = await show(store, blockOf('card', '&F404'));
    const note = mounted.container.querySelector('[data-fy-card-embed-note="F404"]');
    expect(note?.textContent).toContain('No card with this id.');
    expect(mounted.container.querySelector('a')).toBeNull();
  });

  it('says so when the card cannot be read', async () => {
    const { store } = serving(new Map([['F1', card('F1')]]), new Set(['F1']));
    const mounted = await show(store, blockOf('card', '&F1'));
    expect(mounted.container.querySelector('[data-fy-card-embed-note="F1"]')?.textContent).toContain(
      'could not be read',
    );
    expect(mounted.container.querySelector('a')).toBeNull();
  });

  it('holds a placeholder, not a link, until the daemon has answered', async () => {
    const held = deferred<{ task: BoardTaskView; laneSet: typeof lanes } | null>();
    const store = new DaemonBoardStore(fakePort({ task: async () => await held.promise }), fakeEnvironment());
    view = await mount(<FyRenderCardEmbed block={blockOf('card', '&F1')} host={{ store, connection: laptop }} />);
    expect(view.container.querySelector('[data-fy-card-embed-loading="F1"]')).not.toBeNull();
    expect(view.container.querySelector('a')).toBeNull();
    held.resolve({ task: card('F1'), laneSet: lanes });
    await interact(() => flush());
    expect(view.container.querySelector('[data-fy-card-embed-loading]')).toBeNull();
    expect(view.container.querySelector('a')).not.toBeNull();
  });

  it('lets go of its watch on unmount, so a later event reads nothing', async () => {
    const cards = new Map([['F1', card('F1')]]);
    const { store, port } = serving(cards);
    const mounted = await show(store, blockOf('card', '&F1'));
    const reads = port.calls.filter(call => call.startsWith('task:')).length;
    await mounted.unmount();
    view = null;
    store.noteEvent(laptop.daemonId, changed('F1'));
    await flush();
    expect(port.calls.filter(call => call.startsWith('task:'))).toHaveLength(reads);
    expect(store.taskState(laptop.daemonId, 'F1').status).toBe('idle');
  });
});

describe('FyRenderCardEmbed: how a card reads', () => {
  const LEAD = 'mvuc7tsf-0c3d50df';

  it('names the ferret by its callsign, never by the start of its session id', async () => {
    const { store } = serving(new Map([['F1', card('F1', { owner: LEAD })]]));
    const mounted = await show(store, blockOf('card', '&F1'), undefined, new Map([[LEAD, 'nimbus']]));
    expect(text(mounted)).toContain('Nimbus');
    expect(text(mounted)).not.toContain('mvuc7tsf');
  });

  it('falls back to the start of the id for a ferret with no callsign', async () => {
    const { store } = serving(new Map([['F1', card('F1', { owner: LEAD })]]));
    const mounted = await show(store, blockOf('card', '&F1'));
    expect(text(mounted)).toContain('mvuc7tsf');
  });

  it("names the ferret from the app's fleet when the surface lends no list", async () => {
    const fleet = new DaemonFleetStore({ list: async () => [], get: async () => sessionView(LEAD) });
    fleet.seed(laptop, [sessionView(LEAD, { config: { teammate: 'nimbus' } })], 1);
    const store = { fleet } as unknown as AppStore;
    const { store: board } = serving(new Map([['F1', card('F1', { owner: LEAD })]]));
    view = await mount(
      <StoreProvider store={store}>
        <FyRenderCardEmbed block={blockOf('card', '&F1')} host={{ store: board, connection: laptop }} />
      </StoreProvider>,
    );
    await interact(() => flush());
    expect(text(view)).toContain('Nimbus');
    expect(text(view)).not.toContain('mvuc7tsf');
  });

  it('watches the fleet once, not again on every clock tick', async () => {
    const clock = installManualClock();
    try {
      const settle = async () => {
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      };
      const fleet = new DaemonFleetStore({ list: async () => [], get: async () => sessionView(LEAD) });
      const subscribe = fleet.subscribe.bind(fleet);
      let subscriptions = 0;
      fleet.subscribe = listener => {
        subscriptions += 1;
        return subscribe(listener);
      };
      const store = { fleet } as unknown as AppStore;
      const { store: board } = serving(new Map([['F1', card('F1')]]));
      view = await mount(
        <StoreProvider store={store}>
          <FyRenderCardEmbed block={blockOf('card', '&F1')} host={{ store: board, connection: laptop }} />
        </StoreProvider>,
      );
      await interact(settle);
      const before = subscriptions;
      expect(before).toBeGreaterThan(0);
      await interact(async () => {
        clock.advance(2 * 30_000);
        await settle();
      });
      expect(subscriptions).toBe(before);
    } finally {
      clock.restore();
    }
  });

  it('ticks its ages on a local clock, without reading the daemon again', async () => {
    const clock = installManualClock();
    try {
      const touched = new Date(Date.now() - 2 * 60_000).toISOString();
      const { store, port } = serving(new Map([['F1', card('F1', { lastTouchedAt: touched })]]));
      const settle = async () => {
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      };
      view = await mount(<FyRenderCardEmbed block={blockOf('card', '&F1')} host={{ store, connection: laptop }} />);
      await interact(settle);
      const mounted = view;
      const reads = port.calls.length;
      expect(text(mounted)).toContain('2m');
      await interact(async () => {
        clock.advance(3 * 60_000);
        await settle();
      });
      expect(text(mounted)).toContain('5m');
      expect(port.calls).toHaveLength(reads);
    } finally {
      clock.restore();
    }
  });
});

describe('FyRenderCardEmbed: a board', () => {
  it("draws a list board as lanes in the board's lane order, with the missing card last", async () => {
    const { store } = serving(
      new Map([
        ['F1', card('F1', { title: 'First', laneId: 'review' })],
        ['F2', card('F2', { title: 'Second', laneId: 'todo' })],
        ['F3', card('F3', { title: 'Third', laneId: 'review' })],
      ]),
    );
    const mounted = await show(store, blockOf('board', '&F1\n&F2\n&F9\n&F3'));
    const frame = mounted.container.querySelector('.fy-card-embed-board');
    expect(frame).not.toBeNull();
    const heads = [...mounted.container.querySelectorAll('.fy-board-lane__name')].map(el => el.textContent);
    expect(heads).toEqual(['Todo', 'Review/CI']);
    const counts = [...mounted.container.querySelectorAll('.fy-board-lane__count')].map(el => el.textContent);
    expect(counts).toEqual(['1', '2']);
    expect(text(mounted)).toContain('First');
    expect(text(mounted)).toContain('Third');
    const note = mounted.container.querySelector('[data-fy-card-embed-note="F9"]');
    expect(note).not.toBeNull();
    const last = [...(frame?.children ?? [])].at(-1);
    expect(last).toBe(note ?? undefined);
  });

  it('moves a card between lanes of a list board on board.changed', async () => {
    const cards = new Map([
      ['F1', card('F1', { title: 'First' })],
      ['F2', card('F2', { title: 'Second' })],
    ]);
    const { store } = serving(cards);
    const mounted = await show(store, blockOf('board', '&F1 &F2'));
    const heads = () => [...mounted.container.querySelectorAll('.fy-board-lane__name')].map(el => el.textContent);
    expect(heads()).toEqual(['Implement']);
    cards.set('F2', card('F2', { title: 'Second', laneId: 'review' }));
    await interact(async () => {
      store.noteEvent(laptop.daemonId, changed('F2'));
      await flush();
    });
    expect(heads()).toEqual(['Implement', 'Review/CI']);
  });

  it('groups the children of a parent by lane and follows a lane move on board.changed', async () => {
    const cards = new Map<string, BoardTaskView>([
      ['F10', card('F10', { title: 'Parent' })],
      ['F11', card('F11', { title: 'Child one', parent: { id: 'F10' } })],
      ['F12', card('F12', { title: 'Child two', parent: { id: 'F10' }, laneId: 'review' })],
      ['F13', card('F13', { title: 'Stranger' })],
    ]);
    const { store, environment } = serving(cards);
    const mounted = await show(store, blockOf('board', 'parent: &F10'));
    const names = () => [...mounted.container.querySelectorAll('.fy-board-lane__head')].map(el => el.textContent);
    expect(text(mounted)).toContain('Child one');
    expect(text(mounted)).toContain('Child two');
    expect(text(mounted)).not.toContain('Stranger');
    expect(names()).toHaveLength(2);
    expect(mounted.container.querySelector('.fy-card-embed-board')).not.toBeNull();
    expect(environment.pending()).toBe(0);

    cards.set('F11', card('F11', { title: 'Child one', parent: { id: 'F10' }, laneId: 'review' }));
    await interact(async () => {
      store.noteEvent(laptop.daemonId, changed('F11'));
      await flush();
    });
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain('Review/CI');
    expect(names()[0]).toContain('2');
  });

  it('says when a parent has no cards under it', async () => {
    const { store } = serving(new Map([['F10', card('F10')]]));
    const mounted = await show(store, blockOf('board', 'parent: &F10'));
    expect(mounted.container.querySelector('[data-fy-card-embed-note="F10"]')?.textContent).toContain(
      'No cards under this one.',
    );
  });

  it('says there is no such card, not that it has no children, when the parent does not exist', async () => {
    const { store } = serving(new Map());
    const mounted = await show(store, blockOf('board', 'parent: &F999'));
    expect(mounted.container.querySelector('[data-fy-card-embed-note="F999"]')?.textContent).toContain(
      'No card with this id.',
    );
    expect(mounted.container.querySelector('.fy-card-embed-board')).toBeNull();
  });

  it('says the list may be incomplete, and links the parent, when the board was too big to read in full', async () => {
    let pages = 0;
    const opened: string[] = [];
    const environment = fakeEnvironment();
    const port = fakePort({
      task: async () => ({ task: card('F10'), laneSet: lanes }),
      board: async () => {
        pages += 1;
        return boardAnswer([card(`F${100 + pages}`, { parent: { id: 'F10' } })], {
          projectId: PROJECT,
          laneSet: lanes,
          nextCursor: 'more',
        });
      },
    });
    const mounted = await show(new DaemonBoardStore(port, environment), blockOf('board', 'parent: &F10'), id =>
      opened.push(id),
    );
    const note = mounted.container.querySelector('[data-fy-card-embed-truncated="F10"]');
    expect(note?.textContent).toContain('may be incomplete');
    const link = note?.querySelector('a');
    expect(link).not.toBeNull();
    await interact(() => link?.click());
    expect(opened).toEqual(['F10']);
  });

  it('leaves a modified click on the truncation link to the browser', async () => {
    const opened: string[] = [];
    const environment = fakeEnvironment();
    const port = fakePort({
      task: async () => ({ task: card('F10'), laneSet: lanes }),
      board: async () =>
        boardAnswer([card('F101', { parent: { id: 'F10' } })], {
          projectId: PROJECT,
          laneSet: lanes,
          nextCursor: 'more',
        }),
    });
    const mounted = await show(new DaemonBoardStore(port, environment), blockOf('board', 'parent: &F10'), id =>
      opened.push(id),
    );
    const link = mounted.container.querySelector('[data-fy-card-embed-truncated="F10"] a');
    expect(link).not.toBeNull();
    const press = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    await interact(() => link?.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
  });

  it('keeps each project together, in the order its first card was listed, when a list spans projects', async () => {
    const other = laneSetFor(OTHER_PROJECT);
    const cards = new Map<string, BoardTaskView>([
      ['F1', card('F1', { laneId: 'review' })],
      ['F2', card('F2', { laneId: 'todo', projectId: OTHER_PROJECT })],
      ['F3', card('F3', { laneId: 'todo' })],
    ]);
    const environment = fakeEnvironment();
    const port = fakePort({
      task: async (_daemon, id) => {
        const task = cards.get(id);
        return task === undefined ? null : { task, laneSet: task.projectId === OTHER_PROJECT ? other : lanes };
      },
      board: async () => boardAnswer([], { projectId: PROJECT, laneSet: lanes }),
    });
    const mounted = await show(new DaemonBoardStore(port, environment), blockOf('board', '&F1\n&F2\n&F3'));
    const heads = [...mounted.container.querySelectorAll('.fy-board-lane__name')].map(el => el.textContent);
    expect(heads).toEqual(['Todo', 'Review/CI', 'Todo']);
  });

  it('says when the children cannot be read', async () => {
    const environment = fakeEnvironment();
    const port = fakePort({
      task: async () => ({ task: card('F10'), laneSet: lanes }),
      board: async () => {
        throw new Error('down');
      },
    });
    const mounted = await show(new DaemonBoardStore(port, environment), blockOf('board', 'parent: &F10'));
    expect(mounted.container.querySelector('[data-fy-card-embed-note="F10"]')?.textContent).toContain(
      'could not be read',
    );
  });

  it('shows at most the child cap and says how many more the board holds', async () => {
    const extra = FY_RENDER_LIMITS.embedChildren + 3;
    const cards = new Map<string, BoardTaskView>([['F10', card('F10')]]);
    for (let index = 1; index <= extra; index += 1)
      cards.set(`F${100 + index}`, card(`F${100 + index}`, { parent: { id: 'F10' } }));
    const { store } = serving(cards);
    const mounted = await show(store, blockOf('board', 'parent: &F10'));
    expect(mounted.container.querySelectorAll('li')).toHaveLength(FY_RENDER_LIMITS.embedChildren);
    expect(mounted.container.querySelector('.fy-card-embed-more')?.textContent).toBe('3 more on the board.');
  });
});
