import { describe, it } from 'bun:test';
import should from 'should';
import {
  MAX_TASK_TITLE_WORDS,
  TASK_TITLE_GUIDANCE,
  taskTitleIssue,
  taskTitleWordCount,
} from '../../../src/lib/tasks/task-title.ts';

describe('taskTitleWordCount', () => {
  it.each([
    { input: '', expected: 0 },
    { input: ' \t\n ', expected: 0 },
    { input: 'Build', expected: 1 },
    { input: '  Build   task DAG filters  ', expected: 4 },
    { input: 'Add phone-first pan and zoom', expected: 5 },
  ])('should count "$input" as $expected whitespace-delimited words', ({ input, expected }) => {
    // Act
    const actual = taskTitleWordCount(input);

    // Assert
    should(actual).equal(expected);
  });
});

describe('taskTitleIssue', () => {
  it.each(['Build', 'Build the task DAG filters'])('should accept a short title: "%s"', input => {
    // Act
    const actual = taskTitleIssue(input);

    // Assert
    should(actual).be.null();
  });

  it('should direct excess detail into the description', () => {
    // Arrange
    const input = 'Build the task DAG filters for phones';

    // Act
    const actual = taskTitleIssue(input);

    // Assert
    should(MAX_TASK_TITLE_WORDS).equal(5);
    should(actual).equal(`task title has 7 words; ${TASK_TITLE_GUIDANCE}`);
    should(actual).containEql('description');
  });
});
