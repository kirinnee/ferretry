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
import { NO_BOARD_FILTERS } from '../../../src/lib/board-model.ts';
import {
  boardModelOf,
  card,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
  originCard,
} from '../board-support.ts';

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

const chatOf = async (
  extra: readonly ReturnType<typeof card>[] = [],
  options: { readonly agents?: boolean; readonly splitsAgents?: boolean } = {},
): Promise<BoardChat> => {
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
    agents: options.agents ?? false,
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
    agents: options.agents ?? false,
    splitsAgents: options.splitsAgents ?? false,
  };
};

const open = async (
  extra: {
    readonly withPorts?: boolean;
    readonly extraCards?: readonly ReturnType<typeof card>[];
    readonly refuse?: string;
    readonly chat?: BoardChat;
    readonly expanded?: boolean;
    readonly taskNames?: ReadonlyMap<string, string>;
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
  const agentChoices: boolean[] = [];
  const expands: boolean[] = [];
  const props: ChatTasksProps = {
    store,
    machine: { connection: laptop, name: 'laptop' },
    chat: extra.chat ?? (await chatOf(extra.extraCards)),
    onAgents: next => void agentChoices.push(next),
    ...(extra.expanded === undefined
      ? {}
      : { expanded: extra.expanded, onExpand: () => void expands.push(extra.expanded === true) }),
    scope: daemonSessionScope(laptop, SELF),
    callsigns: new Map(),
    ...(extra.taskNames === undefined ? {} : { taskNames: extra.taskNames }),
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
  return { acts, navigated, agentChoices, expands, root: view.container };
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

  it('opens the Board composer before Not good sends the card back', async () => {
    const { root, acts } = await open();
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-task="F22"] [data-verdict="not-good"]'), 'Not good').click(),
    );
    const dialog = must(document.body.querySelector('[role="dialog"]'), 'the composer');
    expect(dialog.hasAttribute('data-board-send-back')).toBe(true);
    expect(dialog.textContent).toContain('Not good: send Try the board back to Implement');
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

  it('says a refused Done on the card itself, as the Board does', async () => {
    const { root } = await open({ refuse: 'Nope' });
    await interact(() => must(root.querySelector<HTMLElement>('[data-task="F22"] .fy-board-done'), 'Done').click());
    await interact(() => flush());
    expect(root.querySelector('[data-task="F22"] [data-answer-error]')?.textContent).toBe('Nope');
    expect(root.querySelector('[data-board-side-notice]')).toBeNull();
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

describe('ChatTasks — Show agent tasks and Expand', () => {
  const agentCards = () => [
    originCard('F50', 'human', null, { owner: SELF, laneId: 'plan', title: 'Human ask' }),
    originCard(
      'F51',
      'agent',
      { id: 'F50' },
      { owner: SELF, laneId: 'plan', title: 'Agent step', parent: { id: 'F50' } },
    ),
  ];
  const split = async (agents: boolean) => {
    const model = await boardModelOf(
      [...agentCards(), originCard('F52', 'agent', null, { owner: KID, laneId: 'implement', title: 'Kid step' })],
      { ...NO_BOARD_FILTERS, agents: true },
    );
    const cards = chatCards(model, {
      daemonId: laptop.daemonId,
      sessionId: SELF,
      focus: null,
      relatives: new Set([KID]),
      agents,
    });
    return {
      chip: chatChip(undefined, null, undefined, 'ready'),
      cards,
      status: 'ready',
      refresh: () => undefined,
      agents,
      splitsAgents: model.splitsAgents,
    } satisfies BoardChat;
  };
  const toggle = (root: HTMLElement) => root.querySelector<HTMLInputElement>('input[data-filter="agents"]');

  it('shows the same toggle as the Board, off, only when the daemon says who asked', async () => {
    const { root } = await open({ chat: await split(false) });
    expect(toggle(root)?.checked).toBe(false);
    expect(columns(root)).toEqual([['Plan/Design', ['Human ask']]]);
    await view?.unmount();
    view = null;
    const plain = await open();
    expect(toggle(plain.root)).toBeNull();
  });

  it('tells the page when it is switched, and then draws the agent cards under their human card', async () => {
    const first = await open({ chat: await split(false) });
    await interact(() => must(toggle(first.root), 'the toggle').click());
    expect(first.agentChoices).toEqual([true]);
    await view?.unmount();
    view = null;
    const on = await open({ chat: await split(true) });
    expect(toggle(on.root)?.checked).toBe(true);
    expect(columns(on.root)).toEqual([
      ['Plan/Design', ['Human ask', 'Agent step']],
      ['Implement', ['Kid step']],
    ]);
    expect(on.root.querySelector('[data-task="F51"]')?.getAttribute('data-depth')).toBe('1');
    expect(on.root.querySelector('[data-task="F50"]')?.getAttribute('data-depth')).toBeNull();
  });

  it('says agent tasks are hidden when they are all there is, and keeps the toggle in reach', async () => {
    const model = await boardModelOf([originCard('F60', 'agent', null, { owner: SELF, laneId: 'plan' })], {
      ...NO_BOARD_FILTERS,
      agents: true,
    });
    const cards = chatCards(model, {
      daemonId: laptop.daemonId,
      sessionId: SELF,
      focus: null,
      relatives: new Set(),
      agents: false,
    });
    const chat: BoardChat = { ...(await split(false)), cards };
    const { root } = await open({ chat });
    expect(root.querySelector('[data-board-side-empty]')?.textContent).toBe(
      'No tasks of your own yet. 1 agent task is hidden.',
    );
    expect(toggle(root)).not.toBeNull();
  });

  it('offers Expand in the panel and Collapse once expanded, at page density', async () => {
    const panel = await open({ expanded: false });
    const expand = must(panel.root.querySelector<HTMLButtonElement>('[data-board-side-expand]'), 'Expand');
    expect(expand.dataset['boardSideExpand']).toBe('expand');
    expect(expand.textContent).toBe('');
    expect(expand.getAttribute('aria-label')).toBe('Expand the tasks to the whole chat');
    expect(panel.root.querySelector('.fy-board-side__title')).toBeNull();
    await interact(() => expand.click());
    expect(panel.expands).toEqual([false]);
    await view?.unmount();
    view = null;

    const full = await open({ expanded: true });
    const collapse = must(full.root.querySelector<HTMLButtonElement>('[data-board-side-expand]'), 'Collapse');
    expect(collapse.dataset['boardSideExpand']).toBe('collapse');
    expect(full.root.querySelector('[data-board-side]')?.getAttribute('data-density')).toBe('page');
    expect(full.root.querySelector('[data-task="F20"]')?.getAttribute('data-density')).toBe('page');
    expect(full.root.querySelector('.fy-board-kanban')).not.toBeNull();
    expect(full.root.querySelector('.fy-board-side__title')?.textContent).toContain('This ferret');
    await interact(() => collapse.click());
    expect(full.expands).toEqual([true]);
  });

  it('has no Expand button where the host gives none', async () => {
    const { root } = await open();
    expect(root.querySelector('[data-board-side-expand]')).toBeNull();
  });

  it('opens the card drawer over the expanded board', async () => {
    const { root } = await open({ expanded: true });
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-task="F20"] .fy-board-card__main'), 'card').click(),
    );
    await interact(() => flush());
    expect(document.body.querySelector('.fy-board-detail__scrim')).not.toBeNull();
  });

  const drag = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { effectAllowed: '', dropEffect: '', setData: () => undefined },
    });
    return event;
  };
  const laneNamed = (root: HTMLElement, name: string) =>
    must(
      [...root.querySelectorAll<HTMLElement>('.fy-board-lane')].find(lane =>
        lane.getAttribute('aria-label')?.startsWith(name),
      ),
      name,
    );

  it('moves a card dragged to another lane of its board when expanded', async () => {
    const { root, acts } = await open({ expanded: true });
    await interact(() => must(root.querySelector('[data-task="F18"]'), 'F18').dispatchEvent(drag('dragstart')));
    expect(root.querySelector('[data-task="F18"]')?.hasAttribute('data-dragging')).toBe(true);
    await interact(() => laneNamed(root, 'Review').dispatchEvent(drag('drop')));
    await interact(() => flush());
    expect(acts).toEqual([{ id: 'F18', request: { action: 'move', to: 'review' } }]);
    expect(root.querySelector('[data-dragging]')).toBeNull();
  });

  it('takes no drop on the lane the card is already in, and clears the drag when it ends', async () => {
    const { root, acts } = await open({ expanded: true });
    await interact(() => must(root.querySelector('[data-task="F18"]'), 'F18').dispatchEvent(drag('dragstart')));
    await interact(() => laneNamed(root, 'Plan').dispatchEvent(drag('drop')));
    await interact(() => must(root.querySelector('[data-task="F18"]'), 'F18').dispatchEvent(drag('dragend')));
    expect(root.querySelector('[data-dragging]')).toBeNull();
    expect(acts).toEqual([]);
  });

  it('draws no drag handle in the panel', async () => {
    const { root } = await open();
    expect(root.querySelector('[data-task="F18"]')?.getAttribute('draggable')).toBe('false');
  });
});

