import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderTaskAction,
  renderTaskBoard,
  renderTaskDag,
  renderTaskDetail,
  renderTaskKanban,
} from '../../../src/lib/tasks/task-render';
import { noteActivity, quietLive, summary, view } from './fixtures';

const board = (tasks: ReturnType<typeof summary>[], parseErrors = 0, parseErrorIds?: string[]) => ({
  tasks,
  parseErrors,
  ...(parseErrorIds === undefined ? {} : { parseErrorIds }),
});

describe('the terminal board', () => {
  it('should say so when there is nothing to show', () => {
    // Act
    const actual = renderTaskBoard(board([]));

    // Assert
    should(actual).equal('No tasks.');
  });

  it('should report unreadable records instead of pretending the board is complete', () => {
    // Act
    const actual = renderTaskBoard(board([], 2, ['F9', 'F10']));

    // Assert
    should(actual).containEql('2 task record(s) could not be read');
    should(actual).containEql('F9, F10');
  });

  it('should lift tasks only a human can unstick into an ATTENTION strip', () => {
    // Arrange — F2 is blocked by another task, so it is not the human's problem.
    const tasks = [
      summary({ id: 'F1' }),
      summary({ id: 'F2', blocked: true, blockedReason: 'waits on F3', blockedBy: ['F3'] }),
      summary({ id: 'F4', blocked: true, blockedReason: 'needs a decision', blockedBy: [] }),
    ];

    // Act
    const actual = renderTaskBoard(board(tasks)).split('\n');

    // Assert
    should(actual[0]).equal('ATTENTION');
    should(actual[1]).containEql('#F4');
    should(actual.slice(2).join('\n')).containEql('#F2');
    should(actual.filter(line => line === 'ATTENTION')).have.length(1);
  });

  it('should order blocked before stale before quiet, then by id', () => {
    // Arrange
    const tasks = [
      summary({ id: 'F10' }),
      summary({ id: 'F2' }),
      summary({ id: 'F3', live: { ...quietLive, staleness: 'quiet' } }),
      summary({ id: 'F4', blocked: true, blockedReason: 'stuck', blockedBy: ['F2'] }),
    ];

    // Act
    const ids = renderTaskBoard(board(tasks))
      .split('\n')
      .map(line => line.split(' ')[0]);

    // Assert — F2 before F10 proves the numeric collation, not lexicographic.
    should(ids).eql(['#F4', '#F3', '#F2', '#F10']);
  });

  it('should break ties among blocked tasks by how long they have been blocked', () => {
    // Arrange
    const tasks = [
      summary({ id: 'F1', blocked: true, blockedReason: 'newer', blockedSince: '2026-03-01T00:00:00.000Z' }),
      summary({ id: 'F2', blocked: true, blockedReason: 'older', blockedSince: '2026-01-01T00:00:00.000Z' }),
      summary({ id: 'F3', blocked: true, blockedReason: 'unknown', blockedSince: null }),
    ];

    // Act
    const ids = renderTaskBoard(board(tasks))
      .split('\n')
      .filter(line => line.startsWith('#'))
      .map(line => line.split(' ')[0]);

    // Assert
    should(ids).eql(['#F2', '#F1', '#F3']);
  });

  it('should break ties among stale tasks by how long they have been quiet', () => {
    // Arrange
    const stale = { ...quietLive, staleness: 'quiet' } as const;
    const tasks = [
      summary({ id: 'F1', live: stale, updatedAt: '2026-05-01T00:00:00.000Z' }),
      summary({ id: 'F2', live: stale, updatedAt: '2026-02-01T00:00:00.000Z' }),
    ];

    // Act
    const ids = renderTaskBoard(board(tasks))
      .split('\n')
      .map(line => line.split(' ')[0]);

    // Assert
    should(ids).eql(['#F2', '#F1']);
  });

  it('should show the lane, the assignee and both badges on a summary line', () => {
    // Arrange
    const task = summary({
      id: 'F7',
      phase: 'build',
      assignee: 'ada',
      title: 'Ship the widget',
      blocked: true,
      blockedReason: 'waiting on review',
      live: { ...quietLive, staleness: 'maybe-finished' },
    });

    // Act
    const actual = renderTaskBoard(board([task]));

    // Assert
    should(actual).containEql('#F7');
    should(actual).containEql('BLOCKED');
    should(actual).containEql('ada');
    should(actual).containEql('🚧 waiting on review');
    should(actual).containEql('⚠ maybe-finished');
  });

  it('should fall back to a phrase when a blocked task carries no reason', () => {
    // Act
    const actual = renderTaskBoard(board([summary({ blocked: true, blockedReason: null })]));

    // Assert
    should(actual).containEql('reason unavailable');
    should(actual).not.containEql('null');
  });

  it('should show a non-blocked lane derived from the phase', () => {
    // Act
    const actual = renderTaskBoard(board([summary({ phase: 'design', status: 'designed', workflow: 'design-first' })]));

    // Assert
    should(actual).containEql('IN PROGRESS');
  });
});

