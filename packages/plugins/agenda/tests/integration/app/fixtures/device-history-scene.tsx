/**
 * The browser entry for "the owner's words still on this device, in an item's History": the REAL `AgendaItemView`
 * over the History the real `deviceEvents` / `withDeviceEvents` build from fake outbox entries (the hook that reads
 * them has its own unit test): one message waiting for the machine and one the machine refused, both about the open
 * item, plus one about another item that must stay out.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import {
  deviceEvents,
  type DeviceWords,
  type HistoryEvent,
  withDeviceEvents,
} from '../../../../app/lib/agenda-history.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const item = agendaItem('A47', {
  title: 'Spend limit',
  subject: 'One rule left before spend limits ship.',
  premise: '- Each login has a limit',
  context: '- Warn never stops a turn',
  waitingSince: '2026-08-01T11:00:00.000Z',
  ask: choices('Pause', 'Switch', 'Warn'),
});

const entry = (over: Partial<DeviceWords>): DeviceWords => ({
  id: 'send-1',
  message: 'hello',
  references: ['^A47'],
  createdAt: '2026-08-01T11:50:00.000Z',
  ...over,
});
const held = [
  entry({ id: 'send-1', message: 'Switch them over tonight, please.', reason: 'waiting for a connection' }),
  entry({
    id: 'send-2',
    message: 'And tell the team.',
    createdAt: '2026-08-01T11:55:00.000Z',
    reason: 'that ferret was closed',
    refused: true,
  }),
  entry({ id: 'send-3', message: 'About something else.', references: ['^A9'] }),
];

const history: readonly HistoryEvent[] = [
  { kind: 'ferret', key: 'f1', at: Date.parse('2026-08-01T11:00:00.000Z'), text: 'Which limit should win?' },
  {
    kind: 'owner',
    key: 'o1',
    at: Date.parse('2026-08-01T11:30:00.000Z'),
    text: 'Pause, I think.',
    reached: { via: 'transcript', answered: true },
  },
];

const shown = withDeviceEvents(history, deviceEvents(item.id, held));

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <AgendaItemView
          busy={false}
          error={null}
          ferret="Zoe"
          history={shown}
          item={item}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          position={{ index: 0, total: 1 }}
          renderProse={text => text}
          swipeable={false}
        />
      </div>
    </div>,
  );
