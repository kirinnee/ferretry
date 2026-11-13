/**
 * The browser entry for "The Agenda tab": the REAL `AgendaTab` and the real `agendaTabModel`, over items shaped as a
 * daemon writes them (a closed item is `stage: done` with its earlier stages kept in `stages`). Opening a row is
 * recorded in `[data-opened]`.
 *
 * The Info panel's tab strip and its Overview line are Ferrets' (the tab is this half's `ferret-agenda` panel now), so
 * the scene draws the tab alone: Agenda imports nothing of Ferrets' app.
 *
 *   ?theme=<family>-<mode>
 */

import type { AgendaItem, ResolvedAgendaItem } from '@ferretry/core-asks/contract';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaTab } from '../../../../app/features/agenda/agenda-tab.tsx';
import { agendaTabModel } from '../../../../app/lib/agenda-tab.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const OPEN: readonly AgendaItem[] = [
  agendaItem('A1', {
    stage: 'plan',
    subject: 'Approve the release plan?',
    ask: choices('Approve', 'Change it'),
    waitingSince: ago(50),
  } as never),
  agendaItem('A2', {
    stage: 'test',
    subject: 'Try the new pairing flow',
    ask: choices('Done', 'Not good'),
    waitingSince: ago(20),
  } as never),
  agendaItem('A3', {
    stage: 'tracker',
    subject: 'Which tracker should this land in?',
    waitingOn: 'ferret',
    resting: { sub: 'working', at: ago(30) },
  } as never),
  agendaItem('A4', {
    stage: 'question',
    subject: 'Ship it on Friday?',
    parked: { reason: 'snoozed', at: ago(10), until: new Date(NOW + 5 * 3_600_000).toISOString() },
  } as never),
];
const CLOSED = (id: string, subject: string, history: readonly string[]): ResolvedAgendaItem =>
  ({
    ...agendaItem(id, { subject }),
    stage: 'done',
    stages: [...history.map((stage, index) => ({ stage, at: ago(600 - index * 60) })), { stage: 'done', at: ago(90) }],
    resolvedAt: ago(90),
    disposition: 'done',
  }) as unknown as ResolvedAgendaItem;
const RESOLVED: readonly ResolvedAgendaItem[] = [
  CLOSED('A5', 'Approve the old plan?', ['question', 'plan']),
  CLOSED('A6', 'Try the old build', ['test']),
];

const model = agendaTabModel({ items: OPEN, resolved: RESOLVED, ferret: 'Denisha', now: NOW });

function Scene() {
  const [opened, setOpened] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <p data-opened="">{opened}</p>
      <AgendaTab model={model} onOpen={item => setOpened(item.id)} />
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Scene />);
