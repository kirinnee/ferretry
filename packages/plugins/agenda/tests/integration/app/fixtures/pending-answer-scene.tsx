/**
 * The browser entry for "an answer in its undo window, in the item's conversation": the REAL `AgendaItemView` over the
 * History built exactly as the views build it (`withDeviceEvents` of the stored history and `pendingAnswerEvents` of a
 * REAL `DeferredAgendaActions`). Three buttons stand for the owner: answer, Undo, and "the window closes now" (the commit
 * then never settles, so the line stays in its "being sent" state). Fake data only.
 *
 *   ?theme=<family>-<mode>
 */

import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { type HistoryEvent, withDeviceEvents } from '../../../../app/lib/agenda-history.ts';
import { DeferredAgendaActions, inboxCardKey } from '../../../../app/lib/agenda-inbox.ts';
import { pendingAnswerEvents } from '../../../../app/lib/pending-answer-history.ts';
import { type DaemonId } from '../../../../app/shell.ts';
import { agendaItem, choices, inboxCard } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.now();
const item = agendaItem('A47', {
  title: 'Ship the relay fix',
  subject: 'Ship the relay fix today?',
  premise: '- The fix passed review',
  waitingSince: new Date(NOW - 3_600_000).toISOString(),
  ask: choices('Ship', 'Hold'),
});
const card = inboxCard(item, undefined, 'Workshop', 'workshop' as DaemonId);
const key = inboxCardKey(card.daemonId, card.view.config.id, item.id);

// A commit that never settles: after the window the answer stays "being sent".
const deferred = new DeferredAgendaActions(() => new Promise<void>(() => undefined));

const stored: readonly HistoryEvent[] = [
  { kind: 'ferret', key: 'f1', at: NOW - 3_000_000, text: 'Ship the relay fix today, or hold it for the next window?' },
];

function Scene() {
  const state = useSyncExternalStore(deferred.subscribe, deferred.getSnapshot);
  const shown = withDeviceEvents(stored, pendingAnswerEvents(state, key, item));
  return (
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <div className="kt-row" data-scene-controls="">
          <button
            className="kt-btn"
            data-scene-answer=""
            onClick={() =>
              deferred.schedule(card, {
                kind: 'respond',
                label: 'Ship',
                response: { kind: 'multiple-choice', choice: 'Ship' },
              })
            }
            type="button"
          >
            Answer Ship
          </button>
          <button className="kt-btn" data-scene-undo="" onClick={() => deferred.undo()} type="button">
            Undo
          </button>
          <button className="kt-btn" data-scene-flush="" onClick={() => deferred.flush()} type="button">
            Window closes
          </button>
        </div>
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
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