describe('the kanban board', () => {
  it('should group by lane, collapsing the audit phases', () => {
    // Arrange
    const tasks = [
      summary({ id: 'F1', phase: 'todo' }),
      summary({ id: 'F2', phase: 'design', status: 'designed', workflow: 'design-first' }),
      summary({ id: 'F3', phase: 'build', status: 'in_progress' }),
      summary({ id: 'F4', phase: 'done', status: 'done' }),
    ];

    // Act
    const actual = renderTaskKanban(board(tasks));

    // Assert
    should(actual).containEql('IN PROGRESS (2)');
    should(actual).containEql('NOT STARTED (1)');
    should(actual).containEql('DONE (1)');
    should(actual.indexOf('NOT STARTED')).be.below(actual.indexOf('IN PROGRESS'));
  });

  it('should mark a blocked card and report unreadable records', () => {
    // Act
    const actual = renderTaskKanban(board([summary({ blocked: true, blockedReason: null })], 1));

    // Assert
    should(actual).containEql('BLOCKED 🚧 reason unavailable');
    should(actual).containEql('1 task record(s) could not be read');
  });

  it('should say so when there is nothing to group', () => {
    // Act
    const actual = renderTaskKanban(board([]));

    // Assert
    should(actual).equal('No tasks.');
  });
});

describe('the dependency view', () => {
  it('should show an empty edge set as ∅', () => {
    // Act
    const actual = renderTaskDag(board([summary({ id: 'F1' })]));

    // Assert
    should(actual).equal('#F1 → ∅  Rename the widget');
  });

  it('should list the tasks a task waits on', () => {
    // Act
    const actual = renderTaskDag(board([summary({ id: 'F1', dependsOn: ['F2', 'B3'] })]));

    // Assert
    should(actual).containEql('#F1 → #F2, #B3');
  });

  it('should not print a null blocked reason, which kteam rendered as "🚧 null"', () => {
    // Act
    const actual = renderTaskDag(board([summary({ blocked: true, blockedReason: null })]));

    // Assert
    should(actual).containEql('🚧 reason unavailable');
    should(actual).not.containEql('null');
  });

  it('should say so when there is nothing to graph', () => {
    // Act
    const actual = renderTaskDag(board([]));

    // Assert
    should(actual).equal('No tasks.');
  });
});

