import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { boardOk } from '@ferretry/protocol';
import { ChatTasks, type ChatTasksProps } from '../../../src/features/board/chat-tasks.tsx';
import { DaemonAgendaStore } from '../../../src/lib/agenda-store.ts';
import { type BoardChat, chatCards, chatChip } from '../../../src/lib/board-chat.ts';
import { boardSideView } from '../../../src/lib/board-side-view.ts';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { daemonBoardCardPath } from '../../../src/lib/pages/routes.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { fill, submit } from './board-detail-support.tsx';
import { boardModelOf, card, fakeEnvironment, fakePort, flush, laneSetFor, laptop } from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const SELF = 's1';
const KID = 'c1';

let view: Mounted | null = null;
beforeEach(() => boardSideView.set('kanban'));
afterEach(async () => {
  await view?.unmount();
  view = null;
  boardSideView.set('kanban');
});

const chatOf = async (extra: readonly ReturnType<typeof card>[] = []): Promise<BoardChat> => {
  const model = await boardModelOf([
    ...extra,
    card('F18', { owner: SELF, laneId: 'plan', title: 'Board system' }),
    card('F20', { owner: SELF, laneId: 'review', title: 'Review the board' }),
    card('F22', { owner: SELF, laneId: 'tested', title: 'Try the board', activity: 'idle' }),
    card('F23', { owner: SELF, laneId: 'closed', title: 'Shipped board' }),
    card('F30', { owner: KID, laneId: 'implement', title: 'Kid card', parent: { id: 'F18' } }),
    card('F99', { owner: 'other', laneId: 'implement', title: 'Not ours' }),
  ]);
  const cards = chatCards(model, {
    daemonId: laptop.daemonId,
    sessionId: SELF,
    focus: { id: 'F18' },
    relatives: new Set([KID]),
  });
  return {
    chip: chatChip(
      { id: 'F18' },
      cards.focus,
      cards.focus === null ? undefined : cards.places.get(cards.focus.key),
      'ready',
    ),
    cards,
    status: 'ready',
    refresh: () => undefined,
  };
};

const open = async (
  extra: {
    readonly withPorts?: boolean;
    readonly extraCards?: readonly ReturnType<typeof card>[];
    readonly refuse?: string;
  } = {},
) => {
  const acts: { id: string; request: unknown }[] = [];
  const navigated: string[] = [];
  const store = new DaemonBoardStore(
    fakePort({
      task: async (_daemon, id) => ({
        task: card(id, { owner: SELF, title: id === 'F30' ? 'Kid card' : 'Board system' }),
        laneSet: laneSetFor(),
      }),
    }),
    fakeEnvironment(),
  );
  store.act = async (_daemon, id, request) => {
    acts.push({ id, request });
    if (extra.refuse !== undefined) return { ok: false, error: { code: 'refused', message: extra.refuse } } as never;
    return boardOk(card(id));
  };
  const agendaStore = new DaemonAgendaStore();
  const props: ChatTasksProps = {
    store,
    machine: { connection: laptop, name: 'laptop' },
    chat: await chatOf(extra.extraCards),
    scope: daemonSessionScope(laptop, SELF),
    callsigns: new Map(),
    phone: false,
    now: NOW,
    onNavigate: to => void navigated.push(to),
    ...(extra.withPorts === false
      ? {}
      : {
          agenda: {
            store: agendaStore,
            hydrate: async () => undefined,
            respond: async () => undefined,
          } as never,
          ports: { sendMessage: async () => undefined },
        }),
  };
  view = await mount(<ChatTasks {...props} />);
  await interact(() => flush());
  return { acts, navigated, root: view.container };
};

const columns = (root: HTMLElement) =>
  [...root.querySelectorAll('.fy-board-lane')].map(lane => [
    lane.querySelector('.fy-board-lane__name')?.textContent,
    [...lane.querySelectorAll('.fy-board-card__title')].map(title => title.textContent),
  ]);

