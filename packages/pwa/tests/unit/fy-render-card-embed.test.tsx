import { afterEach, describe, expect, it } from 'bun:test';
import type { BoardTaskView } from '@ferretry/protocol';

import { FyRenderCardEmbed } from '../../src/components/fy-render-card-embed.tsx';
import { DaemonBoardStore } from '../../src/lib/board-store.ts';
import { FY_RENDER_LIMITS } from '../../src/lib/fy-render-bounds.ts';
import { type FyRenderParsedBlock, isFyRenderEmbedBlock, parseFyRender } from '../../src/lib/fy-render.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import {
  boardAnswer,
  card,
  deferred,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
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

const show = async (store: DaemonBoardStore, block: ReturnType<typeof blockOf>, onTaskOpen?: (id: string) => void) => {
  view = await mount(<FyRenderCardEmbed block={block} host={{ store, connection: laptop }} onTaskOpen={onTaskOpen} />);
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

describe('FyRenderCardEmbed: a board', () => {
  it('lists the named cards, each one the real card, and notes the one that is missing', async () => {
    const { store } = serving(
      new Map([
        ['F1', card('F1', { title: 'First' })],
        ['F2', card('F2', { title: 'Second' })],
      ]),
    );
    const mounted = await show(store, blockOf('board', '&F1\n&F2\n&F9'));
    expect(text(mounted)).toContain('First');
    expect(text(mounted)).toContain('Second');
    expect(mounted.container.querySelectorAll('[data-fy-card-embed-card]')).toHaveLength(2);
    expect(mounted.container.querySelector('[data-fy-card-embed-note="F9"]')).not.toBeNull();
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
    const names = () => [...mounted.container.querySelectorAll('.fy-card-embed-lane-name')].map(el => el.textContent);
    expect(text(mounted)).toContain('Child one');
    expect(text(mounted)).toContain('Child two');
    expect(text(mounted)).not.toContain('Stranger');
    expect(names()).toHaveLength(2);
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

  it('says when the children cannot be read', async () => {
    const environment = fakeEnvironment();
    const port = fakePort({
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
    const cards = new Map<string, BoardTaskView>();
    for (let index = 1; index <= extra; index += 1)
      cards.set(`F${100 + index}`, card(`F${100 + index}`, { parent: { id: 'F10' } }));
    const { store } = serving(cards);
    const mounted = await show(store, blockOf('board', 'parent: &F10'));
    expect(mounted.container.querySelectorAll('li')).toHaveLength(FY_RENDER_LIMITS.embedChildren);
    expect(mounted.container.querySelector('.fy-card-embed-more')?.textContent).toBe('3 more on the board.');
  });
});
