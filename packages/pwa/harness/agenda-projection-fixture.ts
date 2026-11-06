import { agendaListSnapshot, type AgendaSnapshot } from '@ferretry/protocol';
import { projectionRecord } from '../../protocol/tests/fixtures/agenda-projection.ts';

/** Invented review data only; the HTTP harness serves this document when its header is opened. */
export const RESOLVED_AGENDA_DOCUMENT = {
  ...projectionRecord(),
  title: 'Relay release checked',
  subject: 'The phone can reconnect after the relay release',
  body: 'The release is installed. The phone reconnects through the relay and receives new messages.\n\nThe desktop and phone checks passed in both colour schemes.',
  tabs: [
    {
      id: 'notes',
      name: 'Checks',
      body: '- Reconnect after the release.\n- Open a resolved agenda item.\n- Read the complete conversation and earlier edits.',
    },
  ],
  revisions: [
    {
      at: '2026-10-26T09:00:00.000Z',
      by: 'agent' as const,
      changed: ['body' as const],
      previous: { body: 'The release was still being checked.' },
    },
  ],
  conversation: [
    {
      at: '2026-10-26T08:50:00.000Z',
      by: 'owner' as const,
      via: 'reply' as const,
      text: 'Please check reconnecting from the phone too.',
    },
    {
      at: '2026-10-26T09:00:00.000Z',
      by: 'ferret' as const,
      via: 'chat-log' as const,
      text: 'Checked. The phone reconnects and the full history is still readable.',
    },
  ],
  conversationCount: 2,
  resolutionNote: 'Checked on the phone. Ready to use.',
};
export const RESOLVED_AGENDA_LIST = agendaListSnapshot({
  v: 1,
  sessionId: 'fr',
  items: [],
  resolved: [RESOLVED_AGENDA_DOCUMENT],
  count: 0,
  parseErrors: 0,
  updatedAt: '2026-10-26T09:00:00.000Z',
} satisfies AgendaSnapshot);
