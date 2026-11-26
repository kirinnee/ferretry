/**
 * The browser entry for "every open ask comes first, answered ones are History" (A-29): the REAL `AgendaItemCard` over
 * an item that asks its own question and carries TWO task asks, a recommendation and an impact. The item is held in
 * state, so an answer tapped on the page changes it the way the daemon's snapshot would, and `window.__agenda`
 * plays a LIVE update (an answer that arrives from another device).
 *
 *   ?style=<style>&palette=<palette>&mode=light|dark
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import { AgendaItemCard } from '../../../../app/features/agenda/agenda-item-card.tsx';
import type { InboxAction } from '../../../../app/lib/agenda-inbox.ts';
import { ProseView } from '../../../../app/shell.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
const html = document.documentElement;
html.dataset.style = params.get('style') ?? 'studio';
html.dataset.palette = params.get('palette') ?? 'studio';
html.dataset.mode = params.get('mode') ?? 'light';
html.dataset.theme = `${html.dataset.palette}-${html.dataset.mode}`;

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const gate = (cardId: string, entry: number, cardTitle: string) =>
  ({
    cardId,
    cardTitle,
    laneId: 'tested',
    laneName: 'Try it',
    entry,
    projectId: 'p1',
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  }) as const;

const first = gate('F12', 3, 'Badge colour');
const second = gate('F13', 4, 'Badge shape');
const reference = (each: { readonly cardId: string; readonly laneId: string; readonly entry: number }): string =>
  `gate:${each.cardId}:${each.laneId}:${String(each.entry)}`;

const start = agendaItem('A47', {
  title: 'Badge colour',
  subject: 'Which colour for the badge?',
  ask: choices('Blue', 'Green'),
  premise: '- The badge is grey today',
  context: '- Two colours tested well',
  recommendation: { decision: 'Blue', why: 'It reads as calm and passes the contrast check.' },
  impact: 'Every row in the inbox changes colour.',
  cardAsks: [
    { gate: first, at: '2026-08-01T11:00:00.000Z' },
    { gate: second, at: '2026-08-01T11:05:00.000Z' },
  ],
} as never);

/** What the daemon's snapshot would say once the owner answered: the item's own ask, or one task ask by its reference. */
const answered = (item: AgendaItem, label: string, cardAsk: string | undefined, at: string): AgendaItem => {
  const response = { kind: 'multiple-choice', choice: label } as const;
  if (cardAsk === undefined) return { ...item, ownerAnswer: { at, response, request: 1 } } as AgendaItem;
  return {
    ...item,
    cardAsks: (item.cardAsks ?? []).map(ask =>
      reference(ask.gate) === cardAsk ? { ...ask, answer: { at, response, receipt: 'a'.repeat(64) } } : ask,
    ),
  } as AgendaItem;
};

let apply: (change: (item: AgendaItem) => AgendaItem) => void = () => undefined;
Object.assign(window, {
  __agenda: {
    /** A live update: the task ask `cardId` was answered from another device. */
    answerTask: (cardId: string, label: string): void =>
      apply(item => {
        const ask = (item.cardAsks ?? []).find(each => each.gate.cardId === cardId);
        return ask === undefined ? item : answered(item, label, reference(ask.gate), '2026-08-01T11:50:00.000Z');
      }),
  },
});

function Scene() {
  const [item, setItem] = useState<AgendaItem>(start);
  apply = change => setItem(change);
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>
      <AgendaItemCard
        busy={false}
        error={null}
        ferret="Zoe"
        item={item}
        itemKey="scene:A47"
        now={NOW}
        onAct={(action: InboxAction) => {
          if (action.kind !== 'respond') return;
          const cardAsk = action.gate === true ? action.cardAsk : undefined;
          setItem(current => answered(current, action.label, cardAsk, '2026-08-01T11:40:00.000Z'));
        }}
        renderProse={text => <ProseView text={text} />}
        swipeable={false}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
