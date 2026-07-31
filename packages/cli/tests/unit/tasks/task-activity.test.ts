import { describe, it } from 'bun:test';
import { type TaskActivity, TaskActivitySchema } from '@ferretry/protocol';
import should from 'should';
import { summarizeTaskActivity } from '../../../src/lib/tasks/task-activity';

/** Every case goes through the wire schema first, so a fixture can never describe an impossible record. */
const activity = (type: TaskActivity['type'], data: unknown): TaskActivity =>
  TaskActivitySchema.parse({ v: 1, seq: 1, time: '2026-01-02T00:00:00.000Z', actor: 'a', actorName: null, type, data });

describe('history summaries', () => {
  it('should describe creation with the status it started in', () => {
    // Act
    const actual = summarizeTaskActivity(
      activity('created', {
        status: 'todo',
        phase: 'todo',
        workflow: 'quick',
        kind: 'feature',
        title: 'Rename the widget',
        askSource: 'chat://1',
        dependsOn: [],
        reason: 'human asked',
      }),
    );

    // Assert
    should(actual).equal('as todo — human asked');
  });

  it('should describe a status move as a phase transition with its reason', () => {
    // Act
    const actual = summarizeTaskActivity(
      activity('status', {
        from: 'todo',
        to: 'in_progress',
        phaseFrom: 'todo',
        phaseTo: 'build',
        reason: 'starting',
        note: 'behind a flag',
      }),
    );

    // Assert
    should(actual).equal('todo → build (starting): behind a flag');
  });

  it('should mark a backward move and a reopen distinctly', () => {
    // Arrange
    const base = { from: 'built', to: 'in_progress', phaseFrom: 'built', phaseTo: 'build', reason: 'regressed' };

    // Act
    const backward = summarizeTaskActivity(activity('status', { ...base, backward: true }));
    const reopened = summarizeTaskActivity(activity('status', { ...base, reopened: true }));

    // Assert
    should(backward).startWith('MOVED BACK ');
    should(reopened).startWith('REOPENED ');
  });

  it('should print notes and feedback verbatim', () => {
    // Act + Assert
    should(summarizeTaskActivity(activity('note', { text: 'looked at it' }))).equal('looked at it');
    should(summarizeTaskActivity(activity('feedback', { text: 'needs tests' }))).equal('needs tests');
  });

  it('should keep a clarification next to its source', () => {
    // Act
    const actual = summarizeTaskActivity(activity('clarification', { text: 'make it blue', source: 'chat://4' }));

    // Assert
    should(actual).equal('make it blue (chat://4)');
  });

  it('should describe dependency and file changes by their operation', () => {
    // Act + Assert
    should(summarizeTaskActivity(activity('dependency', { taskId: 'F12', operation: 'remove' }))).equal('remove #F12');
    should(summarizeTaskActivity(activity('file', { path: 'src/a.ts', operation: 'add', reason: 'claimed' }))).equal(
      'add `src/a.ts` (claimed)',
    );
    should(summarizeTaskActivity(activity('file', { path: 'src/a.ts', operation: 'remove' }))).equal(
      'remove `src/a.ts`',
    );
  });

  it('should describe a link by its field', () => {
    // Act
    const actual = summarizeTaskActivity(activity('link', { field: 'pr', value: 'pr://1' }));

    // Assert
    should(actual).equal('pr = pr://1');
  });

  it('should show an assignment and a rank as a transition, with — for absent ends', () => {
    // Act + Assert
    should(summarizeTaskActivity(activity('assign', { from: null, to: 'ada' }))).equal('— → ada');
    should(summarizeTaskActivity(activity('order', { from: 2, to: null }))).equal('2 → —');
  });

  it('should describe a completion claim with the session and turn that made it', () => {
    // Act
    const actual = summarizeTaskActivity(
      activity('session', {
        event: 'completion-claim',
        session: 'session-7',
        turn: 4,
        phase: 'build',
        claimedAt: '2026-01-02T00:00:00.000Z',
      }),
    );

    // Assert
    should(actual).equal('session-7 claimed build complete at turn 4');
  });

  it('should describe a reopen acknowledgement without inventing a session', () => {
    // Act — kteam indexed `data.session` for both halves of this union and printed "undefined reopen-ack".
    const actual = summarizeTaskActivity(
      activity('session', { event: 'reopen-ack', reopenAck: 2, resolvedBy: 'agent-3', resolvedByName: 'Grace' }),
    );

    // Assert
    should(actual).equal('reopen 2 acknowledged by Grace');
    should(actual).not.containEql('undefined');
  });

  it('should fall back to the actor id when no display name is known', () => {
    // Act
    const actual = summarizeTaskActivity(
      activity('session', { event: 'reopen-ack', reopenAck: 1, resolvedBy: 'agent-3', resolvedByName: null }),
    );

    // Assert
    should(actual).equal('reopen 1 acknowledged by agent-3');
  });
});
