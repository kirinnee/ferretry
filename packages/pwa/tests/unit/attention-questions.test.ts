import { describe, expect, test } from 'bun:test';
import { MAX_ATTENTION_DETAIL_LENGTH } from '@ferretry/protocol';
import {
  answersPerQuestion,
  composeQuestionAnswers,
  DISMISS_ACTION,
  DONE_ACTION,
  hasAttentionBrief,
  hasSeveralQuestions,
  questionAnswersAction,
  swipeMap,
  visibleWhy,
} from '../../src/lib/attention-inbox.ts';

const two = [{ question: 'Which database?' }, { question: 'Ship when?' }];

describe('composeQuestionAnswers', () => {
  test('numbers each question, with its answer under an arrow', () => {
    expect(composeQuestionAnswers(two, ['SQLite', 'Friday'])).toBe(
      '1. Which database?\n→ SQLite\n\n2. Ship when?\n→ Friday',
    );
  });

  test('writes an unanswered question as (no answer)', () => {
    expect(composeQuestionAnswers(two, ['SQLite', '   '])).toBe(
      '1. Which database?\n→ SQLite\n\n2. Ship when?\n→ (no answer)',
    );
  });

  test('has nothing to send when nothing is answered', () => {
    expect(composeQuestionAnswers(two, [])).toBeNull();
  });

  test('cuts the questions, never the answers, to fit', () => {
    const long = [{ question: 'q'.repeat(3000) }, { question: 'r'.repeat(3000) }];
    const text = composeQuestionAnswers(long, ['keep this whole', 'and this']);
    expect(text).not.toBeNull();
    expect(text?.length).toBeLessThanOrEqual(MAX_ATTENTION_DETAIL_LENGTH);
    expect(text).toContain('→ keep this whole');
    expect(text).toContain('→ and this');
  });

  test('refuses when the answers alone do not fit', () => {
    expect(composeQuestionAnswers(two, ['a'.repeat(MAX_ATTENTION_DETAIL_LENGTH), 'b'])).toBeNull();
  });

  test('becomes one open-question response', () => {
    expect(questionAnswersAction(two, ['SQLite', 'Friday'])).toEqual({
      kind: 'respond',
      label: 'Reply',
      response: { kind: 'open-question', answer: '1. Which database?\n→ SQLite\n\n2. Ship when?\n→ Friday' },
    });
    expect(questionAnswersAction(two, [])).toBeNull();
  });
});

describe('structured-item rules', () => {
  test('hides why when it only repeats the summary', () => {
    expect(visibleWhy({ subject: 'Pick one', why: '  Pick one ' })).toBeNull();
    expect(visibleWhy({ subject: 'Pick one', why: 'Because it blocks the build.' })).toBe(
      'Because it blocks the build.',
    );
  });

  test('knows a rich item from an old one', () => {
    expect(hasAttentionBrief({})).toBe(false);
    expect(hasAttentionBrief({ impact: 'it stalls' })).toBe(true);
  });

  test('answers per question only for several questions with an open-question ask', () => {
    const questions = [{ question: 'a' }, { question: 'b' }];
    expect(hasSeveralQuestions({ questions })).toBe(true);
    expect(answersPerQuestion({ questions, ask: { kind: 'open-question' } })).toBe(true);
    expect(answersPerQuestion({ questions, ask: { kind: 'permission' } })).toBe(false);
    expect(answersPerQuestion({ questions: [{ question: 'a' }], ask: { kind: 'open-question' } })).toBe(false);
  });

  test('swipes Done/Dismiss only on a multi-question item, and the options on a single-question one', () => {
    const ask = { kind: 'multiple-choice' as const, options: [{ label: 'One' }, { label: 'Two' }] };
    expect(swipeMap({ ask, questions: [{ question: 'a' }, { question: 'b' }] })).toEqual({
      right: DONE_ACTION,
      left: DISMISS_ACTION,
    });
    const single = swipeMap({ ask, questions: [{ question: 'a' }] });
    expect(single.right?.label).toBe('One');
    expect(single.left?.label).toBe('Two');
  });
});
