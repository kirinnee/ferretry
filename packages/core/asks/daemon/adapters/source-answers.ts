import { createHash } from 'node:crypto';
import { ApiError } from '@ferretry/kernel/contract';
import {
  BUILT_IN_SOURCES,
  type AnswerId,
  type AskId,
  type AskSourceSpec,
  type SourceKey,
} from '../../contract/index.ts';
import type { AgendaService } from '../lib/agenda/index.ts';
import type { SourceAnswer } from '../lib/routes/agenda-gates.ts';
import { answerOf, parseObligation } from './asks-port.ts';

/** Source obligations apply before recording; the receipt survives retries and is the published answer's id. */
export function sourceAnswers(
  agenda: Pick<AgendaService, 'list' | 'answerAfter'>,
  sources: (source: SourceKey) => AskSourceSpec | 'unavailable',
  now: () => string,
) {
  return async (answer: SourceAnswer) => {
    if (answer.cardAsk !== undefined || answer.gate === true) return undefined;
    const listed = await agenda.list(answer.sessionId);
    if (!listed.ok) return undefined;
    const item = [...listed.value.items, ...listed.value.resolved].find(each => each.id === answer.id);
    if (item === undefined) return undefined;
    const obligation = parseObligation(item.sourceRef);
    if (obligation === undefined || (BUILT_IN_SOURCES as readonly string[]).includes(obligation.source))
      return undefined;
    if (answer.actor.kind !== 'human') throw new ApiError(403, 'only the owner answers this question', 'forbidden');
    const denied = answer.permitted?.();
    if (denied !== undefined) throw new ApiError(403, denied, 'forbidden');
    const receipt = createHash('sha256')
      .update(
        JSON.stringify([
          answer.sessionId,
          answer.id,
          obligation,
          answer.response,
          answer.note ?? '',
          answer.askVersion ?? 1,
        ]),
      )
      .digest('hex');
    const at = now();
    const envelope = answerOf(answer.sessionId, {
      ...item,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolvedAt: at,
      disposition: 'done',
      resolutionNote: answer.note ?? null,
      ...(answer.response === undefined ? {} : { response: answer.response }),
      answerReceipt: receipt,
    });
    if (envelope === undefined) throw new Error('source answer has no obligation');
    const spec = sources(obligation.source);
    return agenda.answerAfter(
      answer.sessionId,
      answer.id,
      answer.response,
      answer.actor,
      answer.note ?? undefined,
      receipt,
      answer.askVersion,
      async () => {
        if (spec === 'unavailable')
          throw new ApiError(409, 'the source is unavailable, so this question stays open', 'source_unavailable');
        if (spec.apply === undefined) return;
        const applied = await spec.apply({
          ...envelope,
          id: `an_${receipt.slice(0, 24)}` as AnswerId,
          ask: answer.id as AskId,
          by: answer.holder === undefined ? { kind: 'host' } : { kind: 'device', holder: answer.holder },
        });
        if (applied !== 'applied') throw new ApiError(409, applied.refused, 'source_refused');
      },
    );
  };
}
