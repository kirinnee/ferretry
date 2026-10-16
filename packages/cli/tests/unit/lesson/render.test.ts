import { describe, it } from 'bun:test';
import should from 'should';
import { renderLessonSuggestion } from '../../../src/lib/lesson/render';

describe('renderLessonSuggestion', () => {
  it('should print the daemon’s own sentence verbatim, whichever outcome it names', () => {
    should(renderLessonSuggestion({ summary: 'filed as a new lesson', outcome: 'filed' })).equal(
      'filed as a new lesson',
    );
    should(
      renderLessonSuggestion({ summary: 'merged into an existing lesson (now 9×)', outcome: 'merged', count: 9 }),
    ).equal('merged into an existing lesson (now 9×)');
    should(
      renderLessonSuggestion({ summary: 'previously rejected; not filed again', outcome: 'previously-rejected' }),
    ).equal('previously rejected; not filed again');
  });
});
