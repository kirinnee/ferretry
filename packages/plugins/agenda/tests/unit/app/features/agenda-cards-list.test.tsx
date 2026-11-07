import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaCardRow } from '@ferretry/core-asks/contract';
import {
  type AgendaCardOutcome,
  AgendaCardsList,
  type BoardTaskId,
  CLOSE_CARD_REASON,
} from '../../../../app/features/agenda/agenda-cards-list.tsx';
import { agendaCardsActions as cardsActions, boardErr, boardOk } from '../../../../app/lib/agenda-cards-actions.ts';
import { daemonId } from '../../../../app/shell.ts';
import { type Mounted, mount } from '@ferretry/app/testing';
import { click, settle, typeInto } from '../../../support/app/dom-form.ts';

const LAPTOP = daemonId('laptop');

/** The shell's route table, as a host with Board and Conversation installed answers it. */
const LINKS = {
  card: (machine: string, id: string) => `/d/${machine}/board/${id}`,
  chat: (machine: string, ferret: string) => `/d/${machine}/chat/${ferret}`,
};
const agendaCardsActions = (
  board: Parameters<typeof cardsActions>[0],
  machine: Parameters<typeof cardsActions>[1],
  onNavigate: (to: string) => void,
) => cardsActions(board, machine, onNavigate, LINKS);
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const ONE: readonly AgendaCardRow[] = [
  {
    task: { id: 'B1' as BoardTaskId },
    line: '&B1 Fix simcha Loge 502 is waiting in Review/CI, but no ferret is assigned, so nothing will happen to it.',
  },
];
const THREE: readonly AgendaCardRow[] = [
  ...ONE,
  {
    task: { id: 'B2' as BoardTaskId },
    line: '&B2 Fix the login page is waiting in Implement, but no ferret is assigned, so nothing will happen to it.',
  },
  {
    task: { id: 'B3' as BoardTaskId },
    line: '&B3 Tidy the docs is waiting in Review/CI, but no ferret is assigned, so nothing will happen to it.',
  },
];

const draw = async (
  cards: readonly AgendaCardRow[],
  over: Partial<Parameters<typeof AgendaCardsList>[0]['actions']> = {},
) => {
  const calls: string[] = [];
  const actions = {
    open: (id: BoardTaskId) => {
      calls.push(`open:${id}`);
    },
    start: async (id: BoardTaskId): Promise<AgendaCardOutcome> => {
      calls.push(`start:${id}`);
      return { ok: true, note: 'Started.' };
    },
    openChat: (sessionId: string) => {
      calls.push(`chat:${sessionId}`);
    },
    close: async (id: BoardTaskId, reason: string): Promise<AgendaCardOutcome> => {
      calls.push(`close:${id}:${reason}`);
      return { ok: true, note: 'Closed.' };
    },
    ...over,
  };
  const view = await mount(<AgendaCardsList actions={actions} cards={cards} />);
  mounted.push(view);
  const row = (id: string) => view.container.querySelector<HTMLElement>(`[data-agenda-card-row="${id}"]`);
  const q = (id: string, selector: string) => row(id)?.querySelector<HTMLElement>(selector) ?? null;
  return { calls, row, q, view };
};

