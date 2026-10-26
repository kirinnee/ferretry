import { describe, it } from 'bun:test';
import should from 'should';
import { answerPaused, isQuestionScopedRequestId } from '../../../../src/lib/session/question/answer-wording.ts';

describe('answer wording', () => {
  it('recognises the one-id-per-question shape an app built before answer digests mints', () => {
    should(isQuestionScopedRequestId('question:daemon-a:session-1:toolu_01')).be.true();
  });

  it.each([
    ['the current one-id-per-answer shape', 'question:daemon-a:session-1:toolu_01:0123456789abcdef0123456789abcdef'],
    ['a CLI or API caller id', 'answer-1'],
    ['a different prefix', 'answer:daemon-a:session-1:toolu_01'],
  ])('does not mistake %s for a stale app', (_name, requestId) => {
    should(isQuestionScopedRequestId(requestId)).be.false();
  });
});

describe('paused answer wording', () => {
  it('names the question a drive stopped at and how many are answered', () => {
    should(answerPaused({ stoppedAt: 2, answered: [true, true, false, false] })).equal(
      'Stopped at question 3 of 4 (2 of 4 answered). Nothing was sent yet and the form is still open: resume to answer the rest, or finish it in the Console tab.',
    );
  });
});
