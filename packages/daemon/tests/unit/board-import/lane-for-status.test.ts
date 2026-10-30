import { describe, it } from 'bun:test';
import { LANE_TEMPLATES, type LaneSet, type LaneTemplateName, type TaskStatus } from '@ferretry/protocol';
import should from 'should';
import { laneForStatus, statusOfPhase } from '../../../src/lib/board-import/index.ts';
import { lanes } from '../board/support.ts';

type Status = Exclude<TaskStatus, 'blocked'>;

const laneOf = (
  template: LaneTemplateName,
  status: Status,
  hasPullRequest = false,
  workflow: 'quick' | 'design-first' = 'design-first',
) => laneForStatus(lanes(undefined, template), { status, workflow, hasPullRequest }).id;

describe('laneForStatus', () => {
  const rows: readonly (readonly [Status, boolean, string])[] = [
    ['todo', false, 'todo'],
    ['researched', false, 'plan'],
    ['designed', false, 'plan'],
    ['in_progress', false, 'implement'],
    ['built', true, 'review'],
    ['built', false, 'implement'],
    ['live', false, 'released'],
    ['done', false, 'closed'],
    ['dropped', false, 'todo'],
  ];
  for (const [status, hasPullRequest, expected] of rows) {
    it(`should send ${status}${hasPullRequest ? ' with a PR' : ''} to ${expected} in pr-release-verify`, () => {
      // Act
      const lane = laneOf('pr-release-verify', status, hasPullRequest);

      // Assert
      should(lane).equal(expected);
    });
  }

  it('should send a quick task past the Plan lane its variant skips', () => {
    // Act
    const lane = laneOf('pr-release-verify', 'researched', false, 'quick');

    // Assert
    should(lane).equal('implement');
  });

  it('should fall to the verify lane when a live task has no shipped lane', () => {
    // Act
    const lane = laneOf('ops', 'live');

    // Assert
    should(lane).equal('verify');
  });

  it('should fall to the closed lane when a live task has no shipped or verify lane', () => {
    // Act
    const lane = laneOf('quick', 'live');

    // Assert
    should(lane).equal('closed');
  });

  it('should keep a built task with a PR in the last active lane when there is no review lane', () => {
    // Act
    const lane = laneOf('ops', 'built', true);

    // Assert
    should(lane).equal('fix');
  });

  it('should use the whole lane set when the workflow variant names a missing lane', () => {
    // Arrange
    const broken: LaneSet = { ...lanes(undefined, 'quick'), variants: { quick: ['nowhere'] } };

    // Act
    const lane = laneForStatus(broken, { status: 'in_progress', workflow: 'quick', hasPullRequest: false });

    // Assert
    should(lane.id).equal('doing');
  });

  it('should fall to the backlog lane when there is no active lane', () => {
    // Arrange
    const [todo, , closed] = LANE_TEMPLATES.quick.lanes;
    const bare: LaneSet = { ...lanes(undefined, 'quick'), lanes: [todo!, closed!], variants: {} };

    // Act
    const lane = laneForStatus(bare, { status: 'in_progress', workflow: 'quick', hasPullRequest: false });

    // Assert
    should(lane.id).equal('todo');
  });

  it('should fall to the last lane when the set has neither backlog nor closed categories', () => {
    // Arrange
    const [, doing] = LANE_TEMPLATES.quick.lanes;
    const odd: LaneSet = { ...lanes(undefined, 'quick'), lanes: [doing!], variants: {} };

    // Act
    const done = laneForStatus(odd, { status: 'done', workflow: 'quick', hasPullRequest: false });
    const todo = laneForStatus(odd, { status: 'todo', workflow: 'quick', hasPullRequest: false });

    // Assert
    should(done.id).equal('doing');
    should(todo.id).equal('doing');
  });
});

describe('statusOfPhase', () => {
  const rows = [
    ['todo', 'todo'],
    ['research', 'researched'],
    ['design', 'designed'],
    ['build', 'in_progress'],
    ['built', 'built'],
    ['live', 'live'],
    ['done', 'done'],
    ['dropped', 'dropped'],
  ] as const;
  for (const [phase, status] of rows) {
    it(`should read phase ${phase} as status ${status}`, () => {
      // Act
      const result = statusOfPhase(phase);

      // Assert
      should(result).equal(status);
    });
  }
});