describe('the cards of a notice', () => {
  it('draws one row per card, each with Open, Start a ferret and Close, named in full for a screen reader', async () => {
    const list = await draw(THREE);

    for (const id of ['B1', 'B2', 'B3']) {
      const open = list.q(id, '[data-agenda-card-open]');
      const start = list.q(id, '[data-agenda-card-start]');
      const close = list.q(id, '[data-agenda-card-close]');
      expect(open?.textContent).toBe('Open');
      expect(open?.getAttribute('aria-label')).toBe(`Open card &${id}`);
      expect(start?.textContent).toBe('Start a ferret');
      expect(start?.getAttribute('aria-label')).toBe(`Start a ferret on &${id}`);
      expect(close?.textContent).toBe('Close');
      expect(close?.getAttribute('aria-label')).toBe(`Close card &${id}`);
    }
    expect(list.q('B2', '[data-agenda-card-line]')?.textContent).toContain(
      '&B2 Fix the login page is waiting in Implement',
    );
  });

  it('keeps a card’s three buttons on one row, which does not wrap', async () => {
    const list = await draw(ONE);
    const buttons = list.q('B1', '[data-agenda-card-buttons]');

    expect(buttons?.className).toContain('flex');
    expect(buttons?.className).not.toContain('flex-wrap');
    expect(buttons?.querySelectorAll('button')).toHaveLength(3);
  });

  it('shows the line of a lone card too: the notice no longer says it above the list', async () => {
    const list = await draw(ONE);

    expect(list.q('B1', '[data-agenda-card-line]')?.textContent).toBe(ONE[0]?.line);
    expect(list.q('B1', '[data-agenda-card-open]')?.textContent).toBe('Open');
  });

  it('opens only the card whose button was pressed', async () => {
    const list = await draw(THREE);

    await click(list.q('B2', '[data-agenda-card-open]'));

    expect(list.calls).toEqual(['open:B2']);
  });

  it('starts a ferret on that card and says so, without touching the others', async () => {
    const list = await draw(THREE);

    await click(list.q('B3', '[data-agenda-card-start]'));
    await settle();

    expect(list.calls).toEqual(['start:B3']);
    expect(list.q('B3', '[data-agenda-card-done]')?.textContent).toBe('Started.');
    expect(list.q('B1', '[data-agenda-card-start]')).not.toBeNull();
  });

  it('offers Open its chat in place of Start when a live ferret already holds the card, and opens that ferret', async () => {
    const list = await draw(ONE, {
      start: async () => ({ ok: true, ferret: 'worker', note: 'A ferret is already working on this card.' }),
    });

    await click(list.q('B1', '[data-agenda-card-start]'));
    await settle();

    expect(list.q('B1', '[data-agenda-card-start]')).toBeNull();
    expect(list.q('B1', '[data-agenda-card-held]')).toBeNull();
    const line = list.q('B1', '[data-agenda-card-line]');
    expect(line?.textContent).toBe('&B1 Fix simcha Loge 502 — a ferret has picked it up.');
    expect(line?.textContent).not.toContain('no ferret is assigned');
    expect(line?.getAttribute('role')).toBe('status');
    const chat = list.q('B1', '[data-agenda-card-chat]');
    expect(chat?.textContent).toBe('Open its chat');
    expect(chat?.getAttribute('aria-label')).toBe('Open the chat of the ferret on &B1');
    await click(chat);
    expect(list.calls).toEqual(['chat:worker']);
  });

  it('says the card’s ref when a line has no "is waiting in" tail to cut', async () => {
    const list = await draw([{ task: { id: 'B9' as BoardTaskId }, line: 'Something else entirely.' }], {
      start: async () => ({ ok: true, ferret: 'worker', note: 'A ferret is already working on this card.' }),
    });

    await click(list.q('B9', '[data-agenda-card-start]'));
    await settle();

    expect(list.q('B9', '[data-agenda-card-line]')?.textContent).toBe('&B9 — a ferret has picked it up.');
  });

  it('shows the daemon’s refusal on the row and keeps the buttons', async () => {
    const list = await draw(ONE, {
      start: async () => ({ ok: false, message: '&B1’s ferret is no longer on this machine.' }),
    });

    await click(list.q('B1', '[data-agenda-card-start]'));
    await settle();

    expect(list.q('B1', '[data-agenda-card-problem]')?.textContent).toBe('&B1’s ferret is no longer on this machine.');
    expect(list.q('B1', '[data-agenda-card-start]')).not.toBeNull();
  });

  it('asks before closing, and closes nothing when the owner keeps the card', async () => {
    const list = await draw(ONE);

    await click(list.q('B1', '[data-agenda-card-close]'));
    expect(list.q('B1', '[data-agenda-card-confirm]')).not.toBeNull();
    expect(list.calls).toEqual([]);
    await click(list.q('B1', '[data-agenda-card-keep]'));

    expect(list.calls).toEqual([]);
    expect(list.q('B1', '[data-agenda-card-confirm]')).toBeNull();
    expect(list.q('B1', '[data-agenda-card-close]')).not.toBeNull();
  });

  it('closes with the reason offered, and with the one the owner typed instead', async () => {
    const list = await draw(THREE);

    await click(list.q('B1', '[data-agenda-card-close]'));
    expect((list.q('B1', '[data-agenda-card-reason]') as HTMLInputElement).value).toBe(CLOSE_CARD_REASON);
    await click(list.q('B1', '[data-agenda-card-confirm-close]'));
    await settle();
    await click(list.q('B2', '[data-agenda-card-close]'));
    await typeInto(list.q('B2', '[data-agenda-card-reason]'), 'Duplicate of B1');
    await click(list.q('B2', '[data-agenda-card-confirm-close]'));
    await settle();

    expect(list.calls).toEqual([`close:B1:${CLOSE_CARD_REASON}`, 'close:B2:Duplicate of B1']);
    expect(list.q('B1', '[data-agenda-card-done]')?.textContent).toBe('Closed.');
  });

  it('will not close with the reason emptied', async () => {
    const list = await draw(ONE);

    await click(list.q('B1', '[data-agenda-card-close]'));
    await typeInto(list.q('B1', '[data-agenda-card-reason]'), '   ');

    expect((list.q('B1', '[data-agenda-card-confirm-close]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the buttons as the board’s own writes', () => {
  const board = (refuse: boolean, held = false) => {
    const sent: string[] = [];
    return {
      sent,
      board: {
        start: async (target: { daemonId: string; id: string }) => {
          sent.push(`start:${target.daemonId}:${target.id}`);
          return refuse
            ? boardErr({ status: 403, message: 'only the owner may do that', boardCode: 'forbidden' as const })
            : boardOk({ task: target.id, sessionId: 'worker', started: !held });
        },
        drop: async (target: { daemonId: string; id: string }, reason: string) => {
          sent.push(`drop:${target.daemonId}:${target.id}:${reason}`);
          return refuse
            ? boardErr({ status: 403, message: 'only the owner may do that', boardCode: 'forbidden' as const })
            : boardOk({} as never);
        },
      },
    };
  };

  it('opens the card’s page on its machine', () => {
    const opened: string[] = [];
    const { board: wired } = board(false);
    agendaCardsActions(wired, LAPTOP, to => opened.push(to)).open('B1' as BoardTaskId);

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('laptop');
    expect(opened[0]).toContain('B1');
  });

  it('starts and closes through the board, naming the machine and the card', async () => {
    const { board: wired, sent } = board(false);
    const actions = agendaCardsActions(wired, LAPTOP, () => undefined);

    const started = await actions.start('B1' as BoardTaskId);
    const closed = await actions.close('B1' as BoardTaskId, 'no longer needed');

    expect(sent).toEqual(['start:laptop:B1', 'drop:laptop:B1:no longer needed']);
    expect(started).toEqual({ ok: true, note: 'Started: a new ferret is working on this card.' });
    expect(closed).toEqual({ ok: true, note: 'Closed. The card is off the board.' });
  });

  it('answers a card a live ferret holds with that ferret, and opens its chat page', async () => {
    const opened: string[] = [];
    const { board: wired } = board(false, true);
    const actions = agendaCardsActions(wired, LAPTOP, to => opened.push(to));

    const started = await actions.start('B1' as BoardTaskId);
    actions.openChat('worker');

    expect(started).toEqual({ ok: true, ferret: 'worker', note: 'A ferret is already working on this card.' });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('laptop');
    expect(opened[0]).toContain('worker');
  });

  it('keeps one action key across a Start that got no answer, and renews it after any answer', async () => {
    const keys: (string | undefined)[] = [];
    const answers = [
      boardErr({ status: 0, message: 'offline', boardCode: undefined }),
      boardErr({ status: 403, message: 'only the owner may do that', boardCode: 'forbidden' as const }),
      boardOk({ task: 'B1' as BoardTaskId, sessionId: 'worker', started: true }),
    ];
    const actions = agendaCardsActions(
      {
        start: async (_target: { daemonId: string; id: string }, key?: string) => {
          keys.push(key);
          return answers.shift() as never;
        },
        drop: async () => boardOk({} as never),
      },
      LAPTOP,
      () => undefined,
    );

    await actions.start('B1' as BoardTaskId);
    await actions.start('B1' as BoardTaskId);
    await actions.start('B1' as BoardTaskId);

    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('carries the daemon’s refusal back in its own words', async () => {
    const { board: wired } = board(true);
    const actions = agendaCardsActions(wired, LAPTOP, () => undefined);

    expect(await actions.start('B1' as BoardTaskId)).toEqual({ ok: false, message: 'only the owner may do that' });
    expect(await actions.close('B1' as BoardTaskId, 'x')).toEqual({ ok: false, message: 'only the owner may do that' });
  });
});
