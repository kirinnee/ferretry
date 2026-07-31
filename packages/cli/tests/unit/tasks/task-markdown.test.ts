import { describe, it } from 'bun:test';
import should from 'should';
import { renderTaskBoardMarkdown, renderTaskDetailMarkdown } from '../../../src/lib/tasks/task-markdown';
import { noteActivity, quietLive, summary, view } from './fixtures';

const board = (tasks: ReturnType<typeof summary>[], parseErrors = 0, parseErrorIds?: string[]) => ({
  tasks,
  parseErrors,
  ...(parseErrorIds === undefined ? {} : { parseErrorIds }),
});

describe('the markdown board', () => {
  it('should lead with what the reader has to act on', () => {
    // Arrange
    const tasks = [
      summary({ id: 'F1', title: 'Ship it' }),
      summary({ id: 'F2', title: 'Pick a name', blocked: true, blockedReason: 'needs a decision' }),
    ];

    // Act
    const actual = renderTaskBoardMarkdown(board(tasks));

    // Assert
    should(actual).startWith('# Tasks');
    should(actual.indexOf('## What I need from you')).be.below(actual.indexOf('## ⚪ NOT STARTED'));
    should(actual).containEql('- **#F2** Pick a name — needs a decision');
  });

  it('should not repeat a blocked task in its lane', () => {
    // Arrange
    const tasks = [summary({ id: 'F2', blocked: true, blockedReason: 'stuck' })];

    // Act
    const actual = renderTaskBoardMarkdown(board(tasks));

    // Assert
    should(actual.split('#F2')).have.length(2);
    should(actual).not.containEql('NOT STARTED');
  });

  it('should escape pipes and flatten newlines so a title cannot break the table', () => {
    // Act
    const actual = renderTaskBoardMarkdown(board([summary({ title: 'a | b', statusReason: 'one\n\ntwo' })]));

    // Assert
    should(actual).containEql('a \\| b');
    should(actual).containEql('one two');
  });

  it('should badge a stale assignee inside the table cell', () => {
    // Act
    const actual = renderTaskBoardMarkdown(
      board([summary({ assignee: 'ada', live: { ...quietLive, staleness: 'quiet' } })]),
    );

    // Assert
    should(actual).containEql('| ada ⚠️ quiet |');
  });

  it('should group the audit phases into one section', () => {
    // Arrange
    const tasks = [
      summary({ id: 'F1', phase: 'design', status: 'designed', workflow: 'design-first' }),
      summary({ id: 'F2', phase: 'build', status: 'in_progress' }),
    ];

    // Act
    const actual = renderTaskBoardMarkdown(board(tasks));

    // Assert
    should(actual).containEql('## 🔵 IN PROGRESS (2)');
  });

  it('should say so when there is nothing, and report unreadable records', () => {
    // Act
    const empty = renderTaskBoardMarkdown(board([]));
    const broken = renderTaskBoardMarkdown(board([], 3, ['F9']));

    // Assert
    should(empty).containEql('_No tasks._');
    should(broken).containEql('> ⚠️ 3 task record(s) could not be read');
    should(broken).containEql('F9');
  });
});

describe('one task as markdown', () => {
  it('should open with the id, the title and the spelled-out status', () => {
    // Act
    const actual = renderTaskDetailMarkdown({ task: view({ id: 'F7', statusReason: 'in review' }), activity: [] });

    // Assert
    should(actual).startWith('# #F7 · Rename the widget');
    should(actual).containEql('- status: **⚪ NOT STARTED** — in review');
    should(actual).containEql('- workflow: quick');
  });

  it('should label the derived staleness as leaving the declared status alone', () => {
    // Act
    const actual = renderTaskDetailMarkdown({
      task: view({ live: { ...quietLive, staleness: 'maybe-finished' } }),
      activity: [],
    });

    // Assert
    should(actual).containEql('declared status unchanged');
  });

  it('should name the tasks that are blocking it', () => {
    // Act
    const actual = renderTaskDetailMarkdown({
      task: view({
        blocked: true,
        blockedReason: 'waits',
        blockedSince: '2026-02-02T00:00:00.000Z',
        blockedBy: ['F2'],
      }),
      activity: [],
    });

    // Assert
    should(actual).containEql('🚧 blocked since 2026-02-02T00:00:00.000Z: waits (#F2)');
  });

  it('should fall back rather than print null for an unexplained block', () => {
    // Act
    const actual = renderTaskDetailMarkdown({ task: view({ blocked: true }), activity: [] });

    // Assert
    should(actual).containEql('blocked since unknown: unknown');
  });

  it('should quote the ask, list links and clarifications, and print the brief', () => {
    // Act
    const actual = renderTaskDetailMarkdown({
      task: view({
        description: 'the long brief',
        files: ['src/a.ts'],
        dependsOn: ['F2'],
        links: { prs: ['pr://1'], branch: 'port/x', commits: ['abc'], docs: ['docs/x.md'] },
        ask: { text: 'line one\nline two', source: 'chat://1' },
        clarifications: [
          { at: '2026-01-03T00:00:00.000Z', by: 'human', byName: null, text: 'make it blue', source: 'chat://4' },
        ],
      }),
      activity: [],
    });

    // Assert
    should(actual).containEql('- PR pr://1');
    should(actual).containEql('- branch port/x');
    should(actual).containEql('- commit abc');
    should(actual).containEql('- doc docs/x.md');
    should(actual).containEql('> line one\n> line two');
    should(actual).containEql('Source: chat://1');
    should(actual).containEql('- 2026-01-03T00:00:00.000Z (human): make it blue — chat://4');
    should(actual).containEql('- files (advisory): `src/a.ts`');
    should(actual).containEql('- depends on: #F2');
    should(actual).containEql('the long brief');
  });

  it('should say when there is no brief and no history', () => {
    // Act
    const actual = renderTaskDetailMarkdown({ task: view(), activity: [] });

    // Assert
    should(actual).containEql('_No description._');
    should(actual).containEql('_No activity._');
  });

  it('should render history entries and flag unreadable ones', () => {
    // Act
    const actual = renderTaskDetailMarkdown({
      task: view(),
      activity: [noteActivity({ actorName: 'Ada' })],
      activityParseErrors: 1,
    });

    // Assert
    should(actual).containEql('- 1. `2026-01-02T00:00:00.000Z` **note** (Ada) looked at it');
    should(actual).containEql('> ⚠️ 1 history line(s) unreadable');
  });

  it('should not claim unreadable history when there is none', () => {
    // Act
    const actual = renderTaskDetailMarkdown({ task: view(), activity: [], activityParseErrors: 0 });

    // Assert
    should(actual).not.containEql('unreadable');
  });
});
