import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaCardRow, BoardTaskId } from '@ferretry/protocol';
import {
  type AgendaCardOutcome,
  AgendaCardsList,
  CLOSE_CARD_REASON,
} from '../../../src/features/agenda/agenda-cards-list.tsx';
import { agendaCardsActions } from '../../../src/lib/agenda-cards-actions.ts';
import { boardErr, boardOk } from '@ferretry/protocol';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';

const LAPTOP = daemonId('laptop');
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
    cardPath: (id: BoardTaskId) => `/board/${id}`,
    chatPath: (sessionId: string) => `/session/${sessionId}`,
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
  let sent = 0;
  const view = await mount(<AgendaCardsList actions={actions} cards={cards} onSent={() => (sent += 1)} />);
  mounted.push(view);
  const row = (id: string) => view.container.querySelector<HTMLElement>(`[data-agenda-card-row="${id}"]`);
  const q = (id: string, selector: string) => row(id)?.querySelector<HTMLElement>(selector) ?? null;
  const pick = async (id: string, value: 'start' | 'close' | 'leave') =>
    click(q(id, `[data-agenda-card-pick="${value}"]`));
  const send = async () => {
    await click(view.container.querySelector<HTMLElement>('[data-agenda-cards-send]'));
    await settle();
  };
  return { calls, row, q, view, pick, send, sent: () => sent };
};

