import { describe, it } from 'bun:test';
import should from 'should';
import {
  ATTENTION_CONFIRMS_ANSWERS,
  AttentionActionRequestSchema,
  AttentionConfirmsSchema,
  AttentionItemSchema,
  attentionConfirmsProblems,
} from '../../src/lib/attention.ts';

const ADD = {
  action: 'add',
  title: 'Jev price correction',
  subject: 'Allow the Jev price correction?',
  why: 'the cap counts with a price 50 times too high',
  howToResolve: 'Allow, Deny or Discard change',
  confirms: 'warden.yaml',
} as const;

const CONFIRMS = {
  path: 'warden.yaml',
  etag: 'a'.repeat(64),
  changes: ['the Jev price the cap counts with goes down from 2 to 0.042'],
};

describe('a confirmation on the agenda', () => {
  it('should name its answers by the labels the card offers', () => {
    // Arrange / Act / Assert
    should(Object.values(ATTENTION_CONFIRMS_ANSWERS)).deepEqual(['Allow', 'Deny', 'Discard change']);
  });

  it('should carry the file, the held edit’s digest and at least one change, and may be restated', () => {
    // Arrange / Act / Assert
    should(AttentionConfirmsSchema.safeParse(CONFIRMS).success).be.true();
    should(AttentionConfirmsSchema.safeParse({ ...CONFIRMS, restated: true }).success).be.true();
    should(AttentionConfirmsSchema.safeParse({ ...CONFIRMS, changes: [] }).success).be.false();
    should(AttentionConfirmsSchema.safeParse({ ...CONFIRMS, restated: false }).success).be.false();
    should(AttentionConfirmsSchema.safeParse({ ...CONFIRMS, extra: 1 }).success).be.false();
  });

  it('should ride on an item', () => {
    // Arrange
    const item = {
      id: 'A1',
      source: 'agent-raised',
      sourceRef: null,
      subject: ADD.subject,
      why: ADD.why,
      waitingSince: '2026-10-30T09:00:00.000Z',
      howToResolve: ADD.howToResolve,
      raisedBy: 'agent',
      raisedBySession: 's1',
      raisedByName: null,
      confirms: CONFIRMS,
    };

    // Act
    const parsed = AttentionItemSchema.safeParse(item);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data?.confirms).deepEqual(CONFIRMS);
  });

  it('should accept an add naming the file alone', () => {
    // Arrange / Act
    const parsed = AttentionActionRequestSchema.safeParse(ADD);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data).containDeep({ action: 'add', confirms: 'warden.yaml' });
  });

  it('should refuse an add that confirms and also sets the card’s own ask, answers, kind, questions or notice', () => {
    // Arrange
    const clashing = {
      ...ADD,
      notice: true,
      ask: { kind: 'permission' },
      answers: [{ direction: 'right', label: 'Approve', does: 'approve' }],
      kind: 'permission',
      questions: [{ question: 'apply it?' }],
    };

    // Act
    const parsed = AttentionActionRequestSchema.safeParse(clashing);

    // Assert
    should(parsed.success).be.false();
    should(parsed.error?.issues.map(issue => issue.message)).containDeep([
      'a confirmation is answered, so it is not a notice',
      'a confirmation has no ask of its own: its answers are Allow, Deny and Discard change',
      'a confirmation has no answers of its own: they are Allow, Deny and Discard change',
      'a confirmation has no kind of its own: it is a choice',
      'a confirmation asks one thing, whether to apply the change: no questions',
    ]);
  });

  it('should find nothing wrong with an add that confirms nothing', () => {
    // Arrange / Act / Assert
    should(attentionConfirmsProblems({ kind: 'choice', ask: {} })).be.empty();
  });
});
