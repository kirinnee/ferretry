/**
 * The browser entry for "The Agenda tab and the Inbox of a mixed fleet": the REAL `InfoPanel` with its tab strip, the
 * real Overview line (`InfoAbout`), the real `AgendaTab` and the real `agendaTabModel`, over items shaped as a daemon
 * writes them (a closed item is `stage: done` with its earlier stages kept in `stages`). Opening a row is recorded in
 * `[data-opened]`; the Overview's "Open Agenda" button switches the tab, as the shell's does.
 *
 *   ?theme=<family>-<mode>
 */

import type { AgendaItem, ResolvedAgendaItem } from '@ferretry/core-asks/contract';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaTab } from '../../../../app/features/agenda/agenda-tab.tsx';
import { InfoAbout } from '../../../../app/shell.ts';
import type { InfoTab } from '../../../../app/shell.ts';
import { InfoPanel } from '../../../../app/shell.ts';
import { agendaTabModel } from '../../../../app/lib/agenda-tab.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const TABS: readonly InfoTab[] = ['overview', 'agenda', 'tasks', 'runtime'];

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
const view = sessionView('lead', { config: { teammate: 'denisha', name: 'Board System Design' } });

function Scene() {
  const [tab, setTab] = useState<InfoTab>('overview');
  const [opened, setOpened] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <p data-opened="">{opened}</p>
      <InfoPanel
        name="Denisha"
        onClose={() => undefined}
        onTabChange={setTab}
        render={{
          overview: () => (
            <InfoAbout
              agenda={{
                counts: {
                  'needs-you': model.rows['needs-you'].length,
                  resting: model.rows.resting.length,
                  snoozed: model.rows.snoozed.length,
                  resolved: model.rows.resolved.length,
                },
                onOpen: () => setTab('agenda'),
              }}
              onOpenSession={() => undefined}
              subFerrets={[]}
              view={view}
            />
          ),
          agenda: () => <AgendaTab model={model} onOpen={item => setOpened(item.id)} />,
          tasks: () => <p data-tasks-body="">Tasks body</p>,
          runtime: () => null,
          usage: () => null,
          folder: () => null,
          surfaces: () => null,
        }}
        tab={tab}
        tabs={TABS}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Scene />);
