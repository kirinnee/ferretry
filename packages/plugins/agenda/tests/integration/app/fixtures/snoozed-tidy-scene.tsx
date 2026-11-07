/**
 * The browser entry for "Snoozed rows are tidy": the REAL `AgendaInboxPage` over a fake inbox with several snoozed
 * items, all fake.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import type { InboxCard } from '../../../../app/lib/agenda-inbox.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const open = inboxCard(
  agendaItem('A1', { subject: 'Ship the relay fix today?', ask: choices('Ship', 'Hold') }),
  sessionView('sess-1', { config: { teammate: 'kai', name: 'Release train' } }),
);
const SUBJECTS = [
  ['Approve the rollout?', 'ada'],
  ['Keep the old importer?', 'khristina'],
  ['Which region first?', 'hadi'],
  ['Ship the patch tonight?', 'kai'],
  ['Merge before the freeze?', 'zoe'],
  ['Pin the compiler version for the whole fleet and every one of its release trains?', 'ada'],
] as const;
const snoozed = SUBJECTS.map(
  ([subject, teammate], index): InboxCard =>
    inboxCard(
      agendaItem(`A${index + 2}`, {
        subject,
        parked: {
          reason: 'snoozed',
          at: '2026-08-01T11:00:00.000Z',
          until: `2026-08-02T${String(9 + index).padStart(2, '0')}:00:00.000Z`,
        },
      } as never),
      sessionView(`sess-${index + 2}`, { config: { teammate, name: 'Relay rollout' } }),
    ),
);

const fake = fakeInbox();

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <InboxHarness
        cards={[open]}
        fake={fake}
        parked={snoozed}
        parkedWhole
        render={inbox => (
          <AgendaInboxPage clock={fake.clock.now} inbox={inbox} now={NOW} onNavigate={() => undefined} phone={phone} />
        )}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