describe('ChatTasks — the view', () => {
  it('opens as a Kanban with a column per lane and no one else’s card', async () => {
    const { root } = await open();
    expect(root.querySelector('[data-board-side-kanban]')).not.toBeNull();
    expect(columns(root)).toEqual([
      ['Plan/Design', ['Board system']],
      ['Implement', ['Kid card']],
      ['Review/CI', ['Review the board']],
      ['To test', ['Try the board']],
      ['Closed', ['Shipped board']],
    ]);
    expect(root.textContent).not.toContain('Not ours');
  });

  it('switches to the List, remembers it on this device and switches back', async () => {
    const { root } = await open();
    const pressed = () =>
      [...root.querySelectorAll<HTMLButtonElement>('.fy-board-side__view')].find(
        b => b.getAttribute('aria-pressed') === 'true',
      )?.dataset['view'];
    expect(pressed()).toBe('kanban');
    await interact(() => must(root.querySelector<HTMLButtonElement>('button[data-view="list"]'), 'List').click());
    expect(pressed()).toBe('list');
    expect(boardSideView.snapshot()).toBe('list');
    expect(root.querySelector('[data-board-side-kanban]')).toBeNull();
    expect(columns(root).map(([name]) => name)).toEqual([
      'Focus',
      'Owned · Review/CI',
      'Owned · To test',
      'Owned · Closed',
      'Sub-ferrets',
    ]);
    await interact(() => must(root.querySelector<HTMLButtonElement>('button[data-view="kanban"]'), 'Kanban').click());
    expect(boardSideView.snapshot()).toBe('kanban');
  });

  it('opens on the List when this device chose it', async () => {
    boardSideView.set('list');
    const { root } = await open();
    expect(root.querySelector('[data-board-side-kanban]')).toBeNull();
    expect(root.querySelector('button[data-view="list"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ChatTasks — opening a card', () => {
  it('opens the card’s drawer over the chat and does not navigate', async () => {
    const { root, navigated } = await open();
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-task="F20"] .fy-board-card__main'), 'card').click(),
    );
    await interact(() => flush());
    expect(document.body.querySelector('.fy-board-detail__scrim')).not.toBeNull();
    expect(root.querySelector('.fy-board-detail__scrim')).toBeNull();
    expect(navigated).toEqual([]);
  });

  it('falls back to the Board page when the host cannot open a drawer', async () => {
    const { root, navigated } = await open({ withPorts: false });
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-task="F20"] .fy-board-card__main'), 'card').click(),
    );
    expect(navigated).toEqual([daemonBoardCardPath(laptop.daemonId, 'F20')]);
    expect(document.body.querySelector('.fy-board-detail__scrim')).toBeNull();
  });
});

describe('ChatTasks — the owner’s Done and Not good', () => {
  it('closes a card waiting in To test with Done ✓', async () => {
    const { root, acts } = await open();
    await interact(() => must(root.querySelector<HTMLElement>('[data-task="F22"] .fy-board-done'), 'Done').click());
    await interact(() => flush());
    expect(acts).toEqual([{ id: 'F22', request: { action: 'move', to: 'closed' } }]);
  });

  it('asks for a reason before Not good sends the card back, and sends it with one', async () => {
    const { root, acts } = await open();
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-task="F22"] [data-verdict="not-good"]'), 'Not good').click(),
    );
    const dialog = must(document.body.querySelector('[role="dialog"]'), 'the reason box');
    expect(dialog.textContent).toContain('Move Try the board back to Implement');
    expect(acts).toEqual([]);
  });

  it('draws Done and Not good on the card itself at the side density', async () => {
    const { root } = await open();
    const row = must(
      root.querySelector('[data-task="F22"][data-density="side"] .fy-board-card__verdict'),
      'verdict row',
    );
    expect(row.querySelector('.fy-board-done')).not.toBeNull();
    expect(row.querySelector('[data-verdict="not-good"]')).not.toBeNull();
  });

  it('offers Reopen on a closed card, from its menu', async () => {
    const { root, acts } = await open();
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-task="F23"] .fy-board-card__more'), 'menu').click(),
    );
    const reopen = must(root.querySelector<HTMLElement>('[data-task="F23"] [data-done="reopen"]'), 'Reopen');
    await interact(() => reopen.click());
    expect(acts.length + document.body.querySelectorAll('[role="dialog"]').length).toBeGreaterThan(0);
  });
});

