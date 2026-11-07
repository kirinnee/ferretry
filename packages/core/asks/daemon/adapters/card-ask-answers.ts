import { createHash } from 'node:crypto';
import type {
  AnswerEffect,
  AnswerId,
  AskAnswer,
  AskId,
  AskSourceSpec,
  EntryId,
  SourceKey,
} from '../../contract/index.ts';
import type { AgendaService } from '../lib/agenda/index.ts';
import { cardAskReference, openCardAsks } from '../lib/protocol/agenda-card-asks.ts';
import { gateChoice } from '../lib/protocol/agenda-gate.ts';
import type { AgendaResponse } from '../lib/protocol/agenda.ts';
import type { AgendaGatePort, GateAnswer, GateAnswerOutcome } from '../lib/routes/agenda-gates.ts';

/** The source the Board plugin registers its card asks under (`ask.sources:card`). */
export const CARD_SOURCE = 'card' as SourceKey;

const refused = (code: 'forbidden' | 'invalid' | 'moved-on' | 'not-moved', message: string): GateAnswerOutcome => ({
  handled: true,
  refused: { code, message },
});

const effectOf = (response: AgendaResponse): AnswerEffect =>
  response.kind === 'multiple-choice' ? 'choose' : response.kind === 'permission' ? response.decision : 'clarify';

/**
 * The owner's answer to a card ask (lead decision #13, the #1552 order): the CARD MOVES FIRST, through the `card`
 * source's `apply`, and only an applied answer is recorded on the agenda — as the daemon, the one actor the state
 * machine takes a card ask's answer from. A refusal, or no Board to apply it, leaves the ask open and says why.
 *
 * Who may answer stays today's rule: only the owner, and a paired device only where it may use the board
 * (`permitted`, asked once the answer is known to be to a card ask and before the board is touched).
 */
export function cardAskAnswers(
  agenda: Pick<AgendaService, 'list' | 'cardAsk'>,
  source: () => AskSourceSpec | 'unavailable',
  now: () => string,
): AgendaGatePort {
  const askOn = async (sessionId: string, id: string, reference?: string) => {
    const listed = await agenda.list(sessionId);
    if (!listed.ok) return undefined;
    const item = listed.value.items.find(each => each.id === id);
    if (item === undefined) return undefined;
    const open = openCardAsks(item);
    return reference === undefined ? open[0] : (open.find(ask => cardAskReference(ask) === reference) ?? undefined);
  };
  return {
    isGate: async (sessionId, id) => (await askOn(sessionId, id)) !== undefined,
    answer: async (answer: GateAnswer): Promise<GateAnswerOutcome> => {
      const ask = await askOn(answer.sessionId, answer.id, answer.cardAsk);
      if (ask === undefined) return { handled: false };
      if (answer.actor.kind !== 'human')
        return refused(
          'forbidden',
          `only the owner answers ${answer.id}'s card ask: it decides where the card goes next`,
        );
      const denied = answer.permitted?.();
      if (denied !== undefined) return refused('forbidden', denied);
      const response = answer.response;
      const choice = response.kind === 'multiple-choice' ? gateChoice(ask.gate, response.choice) : undefined;
      if (choice?.kind === 'unknown')
        return refused(
          'invalid',
          `${answer.id} has no option ${response.kind === 'multiple-choice' ? response.choice : ''}`,
        );
      const spec = source();
      if (spec === 'unavailable' || spec.apply === undefined)
        return refused('not-moved', `the board cannot move the card right now, so ${answer.id} stays open`);
      const reference = cardAskReference(ask);
      const at = now();
      const note = answer.note?.trim() ?? '';
      const receipt = createHash('sha256')
        .update(JSON.stringify([answer.sessionId, answer.id, reference, response, note]))
        .digest('hex');
      const asked: AskAnswer = {
        id: `an_${receipt.slice(0, 24)}` as AnswerId,
        ferret: answer.sessionId,
        ask: answer.id as AskId,
        source: CARD_SOURCE,
        entry: reference as EntryId,
        effect: effectOf(response),
        ...(response.kind === 'multiple-choice' ? { choice: response.choice } : {}),
        ...(note === '' ? {} : { text: note.slice(0, 2_048) }),
        by: answer.holder === undefined ? { kind: 'host' } : { kind: 'device', holder: answer.holder },
        at: at as AskAnswer['at'],
      };
      const applied = await spec.apply(asked);
      if (applied !== 'applied') return refused('not-moved', applied.refused);
      const mutation = await agenda.cardAsk(
        answer.sessionId,
        answer.id,
        choice?.kind === 'not-yet'
          ? { kind: 'not-yet', reference, ...(note === '' ? {} : { note }) }
          : {
              kind: 'answered',
              reference,
              answer: {
                at,
                response,
                ...(note === '' ? {} : { note }),
                receipt,
                ...(answer.askVersion === undefined ? {} : { askVersion: answer.askVersion }),
              },
            },
      );
      return { handled: true, mutation };
    },
  };
}
