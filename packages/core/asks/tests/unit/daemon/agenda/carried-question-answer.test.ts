import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaReplyDelivery } from '../../../../daemon/lib/agenda/observers.ts';
import type { AgendaReplyQueue } from '../../../../daemon/lib/agenda/reply-batch.ts';
import type { AgendaBoardChange } from '../../../../daemon/lib/agenda/service.ts';
import {
  type AgendaActor,
  type AgendaMutation,
  applyAgendaCommandToSession,
  type RaiseAgendaRequest,
} from '../../../../daemon/lib/agenda/state-machine.ts';
import { AgendaSnapshotSchema } from '../../../../daemon/lib/protocol/agenda.ts';

/**
 * A ferret's question form that a v4 home carried into 5.0: the daemon's own `question` item, `question:<tool id>`,
 * answered by a pick. The owner's answer is DONE only when the ferret has it (docs/agenda.md § Delivery), so it must
 * rest and be told to the ferret — never close as done with nobody told.
 */
const SESSION = 'session-1';
const FIRST = '2026-11-14T10:00:00Z';
const SECOND = '2026-11-14T10:05:00Z';
const THIRD = '2026-11-14T10:10:00Z';
const HUMAN: AgendaActor = { kind: 'human' };
const DAEMON: AgendaActor = { kind: 'daemon', cause: 'harness-prompt' };
const DAEMON_OTHER: AgendaActor = { kind: 'daemon', cause: 'source-reconciliation' };

const OPTIONS = [{ label: 'Patch the parser' }, { label: 'Rewrite the test' }];

const question = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'question',
  sourceRef: 'question:toolu_01',
  title: 'Question from the ferret',
  subject: 'Which fix should I apply?',
  why: 'The ferret stopped at a question form and cannot go on until it is answered.',
  context: '- The ferret is waiting on its own question form.',
  premise: 'The ferret asked a question.',
  howToResolve: 'Answer here and the form is filled in for you.',
  kind: 'choice',
  ask: { kind: 'multiple-choice', options: OPTIONS },
  ...overrides,
});

const succeeded = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  should(result.ok).be.true();
  if (!result.ok) throw new Error(result.error.message);
  return result;
};

const raise = (actor: AgendaActor, overrides: Partial<RaiseAgendaRequest> = {}) =>
  succeeded(
    applyAgendaCommandToSession(null, SESSION, { action: 'raise', actor, request: question(overrides), at: FIRST }),
  );

const pick = (ledger: AgendaMutation extends infer M ? (M extends { ledger: infer L } ? L : never) : never) =>
  succeeded(
    applyAgendaCommandToSession(ledger, SESSION, {
      action: 'answer',
      actor: HUMAN,
      id: 'A1',
      response: { kind: 'multiple-choice', choice: 'Patch the parser' },
      at: SECOND,
    }),
  );

describe('the answer to a carried v4 question form', () => {
  it('should rest the item waiting on its ferret, not close it as done', () => {
    // Arrange
    const { ledger } = raise(DAEMON);

    // Act
    const answered = pick(ledger);

    // Assert
    should(answered.change).equal('answered');
    should(answered.addressed).be.undefined();
    should(answered.item?.ownerAnswer?.response).deepEqual({ kind: 'multiple-choice', choice: 'Patch the parser' });
    should(answered.item?.resting?.sub).equal('waiting-on-ferret');
  });

  it('should reopen it with the answer kept when the ferret never got it', () => {
    // Arrange
    const answered = pick(raise(DAEMON).ledger);
    const request = answered.item?.ownerAnswer?.request;

    // Act
    const lost = succeeded(
      applyAgendaCommandToSession(answered.ledger, SESSION, {
        action: 'undelivered',
        actor: { kind: 'daemon', cause: 'system' },
        id: 'A1',
        reason: 'the ferret was stopped',
        request,
        at: THIRD,
      }),
    );

    // Assert
    should(lost.change).equal('reopened');
    should(lost.item?.undelivered?.reason).equal('the ferret was stopped');
    should(lost.item?.undelivered?.reply.action).equal('resolve');
  });

  it('should still close an item the daemon raised for a source it acts on itself', () => {
    // Arrange: another daemon producer's `question` item, and a 5.0 obligation
    const others = [
      raise(DAEMON_OTHER, { sourceRef: 'source-1' }),
      raise(DAEMON_OTHER, { sourceRef: 'ask:question:ferret:toolu_01' }),
    ];

    // Act
    const answers = others.map(({ ledger }) => pick(ledger));

    // Assert
    should(answers.map(answer => answer.addressed?.disposition)).deepEqual(['done', 'done']);
  });
});

describe('telling the ferret a carried question form was answered', () => {
  const snapshot = AgendaSnapshotSchema.parse({
    v: 1,
    sessionId: SESSION,
    items: [],
    resolved: [],
    count: 0,
    parseErrors: 0,
    updatedAt: FIRST,
  });

  it('should queue the answer for delivery to the ferret whose board holds the item', async () => {
    // Arrange
    const added: [string, string, string][] = [];
    const queue: AgendaReplyQueue = {
      add: async (sessionId, key, message) => {
        added.push([sessionId, key, message]);
      },
    };
    const answered = pick(raise(DAEMON).ledger);
    const change: AgendaBoardChange = {
      change: 'answered',
      actor: HUMAN,
      via: 'board',
      snapshot,
      ...(answered.item === undefined ? {} : { item: answered.item }),
    };

    // Act
    await new AgendaReplyDelivery(queue, 'fy').changed(SESSION, change);

    // Assert
    should(added).have.length(1);
    should(added[0]?.[0]).equal(SESSION);
    should(added[0]?.[1]).equal('A1~1');
    should(added[0]?.[2]).containEql('Patch the parser');
  });
});
