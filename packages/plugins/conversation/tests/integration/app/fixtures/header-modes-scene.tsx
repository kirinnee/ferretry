/**
 * The browser entry for "a ferret's header is the name and the status, and every mode is one click behind Modes": Conversation's
 * REAL `SessionChatPage` and `ModesMenu`, with Conversation's real Hypermedia and Compact memory at panels in the
 * `conversation.modes` slot and plain stand-ins for the other plugins' panels (a plugin's tests reach another plugin only
 * through its contract): the Ferrets header (name, status, Info, Actions) and Agenda mode / Passive lessons. Everything on
 * screen is fake data.
 *
 *   ?theme=<family>-<mode>
 *   ?modes=toolbar   the BEFORE: every mode placed on `ferret.toolbar` as 5.0 drew it before the menu
 */

import { WithSlotPanels } from '@ferretry/app/testing';
import { createRoot } from 'react-dom/client';
import { ChevronDown, Info } from 'lucide-react';
import { SessionChatPage } from '../../../../app/chat/session-chat-page.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { CompactAtPanel } from '../../../../app/compact-at/compact-at-panel.tsx';
import { HypermediaPanel } from '../../../../app/toolbar/hypermedia-panel.tsx';
import { ferretView } from '../../../support/app/ferret-view.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const before = params.get('modes') === 'toolbar';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const entries: readonly TranscriptEntry[] = [
  { id: 'e1', kind: 'user', text: 'Please fix the parser and tell me what you chose.', at: NOW - 600_000 },
  { id: 'e2', kind: 'assistant', label: 'muriel', text: 'Patched the parser; the test now passes.', at: NOW - 300_000 },
];

const client = {
  call: async (route: string) =>
    route.includes('compact-at') ? { effective: 'auto', window: 200_000 } : { enabled: true },
  subscribe: () => () => undefined,
} as never;

const subject = (props: Record<string, unknown>) => (props['subject'] as string | undefined) ?? '';

const modes = [
  {
    plugin: 'conversation',
    id: 'hypermedia',
    view: (props: Record<string, unknown>) => <HypermediaPanel subject={subject(props)} />,
  },
  {
    plugin: 'conversation',
    id: 'compact-at',
    view: (props: Record<string, unknown>) => <CompactAtPanel subject={subject(props)} />,
  },
  {
    plugin: 'agenda',
    id: 'ferret-agenda-mode',
    view: () => (
      <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-ui">
        <input type="checkbox" role="switch" aria-checked defaultChecked /> Agenda mode{' '}
        <span className="text-meta text-muted">On</span>
      </label>
    ),
  },
  {
    plugin: 'lessons',
    id: 'ferret-lessons',
    view: () => (
      <div className="flex flex-col gap-2">
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-ui">
          <input type="checkbox" role="switch" aria-checked defaultChecked /> Passive lessons{' '}
          <span className="text-meta text-muted">On</span>
        </label>
        <button className="kt-btn" type="button">
          Scan this ferret for lessons…
        </button>
      </div>
    ),
  },
];

const header = [
  { plugin: 'ferrets', id: 'name', view: () => <strong className="text-ui">Muriel</strong> },
  { plugin: 'ferrets', id: 'status', view: () => <span className="text-meta text-muted">● running</span> },
  {
    plugin: 'ferrets',
    id: 'info',
    view: () => (
      <button aria-label="Info" className="kt-btn kt-btn--sm" type="button">
        <Info aria-hidden="true" size={14} />
      </button>
    ),
  },
  {
    plugin: 'ferrets',
    id: 'actions',
    view: () => (
      <button className="kt-btn kt-btn--sm" type="button">
        Actions <ChevronDown aria-hidden="true" size={14} />
      </button>
    ),
  },
];

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
      <div style={{ flex: 1, minWidth: 0, height: '100%' }} data-fake-page="">
        <ConversationClientProvider client={client}>
          <WithSlotPanels
            slots={
              before
                ? { 'ferret.toolbar': [...header, ...modes] }
                : { 'ferret.toolbar': header, 'conversation.modes': modes }
            }
          >
            <SessionChatPage
              client={client}
              daemonId="ws"
              entries={entries}
              session={ferretView('muriel', { config: { teammate: 'muriel' } })}
            />
          </WithSlotPanels>
        </ConversationClientProvider>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
