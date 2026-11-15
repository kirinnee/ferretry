import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount } from '@ferretry/app/testing';
import { FY_RENDER_LIMITS } from '@ferretry/plugin-conversation/contract';
import type { CardView } from '../../../contract/index.ts';
import { ferretNamer } from '../../../app/lib/board-present.ts';
import { DaemonBoardStore } from '../../../app/lib/board-store.ts';
import type { EmbedSpec } from '../../../app/lib/embed-lanes.ts';
import { THIS_MACHINE } from '../../../app/lib/machine.ts';
import { CardEmbed } from '../../../app/views/embed.tsx';
import { boardAnswer, card, deferred, fakeEnvironment, fakePort, flush, laneSetFor, PROJECT } from './board-support.ts';

/**
 * A `card` / `board` block in chat, drawn by the Board: the real card and lane header, read from the board, live on
 * `board.changed` with no timer, and never a link for a card that was not read.
 */

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const lanes = laneSetFor();
const changed = (...cardIds: string[]) => ({ projectId: PROJECT, cardIds });
const names = ferretNamer(new Map([['mvuc7tsf-0c3d50df', 'nimbus']]));

/** A store whose machine serves `cards` by id; the map is mutable so a test can move one, and `fail` ids refuse. */
const serving = (
  cards: Map<string, CardView>,
  fail: Set<string> = new Set(),
  extra: Parameters<typeof boardAnswer>[1] = {},
) => {
  const environment = fakeEnvironment();
  const port = fakePort({
    card: async (_daemon, id) => {
      if (fail.has(id)) throw new Error('unreadable');
      const found = cards.get(id);
      return found === undefined ? null : { card: found, laneSet: lanes };
    },
    board: async () => boardAnswer([...cards.values()], { projectId: PROJECT, laneSet: lanes, ...extra }),
  });
  return { store: new DaemonBoardStore(port, environment), port, environment };
};

const show = async (store: DaemonBoardStore, spec: EmbedSpec): Promise<HTMLElement> => {
  view = await mount(<CardEmbed names={names} spec={spec} store={store} />);
  await interact(() => flush());
  return view.container;
};

const text = (root: HTMLElement) => root.textContent ?? '';
const heads = (root: HTMLElement) => [...root.querySelectorAll('.fy-board-lane__name')].map(node => node.textContent);
const poke = async (store: DaemonBoardStore, ...ids: string[]) =>
  interact(async () => {
    store.noteEvent(THIS_MACHINE.daemonId, changed(...ids));
    await flush();
  });

describe('CardEmbed: a card', () => {
  it('draws the real board card with its title, its lane and a link to its page', async () => {
    const { store } = serving(new Map([['F1', card('F1', { title: 'Ship the thing' })]]));
    const root = await show(store, { kind: 'card', id: 'F1' });
    expect(root.querySelector('[data-embed-card="F1"]')).not.toBeNull();
    expect(text(root)).toContain('Ship the thing');
    expect(text(root)).toContain('Implement');
    expect(root.querySelector('[data-embed-card="F1"] a')).not.toBeNull();
  });

  it('follows a lane move on board.changed, with no timer', async () => {
    const cards = new Map([['F1', card('F1', { title: 'Ship the thing' })]]);
    const { store, environment } = serving(cards);
    const root = await show(store, { kind: 'card', id: 'F1' });
    expect(text(root)).toContain('Implement');
    expect(environment.pending()).toBe(0);
    cards.set('F1', card('F1', { title: 'Ship the thing', laneId: 'review' }));
    await poke(store, 'F1');
    expect(text(root)).toContain('Review/CI');
    expect(text(root)).not.toContain('Implement');
    expect(environment.pending()).toBe(0);
  });

  it('says so, in a quiet note and never as a link, when the card does not exist or cannot be read', async () => {
    const { store } = serving(new Map([['F2', card('F2')]]), new Set(['F2']));
    const missing = await show(store, { kind: 'card', id: 'F404' });
    expect(missing.querySelector('[data-embed-note="F404"]')?.textContent).toContain('No card with this id.');
    expect(missing.querySelector('a')).toBeNull();
    await view?.unmount();
    const unreadable = await show(store, { kind: 'card', id: 'F2' });
    expect(unreadable.querySelector('[data-embed-note="F2"]')?.textContent).toContain('could not be read');
    expect(unreadable.querySelector('a')).toBeNull();
  });

  it('holds a placeholder, not a link, until the machine has answered', async () => {
    const held = deferred<{ card: CardView; laneSet: typeof lanes } | null>();
    const store = new DaemonBoardStore(fakePort({ card: async () => await held.promise }), fakeEnvironment());
    view = await mount(<CardEmbed names={names} spec={{ kind: 'card', id: 'F1' }} store={store} />);
    expect(view.container.querySelector('[data-embed-loading="F1"]')).not.toBeNull();
    expect(view.container.querySelector('a')).toBeNull();
    held.resolve({ card: card('F1'), laneSet: lanes });
    await interact(() => flush());
    expect(view.container.querySelector('[data-embed-loading]')).toBeNull();
    expect(view.container.querySelector('a')).not.toBeNull();
  });

  it('names the ferret by its callsign, never by the start of its session id', async () => {
    const { store } = serving(new Map([['F1', card('F1', { owner: 'mvuc7tsf-0c3d50df' })]]));
    const root = await show(store, { kind: 'card', id: 'F1' });
    expect(text(root)).toContain('Nimbus');
    expect(text(root)).not.toContain('mvuc7tsf');
  });

  it('lets go of its watch on unmount, so a later event reads nothing', async () => {
    const { store, port } = serving(new Map([['F1', card('F1')]]));
    await show(store, { kind: 'card', id: 'F1' });
    const reads = port.calls.filter(call => call.startsWith('card:')).length;
    await view?.unmount();
    view = null;
    store.noteEvent(THIS_MACHINE.daemonId, changed('F1'));
    await flush();
    expect(port.calls.filter(call => call.startsWith('card:'))).toHaveLength(reads);
  });
});