describe('one task in the terminal', () => {
  it('should print the declared record', () => {
    // Act
    const actual = renderTaskDetail({
      task: view({ id: 'F7', assignee: 'ada', repo: '/w/app', order: 3, statusReason: 'in review' }),
      activity: [],
    });

    // Assert
    should(actual).containEql('#F7  Rename the widget');
    should(actual).containEql('workflow  quick');
    should(actual).containEql('status    todo — in review');
    should(actual).containEql('assignee  ada');
    should(actual).containEql('repo      /w/app');
    should(actual).containEql('order     3');
    should(actual).containEql('depends   —');
    should(actual).containEql('files     — (advisory)');
  });

  it('should label a derived staleness as derived so it never reads as a status', () => {
    // Act
    const actual = renderTaskDetail({
      task: view({ live: { ...quietLive, staleness: 'assignee-dead', assigneeStatus: 'stopped' } }),
      activity: [],
    });

    // Assert
    should(actual).containEql('⚠ derived');
    should(actual).containEql('assignee is not running');
    should(actual).containEql('(stopped)');
  });

  it('should show the blocked banner with its reason and age', () => {
    // Act
    const actual = renderTaskDetail({
      task: view({ blocked: true, blockedReason: 'needs a decision', blockedSince: '2026-02-02T00:00:00.000Z' }),
      activity: [],
    });

    // Assert
    should(actual).containEql('🚧 blocked  needs a decision since 2026-02-02T00:00:00.000Z');
  });

  it('should fall back rather than print null for a blocked task with no reason', () => {
    // Act
    const actual = renderTaskDetail({ task: view({ blocked: true }), activity: [] });

    // Assert
    should(actual).containEql('🚧 blocked  blocked since unknown');
  });

  it('should list every link kind, the ask, the clarifications and the brief', () => {
    // Act
    const actual = renderTaskDetail({
      task: view({
        description: 'the long brief',
        dependsOn: ['F2'],
        files: ['src/a.ts'],
        links: { prs: ['pr://1'], branch: 'port/x', commits: ['abc'], docs: ['docs/x.md'] },
        clarifications: [
          {
            at: '2026-01-03T00:00:00.000Z',
            by: 'human',
            byName: 'Ada',
            text: 'make it blue',
            source: 'chat://4',
          },
        ],
      }),
      activity: [],
    });

    // Assert
    should(actual).containEql('pr     pr://1');
    should(actual).containEql('branch port/x');
    should(actual).containEql('commit abc');
    should(actual).containEql('doc    docs/x.md');
    should(actual).containEql('"please rename it"');
    should(actual).containEql('source chat://1');
    should(actual).containEql('make it blue — chat://4');
    should(actual).containEql('the long brief');
    should(actual).containEql('depends   #F2');
    should(actual).containEql('files     src/a.ts (advisory)');
  });

  it('should indent a multi-line ask so it stays readable', () => {
    // Act
    const actual = renderTaskDetail({ task: view({ ask: { text: 'line one\nline two', source: 's' } }), activity: [] });

    // Assert
    should(actual).containEql('"line one\n  line two"');
  });

  it('should print the history with its summaries and flag unreadable lines', () => {
    // Act
    const actual = renderTaskDetail({
      task: view(),
      activity: [noteActivity({ actorName: 'Ada' })],
      activityParseErrors: 2,
    });

    // Assert
    should(actual).containEql('activity (1)');
    should(actual).containEql('Ada  looked at it');
    should(actual).containEql('2 history line(s) unreadable');
  });

  it('should not claim unreadable history when there is none', () => {
    // Act
    const actual = renderTaskDetail({ task: view(), activity: [], activityParseErrors: 0 });

    // Assert
    should(actual).not.containEql('unreadable');
  });
});

describe('what a mutation prints', () => {
  it('should echo the id and where it landed', () => {
    // Act
    const actual = renderTaskAction(view({ id: 'F7', phase: 'build', status: 'in_progress' }));

    // Assert
    should(actual).equal('#F7  build');
  });

  it('should append the reason and any derived warning', () => {
    // Act
    const actual = renderTaskAction(
      view({ id: 'F7', statusReason: 'waiting', live: { ...quietLive, staleness: 'quiet' } }),
    );

    // Assert
    should(actual).containEql('#F7  todo — waiting');
    should(actual).containEql('no activity for a while');
  });
});
