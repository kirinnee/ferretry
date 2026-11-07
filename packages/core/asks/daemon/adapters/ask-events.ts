import type { EventsPort } from '@ferretry/kernel/contract';
import { AskAnswered, AsksChanged, type AskId } from '../../contract/index.ts';
import type { AgendaBoardChange, AgendaChangeObserver } from '../lib/agenda/service.ts';
import { answersOn } from './asks-port.ts';

/** The repository delivers committed changes (also after recovery); events wake consumers of the public port. */
export class AskEvents implements AgendaChangeObserver {
  constructor(private readonly events: EventsPort) {}

  async changed(ferret: string, change: AgendaBoardChange): Promise<void> {
    const item = change.item ?? change.addressed;
    if (item === undefined) return;
    const answered = change.change === 'answered' || (change.change === 'resolved' && change.actor.kind === 'human');
    const latest = item.history?.at(-1);
    const cardAnswers = new Set(
      (item.cardAsks ?? []).flatMap(ask => (ask.answer === undefined ? [] : [`an_${ask.answer.receipt.slice(0, 24)}`])),
    );
    if (answered) {
      for (const answer of answersOn(ferret, item)) {
        // A daemon card answer names the precise obligation in its history; older answers are already published.
        if (change.actor.kind === 'daemon' && answer.entry !== latest?.note) continue;
        if (change.actor.kind === 'human' && cardAnswers.has(answer.id)) continue;
        this.events.publish(AskAnswered, {
          ferret,
          askId: item.id as AskId,
          answerId: answer.id,
          source: answer.source,
          entry: answer.entry,
        });
      }
    }
    this.events.publish(AsksChanged, {
      ferret,
      askId: item.id as AskId,
      state:
        change.addressed === undefined ? 'open' : change.actor.kind === 'human' && answered ? 'answered' : 'closed',
    });
  }
}
