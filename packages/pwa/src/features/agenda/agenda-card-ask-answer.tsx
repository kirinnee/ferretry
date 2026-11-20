/**
 * THE ONE ASK OF A CARD'S OWN AGENDA, drawn INSIDE "What I need from you" (docs/agenda.md § One ask): the daemon opened
 * this agenda for the card, so it asks nothing else, and a gated card has NO answer of its own anywhere — this is the
 * only place it is moved.
 *
 *   how to try it   everything someone cold needs, written by the daemon from the card (the preview link first when
 *                   the card has one, the card's steps, the shipped version and the PR)
 *   one tap         the lane's pass, in the lane's words ("Good" at a try-it; "OK to build" at an approval)
 *   words           everything else is TYPED in the box under the card: the daemon sends it as the lane's fail
 *                   ("Not good", the card goes back with the words) or, at an approval, as "Not yet"
 *
 * There is no "Not good" button and no "card: your answer" box: two places to answer read as the card asking.
 */

import { gateButtonLabel, gateTapOptions, gateTypedLabel, gateTypedLead } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { optionAction } from '../../lib/agenda-answers.ts';
import type { InboxAction } from '../../lib/agenda-inbox.ts';
import type { ItemCardAsk } from '../../lib/agenda-item-sections.ts';
import { toGateAction } from '../../lib/gate-items.ts';

export function CardAskAnswer({
  ask,
  busy,
  onAct,
  renderProse,
}: {
  readonly ask: ItemCardAsk;
  readonly busy: boolean;
  readonly onAct: (action: InboxAction) => void;
  readonly renderProse: (text: string) => ReactNode;
}) {
  const { gate } = ask;
  const text = ask.howToTest?.trim() ?? '';
  return (
    <div className="fy-card__try-it" data-agenda-own-ask={gate.cardId}>
      {text === '' ? null : (
        <div className="fy-board-test fy-card__try-steps" data-agenda-try-it="">
          {renderProse(text)}
        </div>
      )}
      <div className="fy-card__try-taps" data-agenda-try-taps="">
        {gateTapOptions(gate).map(option => (
          <button
            className="kt-btn fy-qr__chip"
            data-agenda-answer-option={option.label}
            data-variant="primary"
            disabled={busy}
            key={option.id}
            onClick={() => onAct(toGateAction(optionAction({ label: option.label }, ''), gate))}
            type="button"
          >
            {gateButtonLabel(gate, option)}
          </button>
        ))}
      </div>
      {gateTypedLabel(gate) === undefined ? null : (
        <p className="fy-card__need-lead" data-agenda-typed-lead="">
          {gateTypedLead(gate)}
        </p>
      )}
    </div>
  );
}
