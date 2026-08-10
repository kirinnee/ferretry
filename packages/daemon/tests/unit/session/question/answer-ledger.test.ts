import { describe, it } from 'bun:test';
import type { SessionState } from '@ferretry/protocol';
import should from 'should';
import {
  AnswerAcknowledged,
  type AnswerOperationRecord,
  AnswerReleased,
  AnswerRequestConflict,
  type AnswerRequestPayload,
  AnswerTerminalFailure,
  AnswerToolAlreadyHandled,
  AnswerUnconfirmed,
  answerEvidenceForQuestion,
  answerFingerprint,
  decideAnswerAdmission,
  reconcileAnswerEvidence,
  reconcileUnconfirmedAnswer,
} from '../../../../src/lib/session/question/answer-ledger.ts';

const record = (patch: Partial<AnswerOperationRecord> = {}): AnswerOperationRecord => ({
  requestId: 'request-1',
  toolUseId: 'tool-1',
  fingerprint: 'print-1',
  acceptedAt: '2026-08-06T00:00:00.000Z',
  outcome: 'accepted',
  ...patch,
});

const state = (patch: Partial<SessionState> = {}): SessionState =>
  ({ status: 'running', turn: 1, ...patch }) as SessionState;

describe('the answer fingerprint', () => {
  it('is identical for the same answer submitted twice', () => {
    // Arrange
    const input: AnswerRequestPayload = {
      toolUseId: 'tool-1',
      labels: ['Yes'],
      answers: [{ kind: 'selection', labels: ['Yes'] }],
    };

    // Act
    const actual = answerFingerprint({ ...input, labels: [...input.labels] });

    // Assert
    should(actual).equal(answerFingerprint(input));
  });

  it.each([
    ['a different tool id', { toolUseId: 'tool-2' }],
    ['a different label', { labels: ['No'] }],
    ['a free-form answer instead of none', { other: 'because' }],
    ['a different response list', { responses: ['No'] }],
    ['a different lossless answer', { answers: [{ kind: 'other' as const, text: 'because' }] }],
    ['a reordered multi-select', { answers: [{ kind: 'selection' as const, labels: ['API', 'Web'] }] }],
  ])('changes when the answer changes (%s)', (_name, patch) => {
    // Arrange
    const input: AnswerRequestPayload = {
      toolUseId: 'tool-1',
      labels: ['Yes'],
      answers: [{ kind: 'selection', labels: ['Web', 'API'] }],
    };
    const expected = answerFingerprint(input);

    // Act
    const actual = answerFingerprint({ ...input, ...patch });

    // Assert
    should(actual).not.equal(expected);
  });

  it('distinguishes an absent field from an empty one, so neither can impersonate the other', () => {
    // Arrange
    const input: AnswerRequestPayload = { toolUseId: 'tool-1', labels: [] };

    // Act
    const withEmptyResponses = answerFingerprint({ ...input, responses: [] });
    const withEmptyOther = answerFingerprint({ ...input, other: '' });

    // Assert
    should(withEmptyResponses).not.equal(answerFingerprint(input));
    should(withEmptyOther).not.equal(answerFingerprint(input));
  });
});

describe('answer admission', () => {
  it('admits a request no receipt has ever been written for', () => {
    // Act
    const actual = decideAnswerAdmission({ existing: undefined, fingerprint: 'print-1' });

    // Assert
    should(actual).deepEqual({ kind: 'admit' });
  });

  it('re-admits a request whose earlier attempt provably sent no key', () => {
    // Act
    const actual = decideAnswerAdmission({ existing: record({ outcome: 'withdrawn' }), fingerprint: 'print-1' });

    // Assert
    should(actual).deepEqual({ kind: 'admit' });
  });

  it('replays a settled receipt rather than driving the form again', () => {
    // Act
    const actual = decideAnswerAdmission({ existing: record({ outcome: 'confirmed' }), fingerprint: 'print-1' });

    // Assert
    should(actual).deepEqual({ kind: 'replay' });
  });

  it.each([['accepted'], ['confirmed'], ['withdrawn'], ['failed'], ['quarantined'], ['acknowledged']] as const)(
    'refuses a reused id carrying a different answer, whatever the earlier outcome was (%s)',
    outcome => {
      // Act
      const actual = decideAnswerAdmission({ existing: record({ outcome }), fingerprint: 'print-2' });

      // Assert
      should(actual).deepEqual({ kind: 'conflict' });
    },
  );

  it('sends an admitted-but-unsettled receipt to reconciliation, carrying the record', () => {
    // Arrange
    const existing = record();

    // Act
    const actual = decideAnswerAdmission({ existing, fingerprint: 'print-1' });

    // Assert
    should(actual).deepEqual({ kind: 'reconcile', record: existing });
  });

  it.each([
    ['failed', 'failed'],
    ['quarantined', 'quarantined'],
    ['acknowledged', 'acknowledged'],
  ] as const)('repeats the terminal %s result without admitting another drive', (outcome, kind) => {
    const existing = record({ outcome });

    const actual = decideAnswerAdmission({ existing, fingerprint: 'print-1' });

    should(actual).deepEqual({ kind, record: existing });
  });
});