const ASK = { sessionId: 's1', id: 'A1' };
const waiting = card('F40', {
  owner: SELF,
  laneId: 'implement',
  title: 'Needs a call',
  activity: 'waiting',
  waitingOnOwner: [ASK],
  openAsks: [ASK],
});

const where = (root: HTMLElement) => root.querySelector('.fy-item-view__where')?.textContent;
const shownTitle = (root: HTMLElement) =>
  root.querySelector('[data-board-cards] .fy-board-card__title, [data-board-cards] [data-to-test-title]')?.textContent;
const step = (root: HTMLElement, label: 'Previous card' | 'Next card') =>
  must(root.querySelector<HTMLButtonElement>(`[data-board-cards] button[aria-label="${label}"]`), label);

describe('ChatTasks — the Cards view', () => {
  beforeEach(() => boardSideView.set('cards'));

  it('is the view this panel opens on, with Kanban and List still there as tabs', async () => {
    const { root } = await open({ extraCards: [waiting] });
    expect(root.querySelector('[data-board-cards]')).not.toBeNull();
    expect(root.querySelector('[data-board-side-kanban]')).toBeNull();
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('.fy-board-side__view')].map(tab => [
        tab.dataset['view'],
        tab.getAttribute('aria-pressed'),
      ]),
    ).toEqual([
      ['cards', 'true'],
      ['kanban', 'false'],
      ['list', 'false'],
    ]);
  });

  it('shows one card at a time, the card to test first and then the one waiting on the owner', async () => {
    const { root } = await open({ extraCards: [waiting] });
    expect(where(root)).toBe('1 of 6');
    expect(shownTitle(root)).toBe('Try the board');
    expect(root.querySelectorAll('[data-board-cards] [data-task], [data-board-cards] [data-to-test]')).toHaveLength(1);
    expect(root.querySelector('[data-board-cards-rank]')?.textContent).toBe('To test');
    await interact(() => step(root, 'Next card').click());
    expect(where(root)).toBe('2 of 6');
    expect(shownTitle(root)).toBe('Needs a call');
    expect(root.querySelector('[data-board-cards-rank]')?.textContent).toBe('Waiting on you');
    await interact(() => step(root, 'Next card').click());
    expect(root.querySelector('[data-board-cards-rank]')?.textContent).toBe('Other');
  });

  it('stops at both ends of the stack', async () => {
    const { root } = await open({ extraCards: [waiting] });
    expect(step(root, 'Previous card').disabled).toBe(true);
    for (let at = 1; at < 6; at += 1) await interact(() => step(root, 'Next card').click());
    expect(where(root)).toBe('6 of 6');
    expect(step(root, 'Next card').disabled).toBe(true);
    await interact(() => step(root, 'Previous card').click());
    expect(where(root)).toBe('5 of 6');
  });

  it('marks a card to test Done with the button, through the Board’s own move', async () => {
    const { root, acts } = await open();
    await interact(() => must(root.querySelector<HTMLElement>('[data-to-test-done]'), 'Done').click());
    await interact(() => flush());
    expect(acts).toEqual([{ id: 'F22', request: { action: 'move', to: 'closed' } }]);
  });

  it('sends a card to test back with the owner’s words, through the Board’s reason box', async () => {
    const { root, acts } = await open();
    await interact(() => must(root.querySelector<HTMLElement>('[data-to-test-not-good]'), 'Not good').click());
    const dialog = must(document.body.querySelector('[role="dialog"]'), 'the reason box');
    expect(acts).toEqual([]);
    const form = dialog.closest('form') ?? dialog;
    await fill(must(form.querySelector('textarea, input'), 'the reason field') as HTMLTextAreaElement, 'It crashes');
    await submit(form as HTMLElement);
    await interact(() => flush());
    expect(acts).toHaveLength(1);
    expect(acts[0]?.id).toBe('F22');
    expect(JSON.stringify(acts[0]?.request)).toContain('It crashes');
  });

  it('draws How to test on the card to test', async () => {
    const { root } = await open({
      extraCards: [card('F50', { owner: SELF, laneId: 'tested', title: 'Steps', howToTest: '1. Press it' })],
    });
    await interact(() => step(root, 'Next card').click());
    expect(shownTitle(root)).toBe('Steps');
    expect(root.querySelector('[data-to-test-how]')?.textContent).toContain('Press it');
  });

  it('draws a card that is not to test as the ordinary card, with no swipe row', async () => {
    const { root } = await open({ extraCards: [waiting] });
    await interact(() => step(root, 'Next card').click());
    expect(root.querySelector('[data-board-cards] [data-to-test]')).toBeNull();
    expect(root.querySelector('[data-board-cards] [data-task="F40"]')).not.toBeNull();
  });

  it('names the ferret by its task on the card to test, never by its callsign', async () => {
    const { root } = await open({ taskNames: new Map([[SELF, 'Credentials Build Lead']]) });
    expect(root.querySelector('[data-board-cards] [data-to-test-ferret]')?.textContent).toBe('Credentials Build Lead');
  });

  it('has a Skip button on a card to test that steps to the next card', async () => {
    const { root, acts } = await open({ extraCards: [waiting] });
    await interact(() => must(root.querySelector<HTMLElement>('[data-to-test-skip]'), 'Skip').click());
    expect(where(root)).toBe('2 of 6');
    expect(acts).toEqual([]);
  });

  it('opens the card’s drawer from the title of a card to test', async () => {
    const { root } = await open();
    await interact(() => must(root.querySelector<HTMLElement>('[data-to-test-title]'), 'title').click());
    expect(document.body.querySelector('.fy-board-detail__scrim')).not.toBeNull();
  });

  it('switches to Kanban and back, and remembers the pick on this device', async () => {
    const { root } = await open();
    await interact(() => must(root.querySelector<HTMLButtonElement>('button[data-view="kanban"]'), 'Kanban').click());
    expect(boardSideView.snapshot()).toBe('kanban');
    expect(root.querySelector('[data-board-cards]')).toBeNull();
    expect(root.querySelector('[data-board-side-kanban]')).not.toBeNull();
    await interact(() => must(root.querySelector<HTMLButtonElement>('button[data-view="cards"]'), 'Cards').click());
    expect(root.querySelector('[data-board-cards]')).not.toBeNull();
  });

  it('says so when the ferret has no cards', async () => {
    const chat = await chatOf();
    const { root } = await open({ chat: { ...chat, cards: { ...chat.cards, total: 0, hiddenAgents: 0 } } });
    expect(root.querySelector('[data-board-cards]')).toBeNull();
    expect(root.querySelector('[data-board-side-empty]')).not.toBeNull();
  });
});

