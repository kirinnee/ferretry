import { describe, it } from 'bun:test';
import type { SessionState } from '@ferretry/protocol';
import should from 'should';
import {
  type AnswerOperationRecord,
  AnswerRequestConflict,
  type AnswerRequestPayload,
  AnswerUnconfirmed,
  answerFingerprint,
  decideAnswerAdmission,
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

  it.each([['accepted'], ['confirmed'], ['withdrawn']] as const)(
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

    // Assert
    should(conflict.name).equal('AnswerRequestConflict');
    should(conflict.message).match(/"request-1"/u);
    should(unconfirmed.name).equal('AnswerUnconfirmed');
    should(unconfirmed.message).match(/"tool-1"/u);
    should(unconfirmed.message).match(/will not be sent again/u);
  });
});