describe('tool-level answer evidence', () => {
  it('ignores withdrawn rows and distinguishes every settled outcome', () => {
    should(answerEvidenceForQuestion([record({ outcome: 'withdrawn' })], 'tool-1')).deepEqual({ kind: 'none' });
    should(answerEvidenceForQuestion([record({ outcome: 'confirmed' })], 'tool-1')).match({ kind: 'confirmed' });
    should(answerEvidenceForQuestion([record({ outcome: 'failed' })], 'tool-1')).match({ kind: 'released' });
    should(answerEvidenceForQuestion([record({ outcome: 'quarantined' })], 'tool-1')).match({
      kind: 'quarantined',
    });
    should(answerEvidenceForQuestion([record({ outcome: 'acknowledged' })], 'tool-1')).match({
      kind: 'acknowledged',
    });
    should(answerEvidenceForQuestion([record()], 'another-tool')).deepEqual({ kind: 'none' });
  });

  it('fails closed to an unresolved accepted row when duplicate request ids disagree', () => {
    const evidence = answerEvidenceForQuestion(
      [
        record({ requestId: 'confirmed', outcome: 'confirmed' }),
        record({ requestId: 'released', outcome: 'quarantined' }),
        record({ requestId: 'accepted', outcome: 'accepted' }),
      ],
      'tool-1',
    );

    should(evidence).match({ kind: 'unconfirmed', record: { requestId: 'accepted' } });
  });

  it('prefers a quarantine over a settled row when no accepted ambiguity remains', () => {
    const evidence = answerEvidenceForQuestion(
      [
        record({ requestId: 'confirmed', outcome: 'confirmed' }),
        record({ requestId: 'released', outcome: 'quarantined' }),
      ],
      'tool-1',
    );

    should(evidence).match({ kind: 'quarantined', record: { requestId: 'released' } });
  });

  it('prefers human acknowledgement over every append-only predecessor for the same tool', () => {
    const evidence = answerEvidenceForQuestion(
      [
        record({ requestId: 'accepted', outcome: 'accepted' }),
        record({ requestId: 'quarantined', outcome: 'quarantined' }),
        record({ requestId: 'acknowledged', outcome: 'acknowledged' }),
      ],
      'tool-1',
    );

    should(evidence).match({ kind: 'acknowledged', record: { requestId: 'acknowledged' } });
  });
});

