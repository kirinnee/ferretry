/** THE ASKS THAT STOP A FERRET UNTIL THE OWNER ANSWERS, with the quick replies the Inbox and the chat have. */

import type { AgendaRef, AgendaResponse } from '@ferretry/protocol';
import { useState } from 'react';
import { cardModel } from '../../../lib/agenda-card-model.ts';
import { swipeMap } from '../../../lib/agenda-inbox.ts';
import { itemOptions } from '../../../lib/agenda-options.ts';
import type { CardAsks } from '../../../lib/board-detail.ts';
import type { FerretNames } from '../../../lib/board-present.ts';
import { agendaHeading } from '../../agenda/agenda-delivery.tsx';
import { AgendaQuickReplies } from '../../agenda/agenda-quick-replies.tsx';

export interface WaitingOnYouProps {
  readonly asks: CardAsks;
  readonly names: FerretNames;
  /** Answers through the agenda path; the words of a refusal, or `null` when it went through. */
  readonly onAnswer: (ref: AgendaRef, response: AgendaResponse, note?: string) => Promise<string | null>;
}

export function WaitingOnYou({ asks, names, onAnswer }: WaitingOnYouProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocking = asks.open.filter(row => row.blocking);
  return (
    <ul className="fy-board-detail__waiting">
      {blocking.map(({ ref, item }) => {
        const key = `${ref.sessionId}/${ref.id}`;
        const model = item === null ? null : cardModel(item);
        return (
          <li data-ask={ref.id} key={key}>
            {item === null ? (
              <p className="fy-board-detail__quiet">
                {asks.reading
                  ? 'Reading the ask…'
                  : `${names(ref.sessionId)} is waiting, but its ask is not listed any more.`}
              </p>
            ) : (
              <>
                <p className="fy-board-detail__asktitle">{agendaHeading(item)}</p>
                {item.why === undefined || item.why === '' ? null : (
                  <p className="fy-board-detail__quiet">{item.why}</p>
                )}
                {item.ask === undefined || model === null || model.perQuestion ? (
                  <p className="fy-board-detail__quiet">Answer this one in the Inbox.</p>
                ) : (
                  <AgendaQuickReplies
                    busy={busy === key}
                    error={null}
                    map={swipeMap(item)}
                    model={model}
                    onAct={action => {
                      if (action.kind !== 'respond') return;
                      setBusy(key);
                      setError(null);
                      void onAnswer(ref, action.response, action.note).then(failed => {
                        setBusy(null);
                        setError(failed);
                      });
                    }}
                    onSkip={() => undefined}
                    options={itemOptions(item)}
                    swipeable={false}
                  />
                )}
              </>
            )}
          </li>
        );
      })}
      {error === null ? null : (
        <li className="fy-board-reason__error" role="alert">
          {error}
        </li>
      )}
    </ul>
  );
}
