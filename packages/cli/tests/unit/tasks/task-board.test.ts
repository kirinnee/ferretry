import { describe, it } from 'bun:test';
import type { TaskPhase } from '@ferretry/protocol';
import should from 'should';
import {
  TASK_BOARD_LANE_ORDER,
  TASK_LANE_LABEL,
  TASK_STALENESS_COPY,
  TASK_STATUS_LABEL,
  taskBoardLaneFromPhase,
} from '../../../src/lib/tasks/task-board';
import { taskTitleIssue } from '../../../src/lib/tasks/task-title';

describe('board vocabulary', () => {
  it('should collapse the three audit phases onto one lane', () => {
    // Act + Assert
    for (const phase of ['research', 'design', 'build'] satisfies TaskPhase[]) {
      should(taskBoardLaneFromPhase(phase)).equal('in_progress');
    }
  });

  it('should leave every other phase as its own lane', () => {
    // Act + Assert
    for (const phase of ['todo', 'built', 'live', 'done', 'dropped'] satisfies TaskPhase[]) {
      should(taskBoardLaneFromPhase(phase)).equal(phase);
    }
  });

  it('should label every lane it can order', () => {
    // Act + Assert
    for (const lane of TASK_BOARD_LANE_ORDER) {
      should(TASK_LANE_LABEL[lane]).be.a.String().and.not.be.empty();
    }
    should(TASK_BOARD_LANE_ORDER).have.length(6);
  });

  it('should spell out the blocked status, which has no lane of its own', () => {
    // Act + Assert
    should(TASK_STATUS_LABEL.blocked).containEql('BLOCKED');
    should(TASK_STATUS_LABEL.researched).containEql('RESEARCHED');
  });

  it('should describe each staleness flag as an action, not a status', () => {
    // Act + Assert
    should(TASK_STALENESS_COPY['assignee-dead']).containEql('verify');
    should(TASK_STALENESS_COPY['maybe-finished']).containEql('verify');
    should(TASK_STALENESS_COPY.quiet).containEql('check');
  });
});

describe('task titles', () => {
  it('should accept a title of five words or fewer', () => {
    // Act + Assert
    should(taskTitleIssue('Rename the widget')).be.null();
    should(taskTitleIssue('  one two three four five  ')).be.null();
  });

  it('should refuse a longer title and say how long it was', () => {
    // Act
    const actual = taskTitleIssue('one two three four five six');

    // Assert
    should(actual).be.a.String().and.containEql('has 6 words');
  });

  it('should treat an empty title as having no words rather than one', () => {
    // Act + Assert — an empty title is refused elsewhere; here it must not report "1 word".
    should(taskTitleIssue('   ')).be.null();
  });
});
