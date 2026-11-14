/**
 * The browser entry for "an open agenda item shows its conversation alone, not the ferret's whole page": Conversation's REAL
 * `SessionChatPage`, `embedded` exactly as the `agenda.conversation` slot draws it (no toolbar, no side panels, so no
 * terminal that asks for a passkey), under a plain stand-in for the item's card (Agenda draws the real one; a plugin's tests
 * reach another plugin only through its contract). Everything on screen is fake data.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { SessionChatPage } from '../../../../app/chat/session-chat-page.tsx';
import { ferretView } from '../../../support/app/ferret-view.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const entries: readonly TranscriptEntry[] = [
  { id: 'e1', kind: 'user', text: 'Please fix the parser and tell me what you chose.', at: NOW - 600_000 },
  {
    id: 'e2',
    kind: 'assistant',
    label: 'zoe',
    text: 'Two ways to go: patch the parser or rewrite the test. Asked on !A1.',
    at: NOW - 300_000,
  },
];

const client = { call: async () => ({}) } as never;

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      {phone ? null : (
        <nav style={{ width: 168, flex: 'none', borderRight: '1px solid var(--border)', padding: 8 }}>
          <p>Ferrets</p>
          <p>Agenda</p>
          <p>Board</p>
        </nav>
      )}
      <div
        style={{ width: phone ? '100%' : 700, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <section data-fake-item="" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <p>Zoe · Fixture running · workshop</p>
          <h2>Which fix should I apply?</h2>
          <p>The parser drops the last row; the test also asserts the old behaviour.</p>
          <p>A Patch the parser · B Rewrite the test</p>
        </section>
        <div data-fake-conversation="" style={{ flex: 1, minHeight: 0 }}>
          <SessionChatPage
            client={client}
            daemonId="ws"
            embedded
            entries={entries}
            session={ferretView('zoe', { config: { teammate: 'zoe' } })}
          />
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