describe('CardEmbed: a list of cards', () => {
  it("draws lanes in the board's lane order with the missing card's note last, and counts each lane", async () => {
    const { store } = serving(
      new Map([
        ['F1', card('F1', { title: 'First', laneId: 'review' })],
        ['F2', card('F2', { title: 'Second', laneId: 'todo' })],
        ['F3', card('F3', { title: 'Third', laneId: 'review' })],
      ]),
      new Set(['F8']),
    );
    const root = await show(store, { kind: 'cards', ids: ['F1', 'F2', 'F9', 'F3', 'F8'] });
    const frame = root.querySelector('.fy-card-embed-board');
    expect(heads(root)).toEqual(['Todo', 'Review/CI']);
    expect([...root.querySelectorAll('.fy-board-lane__count')].map(node => node.textContent)).toEqual(['1', '2']);
    expect(text(root)).toContain('First');
    expect(root.querySelector('[data-embed-note="F9"]')?.textContent).toContain('No card with this id.');
    expect(root.querySelector('[data-embed-note="F8"]')?.textContent).toContain('could not be read');
    expect([...(frame?.children ?? [])].at(-1)).toBe(root.querySelector('[data-embed-note="F8"]') ?? undefined);
  });

  it('moves a card between lanes on board.changed', async () => {
    const cards = new Map([
      ['F1', card('F1', { title: 'First' })],
      ['F2', card('F2', { title: 'Second' })],
    ]);
    const { store } = serving(cards);
    const root = await show(store, { kind: 'cards', ids: ['F1', 'F2'] });
    expect(heads(root)).toEqual(['Implement']);
    cards.set('F2', card('F2', { title: 'Second', laneId: 'review' }));
    await poke(store, 'F2');
    expect(heads(root)).toEqual(['Implement', 'Review/CI']);
  });

  it('shows a placeholder while a card is still being read, then the mini board', async () => {
    const held = deferred<{ card: CardView; laneSet: typeof lanes } | null>();
    const store = new DaemonBoardStore(
      fakePort({
        card: async (_daemon, id) => (id === 'F2' ? await held.promise : { card: card(id), laneSet: lanes }),
      }),
      fakeEnvironment(),
    );
    view = await mount(<CardEmbed names={names} spec={{ kind: 'cards', ids: ['F1', 'F2'] }} store={store} />);
    await interact(() => flush());
    expect(view.container.querySelector('[data-embed-loading="F1 F2"]')).not.toBeNull();
    expect(view.container.querySelector('[data-embed-card], .fy-board-card')).not.toBeNull();
    held.resolve({ card: card('F2'), laneSet: lanes });
    await interact(() => flush());
    expect(view.container.querySelector('[data-embed-loading]')).toBeNull();
  });

  it('holds a placeholder before any card has answered', async () => {
    const held = deferred<{ card: CardView; laneSet: typeof lanes } | null>();
    const store = new DaemonBoardStore(fakePort({ card: async () => await held.promise }), fakeEnvironment());
    view = await mount(<CardEmbed names={names} spec={{ kind: 'cards', ids: ['F1'] }} store={store} />);
    expect(view.container.querySelector('[data-embed-loading="F1"]')).not.toBeNull();
    held.resolve(null);
    await interact(() => flush());
  });

  it('draws at most the cards a block may hold and says how many more are on the board', async () => {
    const many = FY_RENDER_LIMITS.embedChildren + 3;
    const ids = Array.from({ length: many }, (_, index) => `F${index + 1}`);
    const { store } = serving(new Map(ids.map(id => [id, card(id)] as const)));
    const root = await show(store, { kind: 'cards', ids });
    expect(root.querySelectorAll('.fy-board-card')).toHaveLength(FY_RENDER_LIMITS.embedChildren);
    expect(text(root)).toContain('3 more on the board.');
  });
});

