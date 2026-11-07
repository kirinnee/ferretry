import { describe, expect, it } from 'bun:test';
import type { AskAnswer, AskSourceSpec } from '../../../contract/index.ts';
import { cardAskAnswers } from '../../../daemon/adapters/card-ask-answers.ts';
import type { CardAskOperation } from '../../../daemon/lib/agenda/card-asks.ts';
import type { AgendaService } from '../../../daemon/lib/agenda/index.ts';
import type { GateAnswer } from '../../../daemon/lib/routes/agenda-gates.ts';

const AT = '2026-11-07T10:00:00.000Z';
const GATE = {
  cardId: 'F12',
  laneId: 'to-test',
  laneName: 'To test',
  entry: 3,
  projectId: 'p1',
  options: [{ id: 'done', label: 'Done', outcome: 'next' }],
} as const;

/** One open item carrying one open card ask, and the operations the agenda was asked to record. */
function board() {
  const recorded: CardAskOperation[] = [];
  const agenda = {
    list: async () => ({
      ok: true,
      value: { items: [{ id: 'A1', cardAsks: [{ gate: GATE, at: AT }] }], resolved: [] },
    }),
    cardAsk: async (_session: string, _id: string, operation: CardAskOperation) => {
      recorded.push(operation);
      return { ok: true, changed: true };
    },
  } as unknown as Pick<AgendaService, 'list' | 'cardAsk'>;
  return { agenda, recorded };
}

function cardSource(outcome: 'applied' | { readonly refused: string }) {
  const applied: AskAnswer[] = [];
  const spec: AskSourceSpec = {
    schema: undefined as never,
    title: 'Card {card}',
    form: false,
    apply: async answer => {
      applied.push(answer);
      return outcome;
    },
  };
  return { spec, applied };
}

const answer = (choice: string, extra: Partial<GateAnswer> = {}): GateAnswer => ({
  sessionId: 'f1',
  id: 'A1',
  response: { kind: 'multiple-choice', choice },
  actor: { kind: 'human' },
  caller: { kind: 'owner' },
  holder: 'phone',
  ...extra,
});

describe('a card ask answered through the card source', () => {
  it('should move the card first, then record the answer as the one the owner gave', async () => {
    // Arrange
    const { agenda, recorded } = board();
    const source = cardSource('applied');
    const gates = cardAskAnswers(
      agenda,
      () => source.spec,
      () => AT,
    );

    // Act
    const outcome = await gates.answer(answer('Done'));

    // Assert
    expect(outcome.handled).toBe(true);
    expect(source.applied.map(each => [each.ferret, each.ask, each.source, each.effect, each.choice, each.by])).toEqual(
      [['f1', 'A1', 'card', 'choose', 'Done', { kind: 'device', holder: 'phone' }]],
    );
    expect(recorded.map(operation => operation.kind)).toEqual(['answered']);
  });

  it("should leave the ask open with the source's sentence when the card could not move", async () => {
    // Arrange
    const { agenda, recorded } = board();
    const source = cardSource({ refused: 'F12 is no longer in To test, so nothing was moved' });
    const gates = cardAskAnswers(
      agenda,
      () => source.spec,
      () => AT,
    );

    // Act
    const outcome = await gates.answer(answer('Done'));

    // Assert
    expect(outcome).toEqual({
      handled: true,
      refused: { code: 'not-moved', message: 'F12 is no longer in To test, so nothing was moved' },
    });
    expect(recorded).toEqual([]);
  });

  it('should refuse when no Board is running, and record nothing', async () => {
    // Arrange
    const { agenda, recorded } = board();
    const gates = cardAskAnswers(
      agenda,
      () => 'unavailable',
      () => AT,
    );

    // Act
    const outcome = await gates.answer(answer('Done'));

    // Assert
    expect('refused' in outcome && outcome.refused.code).toBe('not-moved');
    expect(recorded).toEqual([]);
  });

  it('should record Not yet as Not yet once the source applied it', async () => {
    // Arrange
    const { agenda, recorded } = board();
    const source = cardSource('applied');
    const gates = cardAskAnswers(
      agenda,
      () => source.spec,
      () => AT,
    );

    // Act
    await gates.answer(answer('Not yet', { note: 'the badge is still blue' }));

    // Assert
    expect(recorded).toEqual([{ kind: 'not-yet', reference: expect.any(String), note: 'the badge is still blue' }]);
  });

  it('should refuse a ferret, and an option the gate does not offer, before the card is touched', async () => {
    // Arrange
    const { agenda } = board();
    const source = cardSource('applied');
    const gates = cardAskAnswers(
      agenda,
      () => source.spec,
      () => AT,
    );

    // Act
    const byFerret = await gates.answer(answer('Done', { actor: { kind: 'agent', sessionId: 'f1', name: null } }));
    const unknown = await gates.answer(answer('Ship it'));

    // Assert
    expect('refused' in byFerret && byFerret.refused.code).toBe('forbidden');
    expect('refused' in unknown && unknown.refused.code).toBe('invalid');
    expect(source.applied).toEqual([]);
  });
});
