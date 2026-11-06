/**
 * AN ANSWER THAT DID NOT LAND IS SAID ONCE, beside the item's one ask (&B165): "Not sent: <why>", whether that ask is a
 * card's try-it answered with one Good and the words typed below, or a notice's form of cards answered by its one Send.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaGate, AgendaItem } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import { Markdown } from '../../../src/components/markdown.tsx';
import { AgendaCardsList } from '../../../src/features/agenda/agenda-cards-list.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.localStorage.clear();
});

const tryGate: AgendaGate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Ready to try',
  entry: 3,
  projectId: 'p1',
  cardTitle: 'Badge colour',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};

const draw = async (
  item: AgendaItem,
  extra: { cardsForm?: ReactElement; typedAnswer?: boolean },
): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemView
      busy={false}
      error="the machine is offline"
      ferret="Zoe"
      history={[]}
      item={item}
      itemKey={`laptop/sess-1/${item.id}`}
      now={Date.parse('2026-08-01T12:00:00.000Z')}
      onAct={() => undefined}
      onClose={() => undefined}
      position={{ index: 0, total: 1 }}
      renderProse={text => <Markdown text={text} />}
      swipeable={false}
      {...extra}
    />,
  );
  return must(view.container.querySelector<HTMLElement>('[data-agenda-part="needs"]'), 'needs');
};

describe('“Not sent” beside the one ask', () => {
  test('a typed try-it (one Good, words below) says why the answer did not land', async () => {
    const item = agendaItem('A404', {
      title: 'Badge colour',
      kind: 'reply',
      ask: { kind: 'open-question' },
      subject: 'Try it: Badge colour',
      raisedBy: 'daemon',
      source: 'task',
      sourceRef: 'card-agenda:F12',
      task: { id: 'F12' },
      stage: 'test',
      gateAttached: tryGate,
      cardAsks: [{ gate: tryGate, at: '2026-08-01T11:00:00.000Z', howToTest: '1. Open the Inbox' }],
    } as unknown as Partial<AgendaItem>);
    const needs = await draw(item, { typedAnswer: true });
    expect(needs.querySelector('[data-agenda-card-ask-error]')?.textContent).toBe('Not sent: the machine is offline');
  });

  test('a notice answered by its form of cards says it once, under the form', async () => {
    const cards = [
      { task: { id: 'B1' }, line: '&B1 Fix the badge is waiting in Review/CI, but no ferret is assigned.' },
    ];
    const actions = {
      cardPath: (id: string) => `/board/${id}`,
      chatPath: (id: string) => `/session/${id}`,
      open: () => undefined,
      openChat: () => undefined,
      start: async () => ({ ok: true as const, note: 'Started.' }),
      close: async () => ({ ok: true as const, note: 'Closed.' }),
    };
    const item = agendaItem('A9', {
      kind: 'info',
      notice: true,
      subject: 'A card has nobody working on it',
      cards,
    } as unknown as Partial<AgendaItem>);
    const needs = await draw(item, {
      cardsForm: <AgendaCardsList actions={actions as never} cards={cards as never} />,
    });
    const lines = [...needs.querySelectorAll('[role="alert"]')].map(each => each.textContent);
    expect(lines).toEqual(['Not sent: the machine is offline']);
  });
});