describe('CardEmbed: the children of a card', () => {
  const family = () =>
    new Map<string, CardView>([
      ['F10', card('F10', { title: 'Parent' })],
      ['F11', card('F11', { title: 'Child one', parent: { id: 'F10' } })],
      ['F12', card('F12', { title: 'Child two', parent: { id: 'F10' }, laneId: 'review' })],
      ['F13', card('F13', { title: 'Stranger' })],
    ]);

  it('groups the children by lane and follows a lane move on board.changed', async () => {
    const cards = family();
    const { store, environment } = serving(cards);
    const root = await show(store, { kind: 'children', parent: 'F10' });
    expect(text(root)).toContain('Child one');
    expect(text(root)).toContain('Child two');
    expect(text(root)).not.toContain('Stranger');
    expect(heads(root)).toEqual(['Implement', 'Review/CI']);
    expect(environment.pending()).toBe(0);
    cards.set('F11', card('F11', { title: 'Child one', parent: { id: 'F10' }, laneId: 'review' }));
    await poke(store, 'F11');
    expect(heads(root)).toEqual(['Review/CI']);
    expect(root.querySelector('.fy-board-lane__count')?.textContent).toBe('2');
  });

  it('says when a parent has no cards under it, and when its cards cannot be read', async () => {
    const empty = await show(serving(new Map([['F10', card('F10')]])).store, { kind: 'children', parent: 'F10' });
    expect(empty.querySelector('[data-embed-note="F10"]')?.textContent).toContain('No cards under this one.');
    await view?.unmount();
    const port = fakePort({
      card: async () => ({ card: card('F10'), laneSet: lanes }),
      board: async () => {
        throw new Error('down');
      },
    });
    const broken = await show(new DaemonBoardStore(port, fakeEnvironment()), { kind: 'children', parent: 'F10' });
    expect(broken.querySelector('[data-embed-note="F10"]')?.textContent).toContain('could not be read');
  });

  it('says there is no such card, not that it has no children, when the parent does not exist', async () => {
    const root = await show(serving(new Map()).store, { kind: 'children', parent: 'F999' });
    expect(root.querySelector('[data-embed-note="F999"]')?.textContent).toContain('No card with this id.');
    expect(root.querySelector('.fy-card-embed-board')).toBeNull();
  });

  it('says the parent could not be read when its read fails', async () => {
    const root = await show(serving(new Map([['F10', card('F10')]]), new Set(['F10'])).store, {
      kind: 'children',
      parent: 'F10',
    });
    expect(root.querySelector('[data-embed-note="F10"]')?.textContent).toContain('could not be read');
  });

  it('holds a placeholder until the parent is read', async () => {
    const held = deferred<{ card: CardView; laneSet: typeof lanes } | null>();
    const store = new DaemonBoardStore(fakePort({ card: async () => await held.promise }), fakeEnvironment());
    view = await mount(<CardEmbed names={names} spec={{ kind: 'children', parent: 'F10' }} store={store} />);
    expect(view.container.querySelector('[data-embed-loading="F10"]')).not.toBeNull();
    held.resolve(null);
    await interact(() => flush());
  });

  it('holds a placeholder until the board has been read, with the parent already known', async () => {
    const heldBoard = deferred<ReturnType<typeof boardAnswer>>();
    const port = fakePort({
      card: async () => ({ card: card('F10'), laneSet: lanes }),
      board: async () => await heldBoard.promise,
    });
    view = await mount(
      <CardEmbed
        names={names}
        spec={{ kind: 'children', parent: 'F10' }}
        store={new DaemonBoardStore(port, fakeEnvironment())}
      />,
    );
    await interact(() => flush());
    expect(view.container.querySelector('[data-embed-loading="F10"]')).not.toBeNull();
    heldBoard.resolve(boardAnswer([], { projectId: PROJECT, laneSet: lanes }));
    await interact(() => flush());
  });

  it('says the list may be incomplete when the board was too big to read in full', async () => {
    const { store } = serving(family(), new Set(), { nextCursor: 'more' });
    const root = await show(store, { kind: 'children', parent: 'F10' });
    expect(root.querySelector('[data-embed-truncated="F10"]')?.textContent).toContain('may be incomplete');
  });
});
