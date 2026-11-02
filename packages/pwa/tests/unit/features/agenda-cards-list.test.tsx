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
    open: (id: BoardTaskId) => {
      calls.push(`open:${id}`);
    },
    start: async (id: BoardTaskId): Promise<AgendaCardOutcome> => {
      calls.push(`start:${id}`);
      return { ok: true, note: 'Started.' };
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
  it('draws one row per card, each with Open card, Start a ferret on it and Close card', async () => {
    const list = await draw(THREE);

    for (const id of ['B1', 'B2', 'B3']) {
      expect(list.q(id, '[data-agenda-card-open]')?.textContent).toBe('Open card');
      expect(list.q(id, '[data-agenda-card-start]')?.textContent).toBe('Start a ferret on it');
      expect(list.q(id, '[data-agenda-card-close]')?.textContent).toBe('Close card');
    }
    expect(list.q('B2', '[data-agenda-card-line]')?.textContent).toContain(
      '&B2 Fix the login page is waiting in Implement',
    );
  });

  it('does not repeat the line of a lone card, which the notice above it already says', async () => {
    const list = await draw(ONE);

    expect(list.q('B1', '[data-agenda-card-line]')).toBeNull();
    expect(list.q('B1', '[data-agenda-card-open]')?.textContent).toBe('Open card');
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
  const board = (refuse: boolean) => {
    const sent: string[] = [];
    return {
      sent,
      board: {
        start: async (target: { daemonId: string; id: string }) => {
          sent.push(`start:${target.daemonId}:${target.id}`);
          return refuse
            ? boardErr({ status: 403, message: 'only the owner may do that', boardCode: 'forbidden' as const })
            : boardOk({ task: target.id, sessionId: 'worker' });
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
    expect(started.ok).toBe(true);
    expect(closed).toEqual({ ok: true, note: 'Closed. The card is off the board.' });
  });

  it('carries the daemon’s refusal back in its own words', async () => {
    const { board: wired } = board(true);
    const actions = agendaCardsActions(wired, LAPTOP, () => undefined);

    expect(await actions.start('B1' as BoardTaskId)).toEqual({ ok: false, message: 'only the owner may do that' });
    expect(await actions.close('B1' as BoardTaskId, 'x')).toEqual({ ok: false, message: 'only the owner may do that' });
  });
});
