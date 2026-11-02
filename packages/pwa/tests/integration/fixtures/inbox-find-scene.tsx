/**
 * The browser entry for "Inbox Find looks in every tab": the REAL `AgendaInboxPage` over a fake inbox with one open,
 * one snoozed, one replied and one resolved item, all fake. Typing "relay" into Find lists all four with their chips.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { InboxCard, InboxResolved } from '../../../src/lib/agenda-inbox.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { sessionView } from '../../support/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const open = inboxCard(
  agendaItem('A1', { subject: 'Ship the relay fix today?', ask: choices('Ship', 'Hold') }),
  sessionView('sess-1', { config: { teammate: 'kai', name: 'Release train' } }),
);
const parked = (id: string, subject: string, park: Record<string, string>): InboxCard =>
  inboxCard(
    agendaItem(id, { subject, parked: { at: '2026-08-01T11:00:00.000Z', ...park } } as never),
    sessionView(`sess-${id}`, { config: { teammate: 'durian', name: 'Relay rollout' } }),
  );
const snoozed = parked('A2', 'Relay carrier: direct first or hosted first?', {
  reason: 'snoozed',
  until: '2026-08-02T09:00:00.000Z',
});
const replied = parked('A3', 'Relay fingerprint allowlist wording', { reason: 'replied' });
const resolved = {
  key: 'resolved-A4',
  daemonId: open.daemonId,
  machineName: open.machineName,
  view: sessionView('sess-A4', { config: { teammate: 'moe', name: 'Tidy up' } }),
  record: { ...agendaItem('A4', { subject: 'Relay retry limit' }), resolvedAt: '2026-07-31T00:00:00.000Z' },
} as unknown as InboxResolved;

const fake = fakeInbox();

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <InboxHarness
        cards={[open]}
        fake={fake}
        parked={[snoozed, replied]}
        render={inbox => (
          <AgendaInboxPage clock={fake.clock.now} inbox={inbox} now={NOW} onNavigate={() => undefined} phone={phone} />
        )}
        resolved={[resolved]}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