describe('the cards of a notice, answered as ONE form (&B165)', () => {
  it('draws one row per card — its line, a link to it, a pick — and ONE Send for them all, no per-card buttons', async () => {
    const list = await draw(THREE);
    for (const id of ['B1', 'B2', 'B3']) {
      expect(list.q(id, '[data-agenda-card-open]')?.textContent).toBe(`Open &${id}`);
      expect(list.q(id, '[data-agenda-card-open]')?.tagName).toBe('A');
      const picks = [...(list.row(id)?.querySelectorAll('[data-agenda-card-pick]') ?? [])].map(input =>
        input.getAttribute('data-agenda-card-pick'),
      );
      expect(picks).toEqual(['start', 'close', 'leave']);
      expect((list.q(id, '[data-agenda-card-pick="leave"]') as HTMLInputElement).checked).toBe(true);
      expect(list.row(id)?.querySelectorAll('button')).toHaveLength(0);
    }
    expect(list.view.container.querySelectorAll('button')).toHaveLength(1);
    expect(list.view.container.querySelector('[data-agenda-cards-send]')?.textContent).toBe('Send');
    // One compact line: the card and where it waits (the place is hidden on a phone by CSS, never cut from the text).
    expect(list.q('B2', '[data-agenda-card-line]')?.textContent).toBe('&B2 Fix the login page · in Implement');
  });

  it('opens only the card whose link was pressed', async () => {
    const list = await draw(THREE);
    await click(list.q('B2', '[data-agenda-card-open]'));
    expect(list.calls).toEqual(['open:B2']);
  });

  it('does nothing until Send, then each pick at once, and answers the notice when every pick took', async () => {
    const list = await draw(THREE);
    await list.pick('B1', 'close');
    await list.pick('B3', 'start');
    expect(list.calls).toEqual([]);
    await list.send();
    expect(list.calls).toEqual([`close:B1:${CLOSE_CARD_REASON}`, 'start:B3']);
    expect(list.q('B1', '[data-agenda-card-done]')?.textContent).toBe('Closed.');
    expect(list.q('B3', '[data-agenda-card-done]')?.textContent).toBe('Started.');
    expect(list.sent()).toBe(1);
  });

  it('with every card left, Send is Got it: nothing is moved', async () => {
    const list = await draw(THREE);
    await list.send();
    expect(list.calls).toEqual([]);
    expect(list.sent()).toBe(1);
  });

  it('says what Close does before Send, and closes with the reason the owner typed', async () => {
    const list = await draw(ONE);
    await list.pick('B1', 'close');
    expect(list.q('B1', '[data-agenda-card-close-note]')?.textContent).toContain('It leaves the board');
    expect((list.q('B1', '[data-agenda-card-reason]') as HTMLTextAreaElement).value).toBe(CLOSE_CARD_REASON);
    await typeInto(list.q('B1', '[data-agenda-card-reason]'), 'Duplicate of B2', 'textarea');
    await list.send();
    expect(list.calls).toEqual(['close:B1:Duplicate of B2']);
  });

  it('closes with the reason offered when the owner emptied it', async () => {
    const list = await draw(ONE);
    await list.pick('B1', 'close');
    await typeInto(list.q('B1', '[data-agenda-card-reason]'), '   ', 'textarea');
    await list.send();
    expect(list.calls).toEqual([`close:B1:${CLOSE_CARD_REASON}`]);
  });

  it('offers its ferret’s chat when a live ferret already holds the card', async () => {
    const list = await draw(ONE, {
      start: async () => ({ ok: true, ferret: 'worker', note: 'A ferret is already working on this card.' }),
    });
    await list.pick('B1', 'start');
    await list.send();
    const line = list.q('B1', '[data-agenda-card-line]');
    expect(line?.textContent).toBe('&B1 Fix simcha Loge 502 — a ferret has picked it up.');
    expect(line?.getAttribute('role')).toBe('status');
    expect(list.q('B1', '[data-agenda-card-picks]')).toBeNull();
    const chat = list.q('B1', '[data-agenda-card-chat]');
    expect(chat?.getAttribute('href')).toBe('/session/worker');
    await click(chat);
    expect(list.calls).toEqual(['chat:worker']);
  });

  it('says the card’s ref when a line has no "is waiting in" tail to cut', async () => {
    const list = await draw([{ task: { id: 'B9' as BoardTaskId }, line: 'Something else entirely.' }], {
      start: async () => ({ ok: true, ferret: 'worker', note: 'A ferret is already working on this card.' }),
    });
    await list.pick('B9', 'start');
    await list.send();
    expect(list.q('B9', '[data-agenda-card-line]')?.textContent).toBe('&B9 — a ferret has picked it up.');
  });

  it('shows a refusal on its row, keeps the notice open, and the next Send redoes only what did not take', async () => {
    let refuse = true;
    const list = await draw(THREE, {
      start: async (id: BoardTaskId) => {
        list_calls.push(`start:${id}`);
        return refuse
          ? { ok: false, message: '&B1’s ferret is no longer on this machine.' }
          : { ok: true, note: 'Started.' };
      },
    });
    const list_calls = list.calls;
    await list.pick('B1', 'start');
    await list.pick('B2', 'close');
    await list.send();
    expect(list.q('B1', '[data-agenda-card-problem]')?.textContent).toBe('&B1’s ferret is no longer on this machine.');
    expect((list.q('B1', '[data-agenda-card-pick="start"]') as HTMLInputElement).checked).toBe(true);
    expect(list.sent()).toBe(0);
    refuse = false;
    await list.send();
    expect(list.calls).toEqual(['start:B1', `close:B2:${CLOSE_CARD_REASON}`, 'start:B1']);
    expect(list.sent()).toBe(1);
  });
});

describe('each pick as the board’s own write', () => {
  const board = (refuse: boolean, held = false) => {
    const sent: string[] = [];
    return {
      sent,
      board: {
        start: async (target: { daemonId: string; id: string }) => {
          sent.push(`start:${target.daemonId}:${target.id}`);
          return refuse
            ? boardErr({ status: 403, message: 'only the owner may do that', boardCode: 'forbidden' as const })
            : boardOk({ task: target.id, sessionId: 'worker', started: held ? false : true });
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

describe('the Close reason box shows its whole text (&B165 round 2)', () => {
  it('is a box that grows to its lines, not a one-line field that cuts the text at the edge', async () => {
    const list = await draw(ONE);
    await list.pick('B1', 'close');
    const box = list.q('B1', '[data-agenda-card-reason]');
    expect(box?.tagName).toBe('TEXTAREA');
    expect(box?.getAttribute('rows')).toBe('1');
    expect(box?.className).not.toContain('truncate');
  });
});