describe('ChatTasks — the reason box', () => {
  const askReason = async (extra: Parameters<typeof open>[0] = {}) => {
    const opened = await open(extra);
    await interact(() =>
      must(opened.root.querySelector<HTMLElement>('[data-task="F22"] [data-verdict="not-good"]'), 'Not good').click(),
    );
    return opened;
  };
  const box = () => must(document.body.querySelector<HTMLElement>('form[role="dialog"], [role="dialog"]'), 'box');
  const typeReason = async (reason: string): Promise<void> => {
    const form = box().closest('form') ?? box();
    await fill(must(form.querySelector('textarea, input'), 'the reason field') as HTMLTextAreaElement, reason);
    await submit(form as HTMLElement);
    await interact(() => flush());
  };

  it('sends the card back with the reason and closes the box', async () => {
    const { acts } = await askReason();
    await typeReason('It still crashes');
    expect(acts).toHaveLength(1);
    expect(acts[0]?.id).toBe('F22');
    expect(JSON.stringify(acts[0]?.request)).toContain('It still crashes');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the box open and says why when the daemon refuses the move', async () => {
    await askReason({ refuse: 'Not allowed right now' });
    await typeReason('Try again');
    expect(box().textContent).toContain('Not allowed right now');
  });

  it('puts the card back untouched on Cancel', async () => {
    const { acts } = await askReason();
    const cancel = [...box().querySelectorAll('button')].find(button => button.textContent === 'Cancel');
    await interact(() => must(cancel, 'Cancel').click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(acts).toEqual([]);
  });

  it('says the move did not go through when Done is refused', async () => {
    const { root } = await open({ refuse: 'Nope' });
    await interact(() => must(root.querySelector<HTMLElement>('[data-task="F22"] .fy-board-done'), 'Done').click());
    await interact(() => flush());
    expect(root.querySelector('[data-board-side-notice]')?.textContent).toBe('The move did not go through.');
  });
});

describe('ChatTasks — a card in a lane the project does not have', () => {
  it('tells the owner instead of moving it', async () => {
    const { root, acts } = await open({
      extraCards: [card('F40', { owner: SELF, laneId: 'ghost', title: 'Lost card' })],
    });
    const lost = must(root.querySelector<HTMLElement>('[data-task="F40"]'), 'the card in a missing lane');
    expect(lost.querySelector('.fy-board-done')).toBeNull();
    await interact(() => must(lost.querySelector<HTMLElement>('.fy-board-card__more'), 'menu').click());
    const choice = must(
      lost.querySelector<HTMLElement>('[role="menuitem"]:not([data-done])') ??
        lost.querySelector<HTMLElement>('[data-move]'),
      'a move choice',
    );
    await interact(() => choice.click());
    expect(root.querySelector('[data-board-side-notice]')?.textContent).toContain('ghost');
    expect(acts).toEqual([]);
  });
});

describe('ChatTasks — moving about inside the drawer', () => {
  const openDrawer = async () => {
    const opened = await open();
    await interact(() =>
      must(opened.root.querySelector<HTMLElement>('[data-task="F18"] .fy-board-card__main'), 'card').click(),
    );
    await interact(() => flush());
    return opened;
  };
  const drawerTitle = () => document.body.querySelector('.fy-board-detail__title')?.textContent;

  it('opens a sub-card in the same drawer', async () => {
    const { navigated } = await openDrawer();
    expect(drawerTitle()).toContain('Board system');
    const link = [...document.body.querySelectorAll<HTMLButtonElement>('.fy-board-detail__link')].find(button =>
      button.textContent?.includes('Kid card'),
    );
    await interact(() => must(link, 'the sub-card link').click());
    await interact(() => flush());
    expect(drawerTitle()).toContain('Kid card');
    expect(navigated).toEqual([]);
  });

  it('closes the drawer and leaves for a link that is not one of this ferret’s cards', async () => {
    const { navigated } = await openDrawer();
    const chat = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      button.textContent?.includes('Open chat'),
    );
    await interact(() => must(chat, 'Open chat').click());
    expect(document.body.querySelector('.fy-board-detail__scrim')).toBeNull();
    expect(navigated).toHaveLength(1);
  });
});
