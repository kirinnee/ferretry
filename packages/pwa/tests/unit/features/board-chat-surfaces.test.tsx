import { afterEach, describe, expect, it } from 'bun:test';
import { BoardSideTab } from '../../../src/features/board/board-side-tab.tsx';
import type { BoardSideView } from '../../../src/lib/board-side-view.ts';
import { type BoardChat, chatCards, chatChip } from '../../../src/lib/board-chat.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card, laptop } from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const SELF = 's1';
const KID = 'c1';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const chatOf = async (
  extra: { readonly focus?: { id: string } | null; readonly status?: BoardChat['status'] } = {},
) => {
  const model = await boardModelOf([
    card('F18', { owner: SELF, laneId: 'plan', title: 'Board system' }),
    card('F20', { owner: SELF, laneId: 'review', title: 'Review the board' }),
    card('F30', { owner: KID, laneId: 'implement', title: 'Kid card' }),
    card('F31', { owner: KID, laneId: 'implement', title: 'Kid grandchild', parent: { id: 'F30' } }),
    card('F99', { owner: 'other', title: 'Not ours' }),
  ]);
  const focus = extra.focus === undefined ? { id: 'F18' } : extra.focus;
  const status = extra.status ?? 'ready';
  const cards = chatCards(model, {
    daemonId: laptop.daemonId,
    sessionId: SELF,
    focus,
    relatives: new Set([KID]),
  });
  const chip = chatChip(
    focus ?? undefined,
    cards.focus,
    cards.focus === null ? undefined : cards.places.get(cards.focus.key),
    status,
  );
  const refreshed: boolean[] = [];
  const chat: BoardChat = { chip, cards, status, refresh: () => void refreshed.push(true) };
  return { chat, refreshed };
};

