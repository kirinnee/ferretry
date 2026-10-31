/**
 * "Done · closes &F12" in the quick replies, one state per URL (`doneclose-screenshot.ts` bundles and drives it):
 *
 *   ?view=row      a to-do with two answers: the button takes the free → slot of the one row
 *   ?view=full     a review with three answers: the button goes in the extras row under them
 *   ?view=alone    a to-do with no answer of its own: the button is the row
 *   ?view=multi    an item linked to three cards: the checklist, all ticked, asks before it closes
 *   ?view=error    the card refuses to close: the item stays open with "Not closed: …"
 *   ?view=busy     the close is in flight: the button is disabled and spins
 *
 * The REAL `AgendaQuickReplies` and `useDoneCloseFlow` draw it; only the board is invented (the close resolves,
 * refuses or hangs by view), and the item's resolve goes nowhere but the "Resolved" line under the card.
 */

import type { AgendaItem, TaskRef } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { cardModel } from '../src/lib/agenda-card-model.ts';
import { swipeMap } from '../src/lib/agenda-inbox.ts';
import { itemOptions } from '../src/lib/agenda-options.ts';
import type { DoneCloseCard, DoneCloseSource } from '../src/lib/agenda-done-close.ts';
import { AgendaQuickReplies } from '../src/features/agenda/agenda-quick-replies.tsx';
import { useDoneCloseFlow } from '../src/features/agenda/use-done-close-flow.ts';

const NOW = Date.parse('2026-10-29T09:00:00.000Z');

const base = {
  source: 'agent-raised',
  sourceRef: null,
  waitingSince: new Date(NOW - 5 * 60_000).toISOString(),
  howToResolve: 'Answer it.',
  raisedBy: 'agent',
  raisedBySession: 'fr',
  raisedByName: 'ottilie',
  offerClose: true,
} as const;

const ITEMS: Readonly<Record<string, AgendaItem>> = {
  row: {
    ...base,
    id: 'A61',
    title: 'Try the relay fallback on your phone',
    subject: 'Try the relay fallback on your phone, then say how it went.',
    why: 'The card sits in Released · to test.',
    ask: { kind: 'multiple-choice', options: [{ label: 'It works' }, { label: 'It is broken' }] },
    answers: [
      { direction: 'left', does: 'choose', label: 'It works' },
      { direction: 'up', does: 'choose', label: 'It is broken' },
    ],
    task: { id: 'F12' },
  },
  full: {
    ...base,
    id: 'A62',
    title: 'Review the pairing copy',
    subject: 'Review the pairing copy before it ships.',
    why: 'Three options, so the button goes under them.',
    ask: { kind: 'multiple-choice', options: [{ label: 'Approve' }, { label: 'Changes' }, { label: 'Later' }] },
    answers: [
      { direction: 'left', does: 'choose', label: 'Approve' },
      { direction: 'up', does: 'choose', label: 'Changes' },
      { direction: 'right', does: 'choose', label: 'Later' },
    ],
    task: { id: 'F12' },
  },
  alone: {
    ...base,
    id: 'A63',
    title: 'Rotate the relay key',
    subject: 'Rotate the relay key when you have a minute.',
    why: 'A to-do: nothing to choose, only to finish.',
    ask: { kind: 'task' },
    task: { id: 'F12' },
  },
} as unknown as Record<string, AgendaItem>;

const CARDS: readonly DoneCloseCard[] = [
  { ref: { id: 'F12' }, title: 'Relay fallback' },
  { ref: { id: 'F14' }, title: 'Pairing copy' },
  { ref: { id: 'F19' }, title: 'Key rotation' },
];

const view = new URL(location.href).searchParams.get('view') ?? 'row';
const item = ITEMS[view] ?? ITEMS.alone ?? (ITEMS.row as AgendaItem);

const source = (): DoneCloseSource => {
  const cards = view === 'multi' ? CARDS : CARDS.slice(0, 1);
  return {
    cards,
    close: (refs: readonly TaskRef[]) => {
      if (view === 'busy') return new Promise(() => undefined);
      if (view === 'error' || view === 'multi-error') {
        return Promise.resolve({ ok: false, message: 'only the owner may close a card in the Closed lane' } as const);
      }
      void refs;
      return Promise.resolve({ ok: true } as const);
    },
  };
};

function Harness() {
  const [resolved, setResolved] = useState<string | null>(null);
  const doneClose = useDoneCloseFlow(source(), label => setResolved(label));
  const target = ITEMS[view] ?? item;
  return (
    <main className="mx-auto flex min-h-screen max-w-[640px] flex-col justify-end gap-3 p-4" data-fixture="">
      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs text-muted">needs you · !{target.id}</p>
        <h1 className="m-0 mt-1 text-base font-semibold">{target.title ?? target.subject}</h1>
        <p className="m-0 mt-2 text-sm text-muted">{target.why}</p>
      </section>
      {resolved === null ? (
        <AgendaQuickReplies
          busy={false}
          error={null}
          map={swipeMap(target)}
          model={cardModel(target)}
          onAct={() => undefined}
          options={itemOptions(target)}
          swipeable={false}
          {...(doneClose === undefined ? {} : { doneClose })}
        />
      ) : (
        <p className="m-0 text-sm" data-resolved="">
          Resolved: {resolved}
        </p>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Harness />);
