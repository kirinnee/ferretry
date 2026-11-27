/**
 * Refusals whose task the reader is not looking at: said once, until they dismiss them. Two kinds: an answer the daemon
 * refused when it was sent (the receipts), and a RETRIED answer the daemon took and then refused again, which only the
 * next board read says (`item.undelivered`). Each refusal of a task is said once however many sends it came from.
 */

import { X } from 'lucide-react';
import { useState } from 'react';
import type { AgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import { undeliveredAction } from '../../lib/agenda-answers.ts';
import { actionSentence } from '../../lib/agenda-inbox.ts';
import { refusedAgain, type RetriedAnswers, withoutSettledRetries, withRetriesOf } from '../../lib/refused-again.ts';

interface Refusal {
  /** Unique among the refusals drawn: the task and the reason, never the send. */
  readonly id: string;
  readonly said: string;
  readonly dismissLabel: string;
  readonly dismiss: () => void;
}

const NO_RETRIES: RetriedAnswers = new Map();

/**
 * `shown` names the tasks whose own view already says their refusal; absent, that is every task still on the list. An
 * opened deck shows ONE task, so a refusal of another is said here, not only on a card the reader may never reopen.
 */
export function OrphanedFailures({
  inbox,
  shown,
}: {
  readonly inbox: AgendaInbox;
  readonly shown?: readonly string[];
}) {
  const [retried, setRetried] = useState<RetriedAnswers>(NO_RETRIES);
  const onDeck = new Set(shown ?? inbox.cards.map(card => card.key));
  const { deferredState } = inbox;
  const tracked = withoutSettledRetries(withRetriesOf(retried, deferredState), inbox.cards, onDeck, deferredState);
  if (tracked !== retried) setRetried(tracked);

  // An answer given again is held or on its way: it, not the refusal before it, is what the reader is waiting on.
  const answering = new Set([...deferredState.pending, ...deferredState.sending].map(entry => entry.key));
  const refusals = new Map<string, Refusal>();
  for (const failure of deferredState.failed) {
    if (onDeck.has(failure.key) || answering.has(failure.key)) continue;
    const id = `${failure.key}\u0000${failure.message}`;
    if (refusals.has(id)) continue;
    const sentence = actionSentence(failure.action, failure.card.item.id);
    refusals.set(id, {
      id,
      said: `Not sent — ${sentence}: ${failure.message}`,
      dismissLabel: `Dismiss: ${sentence} was not sent`,
      dismiss: () => inbox.deferred.clearFailure(failure.key),
    });
  }
  for (const card of refusedAgain(tracked, inbox.cards, onDeck)) {
    const { undelivered } = card.item;
    if (undelivered === undefined || answering.has(card.key)) continue;
    const id = `${card.key}\u0000${undelivered.reason}`;
    if (refusals.has(id)) continue;
    const sentence = actionSentence(undeliveredAction(undelivered.reply), card.item.id);
    refusals.set(id, {
      id,
      said: `Not sent — ${sentence}: ${undelivered.reason}`,
      dismissLabel: `Dismiss: ${sentence} was not sent`,
      dismiss: () =>
        setRetried(known => {
          const next = new Map(known);
          next.delete(card.key);
          return next;
        }),
    });
  }
  if (refusals.size === 0) return null;
  return (
    <ul className="fy-attn-inbox__failures" data-agenda-failures="">
      {[...refusals.values()].map(refusal => (
        <li className="fy-attn-inbox__failure" key={refusal.id} role="alert">
          <span className="min-w-0 flex-1">{refusal.said}</span>
          <button
            aria-label={refusal.dismissLabel}
            className="kt-btn kt-btn--sm"
            data-variant="ghost"
            onClick={refusal.dismiss}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