describe('BoardSideTab', () => {
  const scope = daemonSessionScope(laptop, SELF);
  const draw = async (
    chat: BoardChat,
    extra: {
      readonly view?: BoardSideView;
      readonly onOpenCard?: (id: string) => void;
      readonly onView?: (v: BoardSideView) => void;
    } = {},
  ) => {
    view = await mount(
      <BoardSideTab
        callsigns={new Map()}
        chat={chat}
        now={NOW}
        onOpenCard={card => extra.onOpenCard?.(card.task.id)}
        onView={next => extra.onView?.(next)}
        scope={scope}
        view={extra.view ?? 'list'}
      />,
    );
    return view.container;
  };
  const lanes = (root: HTMLElement) =>
    [...root.querySelectorAll('.fy-board-lane')].map(lane => [
      lane.querySelector('.fy-board-lane__name')?.textContent,
      [...lane.querySelectorAll('.fy-board-card__title')].map(title => title.textContent),
    ]);

  it('lists the focus card, then the owned lanes, then the sub-ferrets as a tree, and no one else’s card', async () => {
    const { chat } = await chatOf();
    const root = await draw(chat);
    expect(lanes(root)).toEqual([
      ['Focus', ['Board system']],
      ['Owned · Review/CI', ['Review the board']],
      ['Sub-ferrets', ['Kid card', 'Kid grandchild']],
    ]);
    expect(root.textContent).not.toContain('Not ours');
    expect(root.querySelectorAll('[data-density="side"]').length).toBeGreaterThan(0);
  });

  it('draws the focus card once, even though it is also owned', async () => {
    const { chat } = await chatOf();
    const root = await draw(chat);
    expect(
      [...root.querySelectorAll('.fy-board-card__title')].filter(t => t.textContent === 'Board system'),
    ).toHaveLength(1);
  });

  it('skips the Focus lane when the session has no focus card, and lists its owned cards', async () => {
    const { chat } = await chatOf({ focus: null });
    const root = await draw(chat);
    expect(lanes(root).map(([name]) => name)).toEqual(['Owned · Plan/Design', 'Owned · Review/CI', 'Sub-ferrets']);
  });

  it('collapses and expands a lane', async () => {
    const { chat } = await chatOf();
    const root = await draw(chat);
    const toggle = must(root.querySelectorAll<HTMLButtonElement>('.fy-board-lane__toggle')[1], 'owned toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.textContent).not.toContain('Review the board');
    await interact(() => toggle.click());
    expect(root.textContent).toContain('Review the board');
  });

  it('hands a clicked card to the host to open over the chat', async () => {
    const opened: string[] = [];
    const { chat } = await chatOf();
    const root = await draw(chat, { onOpenCard: id => void opened.push(id) });
    const link = must(root.querySelector<HTMLAnchorElement>('a[href$="/F20"]'), 'card link');
    await interact(() => link.click());
    expect(opened).toEqual(['F20']);
  });

  it('draws one column per lane in the Kanban, cards in their column', async () => {
    const { chat } = await chatOf();
    const root = await draw(chat, { view: 'kanban' });
    expect(root.querySelector('[data-board-side-kanban]')).not.toBeNull();
    expect(lanes(root)).toEqual([
      ['Plan/Design', ['Board system']],
      ['Implement', ['Kid card', 'Kid grandchild']],
      ['Review/CI', ['Review the board']],
    ]);
  });

  it('asks the host to switch view from the toggle', async () => {
    const picked: BoardSideView[] = [];
    const { chat } = await chatOf();
    const root = await draw(chat, { onView: next => void picked.push(next) });
    const on = (id: string) => root.querySelector<HTMLButtonElement>(`button[data-view="${id}"]`);
    expect(on('list')?.getAttribute('aria-pressed')).toBe('true');
    expect(on('kanban')?.getAttribute('aria-pressed')).toBe('false');
    await interact(() => must(on('kanban'), 'Kanban').click());
    expect(picked).toEqual(['kanban']);
  });

  it('shows no toggle when there is nothing to arrange', async () => {
    const { chat } = await chatOf({ focus: null, status: 'loading' });
    const none: BoardChat = {
      ...chat,
      cards: chatCards(await boardModelOf([]), {
        daemonId: laptop.daemonId,
        sessionId: SELF,
        focus: null,
        relatives: new Set(),
      }),
    };
    const root = await draw(none);
    expect(root.querySelector('.fy-board-side__views')).toBeNull();
  });

  describe('Add to chat', () => {
    const register = (draft: { value: string }) =>
      registerComposerQuoteTarget({
        ...scope,
        draft: () => draft.value,
        replaceDraft: next => {
          draft.value = next;
        },
      });

    it('puts the card’s &id into this session’s message and says so', async () => {
      const draft = { value: '' };
      const dispose = register(draft);
      try {
        const { chat } = await chatOf();
        const root = await draw(chat);
        await interact(() => must(root.querySelector<HTMLButtonElement>('[data-add-to-chat="F20"]'), 'add').click());
        expect(draft.value).toContain('&F20');
        expect(root.querySelector('[data-board-side-status]')?.textContent).toBe(
          "Added &F20 to this session's message.",
        );
        await interact(() => must(root.querySelector<HTMLButtonElement>('[data-add-to-chat="F20"]'), 'add').click());
        expect(root.querySelector('[data-board-side-status]')?.textContent).toBe('&F20 is already in this message.');
      } finally {
        dispose();
      }
    });

    it('says there is nowhere to add it when no message box is open', async () => {
      const { chat } = await chatOf();
      const root = await draw(chat);
      await interact(() => must(root.querySelector<HTMLButtonElement>('[data-add-to-chat="F18"]'), 'add').click());
      expect(root.querySelector('[data-board-side-status]')?.textContent).toContain('nowhere to add it');
    });
  });

  describe('when there is nothing to draw', () => {
    const empty = async (status: BoardChat['status']) => {
      const { chat, refreshed } = await chatOf({ focus: null, status });
      const none: BoardChat = {
        ...chat,
        cards: chatCards(await boardModelOf([]), {
          daemonId: laptop.daemonId,
          sessionId: SELF,
          focus: null,
          relatives: new Set(),
        }),
      };
      return { chat: none, refreshed };
    };

    it('says the ferret has no cards once the board was read', async () => {
      const { chat } = await empty('ready');
      const root = await draw(chat);
      expect(root.textContent).toContain('This ferret has no cards.');
    });

    it('says it is reading while the board loads', async () => {
      const { chat } = await empty('loading');
      const root = await draw(chat);
      expect(root.textContent).toContain('Reading the board…');
    });

    it('offers to try again when the board could not be read', async () => {
      const { chat, refreshed } = await empty('error');
      const root = await draw(chat);
      expect(root.querySelector('[role="alert"]')?.textContent).toContain('The board could not be read.');
      await interact(() => must(root.querySelector<HTMLButtonElement>('.fy-board__retry'), 'retry').click());
      expect(refreshed).toEqual([true]);
    });
  });
});
