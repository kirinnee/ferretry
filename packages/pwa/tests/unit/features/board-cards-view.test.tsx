import { afterEach, describe, expect, it } from 'bun:test';
import { BoardCardsView } from '../../../src/features/board/board-cards-view.tsx';
import { chatCards } from '../../../src/lib/board-chat.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card, laptop } from '../board-support.ts';

const NOW = Date.parse('2026-08-02T12:00:00.000Z');

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const cardsOf = async (extra: readonly ReturnType<typeof card>[]) =>
  chatCards(await boardModelOf(extra), {
    daemonId: laptop.daemonId,
    sessionId: 's1',
    focus: null,
    relatives: new Set(),
    agents: false,
  });

describe('BoardCardsView — a plan the host draws itself', () => {
  it('falls back to the host’s card under a rank bar and steps with the pager when no answers are given', async () => {
    const cards = await cardsOf([
      card('F1', { owner: 's1', laneId: 'plan', title: 'First plan' }),
      card('F2', { owner: 's1', laneId: 'plan', title: 'Second plan' }),
    ]);
    view = await mount(
      <BoardCardsView
        cards={cards}
        draw={entry => <p data-drawn={entry.task.id}>{entry.task.title}</p>}
        now={NOW}
        onOpenCard={() => undefined}
        projectNames={undefined}
        taskNames={undefined}
        toTestAnswers={undefined}
      />,
    );
    const root = view.container;
    expect(root.querySelector('[data-board-cards-rank]')?.textContent).toBe('To approve');
    expect(root.querySelector('[data-drawn]')?.getAttribute('data-drawn')).toBe('F1');
    await interact(() => must(root.querySelector<HTMLButtonElement>('button[aria-label="Next card"]'), 'Next').click());
    expect(root.querySelector('[data-drawn]')?.getAttribute('data-drawn')).toBe('F2');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('button[aria-label="Previous card"]'), 'Previous').click(),
    );
    expect(root.querySelector('[data-drawn]')?.getAttribute('data-drawn')).toBe('F1');
  });
});
