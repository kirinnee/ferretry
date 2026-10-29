import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import {
  bindReviewPage,
  questionScreen,
  type RenderedQuestion,
} from '../../../../src/lib/session/question/rendered-form.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures/question-forms');

const colour: RenderedQuestion = {
  question: 'Which colour should the banner use?',
  options: [{ label: 'Red' }, { label: 'Blue' }],
};
const extras: RenderedQuestion = {
  question: 'Which extras should ship with the banner?',
  options: [{ label: 'Shadow' }, { label: 'Border' }, { label: 'Icon' }],
  multiSelect: true,
};

describe('the closing review page, when an answer wraps', () => {
  it('should join the continuation of a wrapped answer back into the one answer it belongs to', () => {
    // Arrange: a narrow pane wraps `→ Shadow, Icon` onto a second line under the arrow.
    const wrapped = readFileSync(join(FIXTURES, 'claude-2.1.281-review.txt'), 'utf8').replace(
      '   → Shadow, Icon',
      '   → Shadow,\n     Icon',
    );

    // Act
    const page = bindReviewPage(questionScreen(wrapped, wrapped), [colour, extras]);

    // Assert
    should(page?.shown).deepEqual(['Blue', 'Shadow, Icon']);
  });
});
