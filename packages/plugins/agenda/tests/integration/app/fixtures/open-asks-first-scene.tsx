/**
 * The browser entry for "every open ask comes first, answered ones are History" (A-29): the REAL `AgendaItemCard`
 * over an item with its own ask, a task ask, a recommendation and an impact, and a conversation holding one answer.
 *
 *   ?style=<style>&palette=<palette>&mode=light|dark
 */

import { createRoot } from 'react-dom/client';
import { AgendaItemCard } from '../../../../app/features/agenda/agenda-item-card.tsx';
import { ProseView } from '../../../../app/shell.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
const html = document.documentElement;
html.dataset.style = params.get('style') ?? 'studio';
html.dataset.palette = params.get('palette') ?? 'studio';
html.dataset.mode = params.get('mode') ?? 'light';
html.dataset.theme = `${html.dataset.palette}-${html.dataset.mode}`;

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const gate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Try it',
  entry: 3,
  projectId: 'p1',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
} as const;

const item = agendaItem('A47', {
  title: 'Badge colour',
  subject: 'Which colour for the badge?',
  ask: choices('Blue', 'Green'),
  premise: '- The badge is grey today',
  context: '- Two colours tested well',
  recommendation: { decision: 'Blue', why: 'It reads as calm and passes the contrast check.' },
  impact: 'Every row in the inbox changes colour.',
  cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z' }],
} as never);

const history = [
  { kind: 'ferret', key: 'f1', at: NOW - 600_000, text: 'Which shape should the badge have?' },
  { kind: 'owner', key: 'o1', at: NOW - 500_000, text: 'Round', form: 'answer' },
] as never;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>
      <AgendaItemCard
        busy={false}
        error={null}
        ferret="Zoe"
        history={history}
        item={item}
        itemKey="scene:A47"
        now={NOW}
        onAct={() => undefined}
        renderProse={text => <ProseView text={text} />}
        swipeable={false}
      />
    </div>,
  );