describe('monitor reconciliation of accepted receipts', () => {
  it('settles exactly the accepted rows the state stamp proves and leaves ambiguity untouched', () => {
    const records = new Map([
      ['proved', record({ requestId: 'proved', toolUseId: 'tool-1' })],
      ['ambiguous', record({ requestId: 'ambiguous', toolUseId: 'tool-2' })],
      ['settled', record({ requestId: 'settled', toolUseId: 'tool-1', outcome: 'confirmed' })],
    ]);

    const actual = reconcileAnswerEvidence(records, state({ lastAnsweredQuestionToolUseId: 'tool-1' }));

    should(actual.settlements.map(settlement => settlement.requestId)).deepEqual(['proved']);
    should(actual.records.get('proved')).match({ outcome: 'confirmed' });
    should(actual.records.get('ambiguous')).match({ outcome: 'accepted' });
    should(actual.records.get('settled')).match({ outcome: 'confirmed' });
  });

  it.each([
    ['the exact tool resolved', { resolvedToolUseId: 'tool-1' }],
    ['a newer tool became active', { activeToolUseId: 'tool-2' }],
  ] as const)(
    'quarantines an unstamped accepted row when monitor evidence shows it advanced (%s)',
    (_name, observation) => {
      const records = new Map([['request-1', record()]]);

      const actual = reconcileAnswerEvidence(records, state(), observation);

      should(actual.settlements).match([
        { requestId: 'request-1', outcome: 'quarantined', reason: /advanced without proving/u },
      ]);
      should(actual.records.get('request-1')).match({ outcome: 'quarantined' });
    },
  );

  it('does not settle the accepted row while its exact tool is still the active form', () => {
    const actual = reconcileAnswerEvidence(new Map([['request-1', record()]]), state(), { activeToolUseId: 'tool-1' });

    should(actual.settlements).be.empty();
    should(actual.records.get('request-1')).match({ outcome: 'accepted' });
  });

  it('never promotes quarantined or acknowledged rows from a later answer stamp', () => {
    const records = new Map([
      ['quarantined', record({ requestId: 'quarantined', outcome: 'quarantined' })],
      ['acknowledged', record({ requestId: 'acknowledged', outcome: 'acknowledged' })],
    ]);

    const actual = reconcileAnswerEvidence(records, state({ lastAnsweredQuestionToolUseId: 'tool-1' }));

    should(actual.settlements).be.empty();
    should(actual.records.get('quarantined')).match({ outcome: 'quarantined' });
    should(actual.records.get('acknowledged')).match({ outcome: 'acknowledged' });
  });

  it('does not mutate the caller map while deriving repaired evidence', () => {
    const records = new Map([['request-1', record()]]);

    reconcileAnswerEvidence(records, state({ lastAnsweredQuestionToolUseId: 'tool-1' }));

    should(records.get('request-1')).match({ outcome: 'accepted' });
  });
});

describe('reconciling an unconfirmed answer', () => {
  it('confirms it when the state document already stamped this exact form', () => {
    // Act
    const actual = reconcileUnconfirmedAnswer({
      record: record(),
      state: state({ lastAnsweredQuestionToolUseId: 'tool-1' }),
    });

    // Assert
    should(actual).equal('confirmed');
  });

  it.each([
    ['nothing was stamped', state()],
    ['another form was stamped', state({ lastAnsweredQuestionToolUseId: 'tool-2' })],
    [
      'the same form is still open',
      state({ pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'q' }] } }),
    ],
  ])('quarantines rather than guessing when the answer is not proved (%s)', (_name, current) => {
    // Act
    const actual = reconcileUnconfirmedAnswer({ record: record(), state: current });

    // Assert
    should(actual).equal('quarantine');
  });

  it('quarantines when the state document could not be read at all', () => {
    // Act
    const actual = reconcileUnconfirmedAnswer({ record: record(), state: undefined });

    // Assert
    should(actual).equal('quarantine');
  });
});

describe('the answer refusals', () => {
  it('name the request id and say what a caller must do instead', () => {
    // Act
    const conflict = new AnswerRequestConflict('request-1');
    const unconfirmed = new AnswerUnconfirmed('request-1', 'tool-1');
    const terminal = new AnswerTerminalFailure(record({ outcome: 'failed', reason: 'reply in prose' }));
    const released = new AnswerReleased(record({ outcome: 'quarantined', reason: 'inspect the terminal' }));
    const acknowledged = new AnswerAcknowledged(record({ outcome: 'acknowledged' }));
    const handled = new AnswerToolAlreadyHandled('tool-1', 'request-1', 'confirmed');

    // Assert
    should(conflict.name).equal('AnswerRequestConflict');
    should(conflict.message).match(/"request-1"/u);
    should(unconfirmed.name).equal('AnswerUnconfirmed');
    should(unconfirmed.message).match(/"tool-1"/u);
    should(unconfirmed.message).match(/will not be sent again/u);
    should(terminal.message).equal('reply in prose');
    should(released.message).equal('inspect the terminal');
    should(acknowledged.message).match(/does not confirm/u);
    should(handled.message).match(/already owned/u);
  });

  it('retains the reconciliation reason as an Error cause when one exists', () => {
    const unconfirmed = new AnswerUnconfirmed('request-1', 'tool-1', 'the state file was unreadable');

    should(unconfirmed.cause).match({ message: 'the state file was unreadable' });
    should(new AnswerTerminalFailure(record({ outcome: 'failed', reason: undefined })).message).match(/released/u);
    should(new AnswerReleased(record({ outcome: 'quarantined', reason: undefined })).message).match(
      /prose may continue/u,
    );
  });
});
