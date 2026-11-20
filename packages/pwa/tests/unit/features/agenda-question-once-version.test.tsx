/**
 * THE QUESTION IS SAID ONCE, judged against the title the owner actually sees (&B165 round 4). The view's sticky row
 * always shows the CURRENT item's title; the card may draw an OLDER version picked from the ⋯ menu. An older question is
 * left out of "What I need from you" only when the title above says the same words, never against its own old title.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { AgendaItemCard } from '../../../src/features/agenda/agenda-item-card.tsx';
import { agendaProse } from '../../../src/features/agenda/agenda-prose.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.localStorage.clear();
});

/** An untitled short question, reworded once: version 1 asked "Which engine?", the current one "Which storage format?". */
const reworded = (): AgendaItem =>
  agendaItem('A9', {
    kind: 'reply',
    subject: 'Which storage format?',
    ask: { kind: 'open-question' },
    raisedBy: 'agent',
    revisions: [
      { at: '2026-08-01T11:00:00.000Z', by: 'agent', changed: ['subject'], previous: { subject: 'Which engine?' } },
    ],
  } as never);

const draw = async (shown?: number): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemCard
      busy={false}
      error={null}
      ferret="kai"
      item={reworded()}
      now={Date.parse('2026-08-01T12:00:00.000Z')}
      onAct={() => undefined}
      renderProse={agendaProse()}
      swipeable={false}
      {...(shown === undefined ? {} : { shown })}
    />,
  );
  return must(view.container.querySelector<HTMLElement>('[data-agenda-part="needs"]'), 'needs');
};

describe('an older version’s question is judged against the title on screen', () => {
  test('the latest version leaves its question out: the title above already says it', async () => {
    const needs = await draw();
    expect(needs.querySelector('[data-agenda-question-line]')).toBeNull();
  });

  test('version 1 keeps its own question, because the title above still shows the current one', async () => {
    const needs = await draw(1);
    expect(needs.querySelector('[data-agenda-question-line]')?.textContent).toContain('Which engine?');
  });
});
