/**
 * The browser entry for "the Inbox's card text can be selected and its composer has the mic": the REAL swipe deck
 * with an agenda card on top, and the REAL Inbox composer under it, given the chat composer's dictation settings.
 *
 *   ?theme=<family>-<mode>
 */

import type { AgendaId } from '@ferretry/core-asks/contract';
import { createRoot } from 'react-dom/client';
import { AgendaCard } from '../../../../app/features/agenda/agenda-card.tsx';
import { AgendaInboxComposer } from '../../../../app/features/agenda/agenda-inbox-composer.tsx';
import { AgendaSwipeDeck } from '../../../../app/features/agenda/agenda-swipe-deck.tsx';
import { daemonConnection } from '../../../../app/shell.ts';
import { agendaItem, choices, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { WithFakeComposer } from '../../../support/app/composer-port.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const item = agendaItem('A47', {
  subject: 'One rule left before spend limits ship, and the ferret needs it today.',
  why: 'Each login has a limit. Warn never stops a turn, but Pause does, so pick the one you can live with.',
  ask: choices('Pause', 'Switch', 'Warn'),
});
const view = sessionView('sess-1', { config: { teammate: 'zoe', name: 'Fix the build' } });
const card = inboxCard(item, view);
const daemon = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'device' });
/** Dictation switched on, as Voice's defaults have it; the Inbox only passes it through to the host composer. */
const DICTATION = { enabled: true };
const phone = window.innerWidth < 768;

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="fy-attn-inbox" data-agenda-inbox="deck" {...(phone ? { 'data-phone': '' } : {})}>
        <AgendaSwipeDeck
          cards={[card]}
          onAct={() => undefined}
          reducedMotion
          renderCard={(top, act) => <AgendaCard item={top.item} onAct={act} swipeHints />}
        />
      </div>
      <div style={{ marginTop: 'auto' }}>
        <WithFakeComposer>
          <AgendaInboxComposer
            clientFor={async () => ({ send: async () => ({}) as never })}
            compact={phone}
            connection={daemon}
            dictationSettings={DICTATION}
            itemId={'A47' as AgendaId}
            view={view}
          />
        </WithFakeComposer>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
