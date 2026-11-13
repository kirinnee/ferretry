/**
 * The browser entry for "the open item's ⋯ menu takes focus and sits under every dialog": the same REAL `AgendaInboxPage`
 * over a fake inbox as `inbox-item-menu-scene.tsx`, plus the shell's REAL `CommandBar` opened by Cmd/Ctrl+K as the frame
 * does (a key press, so no pointer event reaches the menu's outside-press close). Everything on screen is fake data.
 *
 *   ?theme=<family>-<mode>
 */

import { CommandBar } from '@ferretry/app/ui';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { daemonId } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;
const machine = daemonId('ws');

const cards = [
  inboxCard(
    agendaItem('A1', {
      subject: 'Which fix should I apply?',
      ask: choices('Patch the parser', 'Rewrite the test'),
      premise: 'The parser drops the last row; the test also asserts the old behaviour.',
    }),
    sessionView('zoe', { config: { teammate: 'zoe', name: 'Fixture running' } }),
    'workshop',
    machine,
  ),
  inboxCard(
    agendaItem('A2', { subject: 'Ship the relay fix today?', ask: choices('Ship', 'Hold') }),
    sessionView('kai', { config: { teammate: 'kai', name: 'Release train' } }),
    'workshop',
    machine,
  ),
];
const fake = fakeInbox();

function Scene() {
  const [bar, setBar] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setBar(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
        {phone ? null : (
          <nav style={{ width: 168, flex: 'none', borderRight: '1px solid var(--border)', padding: 8 }}>
            <p>Ferrets</p>
            <p>Agenda</p>
            <p>Board</p>
          </nav>
        )}
        <div style={{ width: phone ? '100%' : 350, minWidth: 0, height: '100%' }} data-column="">
          <InboxHarness
            cards={cards}
            fake={fake}
            render={inbox => (
              <AgendaInboxPage
                clock={fake.clock.now}
                inbox={inbox}
                now={NOW}
                onNavigate={() => undefined}
                open={{ daemonId: machine, sessionId: 'zoe', id: 'A1', settled: true }}
                phone={phone}
              />
            )}
          />
        </div>
      </div>
      <CommandBar onClose={() => setBar(false)} open={bar} sources={[]} />
    </>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