const pointer = (type: string, x: number, init: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 300,
    pointerId: 9,
    pointerType: 'touch',
    ...init,
  });

const swipe = async (root: HTMLElement, dx: number): Promise<void> => {
  const grip = must(root.querySelector<HTMLElement>('[data-board-cards] .fy-totest__meta'), 'a place to grab');
  await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx / 2)));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx)));
  await interact(() => grip.dispatchEvent(pointer('pointerup', 100 + dx)));
};

describe('ChatTasks — swiping a card to test, at once', () => {
  beforeEach(() => boardSideView.set('cards'));

  it('a left swipe is Done, with no tap on a button first', async () => {
    const { root, acts } = await open();
    await swipe(root, -300);
    await interact(() => flush());
    expect(acts).toEqual([{ id: 'F22', request: { action: 'move', to: 'closed' } }]);
  });

  it('a right swipe opens the Board’s reason box and moves nothing yet', async () => {
    const { root, acts } = await open();
    await swipe(root, 300);
    await interact(() => flush());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(acts).toEqual([]);
  });

  it('a swipe down is Skip: the next card, and nothing moves', async () => {
    const { root, acts } = await open({ extraCards: [waiting] });
    const grip = must(root.querySelector<HTMLElement>('[data-board-cards] .fy-totest__meta'), 'a place to grab');
    await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 100, { clientY: 400 })));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 100, { clientY: 600 })));
    await interact(() => grip.dispatchEvent(pointer('pointerup', 100, { clientY: 600 })));
    await interact(() => flush());
    expect(where(root)).toBe('2 of 6');
    expect(acts).toEqual([]);
  });

  it('a short swipe does nothing', async () => {
    const { root, acts } = await open();
    await swipe(root, 40);
    await interact(() => flush());
    expect(acts).toEqual([]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
