import { describe, it } from 'bun:test';
import type { ScopedTaskSummary, TaskActivity } from '@ferretry/protocol';
import should from 'should';
import {
  computeFileConflicts,
  filterTasks,
  groupTasksByBoardLane,
  groupTasksByPhase,
  sortTasksForList,
  TASK_BOARD_LANE_ORDER,
  TASK_PHASE_ORDER,
  taskActivityText,
  taskLivenessLabel,
  tasksForSession,
} from '../../../src/features/tasks/task-projections.ts';
import { type TaskSummaryOverrides, taskSummary } from '../../support/tasks.ts';

const scoped = (id: string, sessionId: string | null, overrides: TaskSummaryOverrides = {}): ScopedTaskSummary => ({
  ...taskSummary({ id, ...overrides }),
  sessionId,
});

const ids = (tasks: readonly { readonly id: string }[]): string[] => tasks.map(task => task.id);

const activityBase = { v: 1, seq: 1, time: '2026-07-01T00:00:00.000Z', actor: 'kirin', actorName: null } as const;

describe('taskLivenessLabel', () => {
  it('says so plainly when nobody owns the task', () => {
    should(taskLivenessLabel(taskSummary({ assignee: null }))).equal('Unassigned');
  });

  it('names the assignee beside their live session status', () => {
    should(taskLivenessLabel(taskSummary({ assignee: 'loge', live: { assigneeStatus: 'running' } }))).equal(
      'loge · running',
    );
  });

  it('admits an unreadable status rather than rendering a blank', () => {
    should(taskLivenessLabel(taskSummary({ assignee: 'loge' }))).equal('loge · status unavailable');
  });

  it('lets staleness outrank a status the dead session last wrote', () => {
    should(
      taskLivenessLabel(
        taskSummary({ assignee: 'loge', live: { assigneeStatus: 'running', staleness: 'assignee-dead' } }),
      ),
    ).equal('Assignee unavailable');
  });
});

describe('taskActivityText', () => {
  it('names the phase a task was created in', () => {
    const activity = {
      ...activityBase,
      type: 'created',
      data: {
        status: 'todo',
        phase: 'todo',
        workflow: 'quick',
        kind: 'feature',
        title: 'Fix it',
        askSource: 'human',
        dependsOn: [],
        reason: 'asked',
      },
    } as TaskActivity;
    should(taskActivityText(activity)).equal('Created in todo');
  });

  it('reads a status move as phase to phase, with the reason', () => {
    const activity = {
      ...activityBase,
      type: 'status',
      data: { from: 'todo', to: 'in_progress', phaseFrom: 'todo', phaseTo: 'build', reason: 'picked up' },
    } as TaskActivity;
    should(taskActivityText(activity)).equal('todo → build: picked up');
  });

  it('marks a backward move and a reopen distinctly', () => {
    const backward = {
      ...activityBase,
      type: 'status',
      data: { from: 'built', to: 'todo', phaseFrom: 'built', phaseTo: 'build', reason: 'regressed', backward: true },
    } as TaskActivity;
    const reopened = {
      ...activityBase,
      type: 'status',
      data: { from: 'done', to: 'todo', phaseFrom: 'done', phaseTo: 'todo', reason: 'came back', reopened: true },
    } as TaskActivity;
    should(taskActivityText(backward)).equal('Moved back · built → build: regressed');
    should(taskActivityText(reopened)).equal('Reopened · done → todo: came back');
  });

  it('falls back to the note when the reason is empty', () => {
    const activity = {
      ...activityBase,
      type: 'status',
      data: { from: 'todo', to: 'todo', phaseFrom: 'todo', phaseTo: 'todo', reason: '', note: 'no-op' },
    } as unknown as TaskActivity;
    should(taskActivityText(activity)).equal('todo → todo: no-op');
  });

  it('renders a bare phase move when neither reason nor note is set', () => {
    const activity = {
      ...activityBase,
      type: 'status',
      data: { from: 'todo', to: 'todo', phaseFrom: 'todo', phaseTo: 'build', reason: '' },
    } as unknown as TaskActivity;
    should(taskActivityText(activity)).equal('todo → build');
  });

  it('quotes a clarification', () => {
    const activity = {
      ...activityBase,
      type: 'clarification',
      data: { text: 'which repo?', source: 'human' },
    } as TaskActivity;
    should(taskActivityText(activity)).equal('Clarification: which repo?');
  });

  it('sigils a dependency both ways', () => {
    const added = {
      ...activityBase,
      type: 'dependency',
      data: { taskId: 'F13', operation: 'add' },
    } as TaskActivity;
    const removed = {
      ...activityBase,
      type: 'dependency',
      data: { taskId: 'F13', operation: 'remove' },
    } as TaskActivity;
    should(taskActivityText(added)).equal('Depends on &F13');
    should(taskActivityText(removed)).equal('Removed dependency &F13');
  });

  it('reads a file claim and its release, with an optional reason', () => {
    const claimed = {
      ...activityBase,
      type: 'file',
      data: { path: 'src/a.ts', operation: 'add', reason: 'rewriting' },
    } as TaskActivity;
    const released = {
      ...activityBase,
      type: 'file',
      data: { path: 'src/a.ts', operation: 'remove' },
    } as TaskActivity;
    should(taskActivityText(claimed)).equal('Claimed file src/a.ts: rewriting');
    should(taskActivityText(released)).equal('Unclaimed file src/a.ts');
  });

  it('reports a completion claim with the turn it was made on', () => {
    const activity = {
      ...activityBase,
      type: 'session',
      data: {
        event: 'completion-claim',
        session: 'ms9-abc',
        turn: 7,
        phase: 'build',
        claimedAt: '2026-07-01T00:00:00.000Z',
      },
    } as TaskActivity;
    should(taskActivityText(activity)).equal('Completion claim: ms9-abc (turn 7, build)');
  });

  it('prefers the human-readable name when a reopen is acknowledged', () => {
    const named = {
      ...activityBase,
      type: 'session',
      data: { event: 'reopen-ack', reopenAck: 2, resolvedBy: 'ms9-abc', resolvedByName: 'loge', note: 'redone' },
    } as TaskActivity;
    const anonymous = {
      ...activityBase,
      type: 'session',
      data: { event: 'reopen-ack', reopenAck: 2, resolvedBy: 'ms9-abc', resolvedByName: null },
    } as TaskActivity;
    should(taskActivityText(named)).equal('Reopen acknowledged by loge: redone');
    should(taskActivityText(anonymous)).equal('Reopen acknowledged by ms9-abc');
  });

  it('reads an assignment, including one that clears the assignee', () => {
    const assigned = {
      ...activityBase,
      type: 'assign',
      data: { from: null, to: 'loge' },
    } as TaskActivity;
    const cleared = { ...activityBase, type: 'assign', data: { from: 'loge', to: null } } as TaskActivity;
    should(taskActivityText(assigned)).equal('Assigned to loge');
    should(taskActivityText(cleared)).equal('Assigned to unassigned');
  });

  it('calls an absent priority unranked at both ends', () => {
    const ranked = { ...activityBase, type: 'order', data: { from: null, to: 3 } } as TaskActivity;
    const unranked = { ...activityBase, type: 'order', data: { from: 3, to: null } } as TaskActivity;
    should(taskActivityText(ranked)).equal('Priority unranked → 3');
    should(taskActivityText(unranked)).equal('Priority 3 → unranked');
  });

  it('names the field a link landed in', () => {
    const activity = {
      ...activityBase,
      type: 'link',
      data: { field: 'branch', value: 'port/pwastore' },
    } as TaskActivity;
    should(taskActivityText(activity)).equal('Linked branch: port/pwastore');
  });

  it('quotes a note and a feedback line verbatim', () => {
    const note = { ...activityBase, type: 'note', data: { text: 'checked in' } } as TaskActivity;
    const feedback = { ...activityBase, type: 'feedback', data: { text: 'looks wrong' } } as TaskActivity;
    should(taskActivityText(note)).equal('checked in');
    should(taskActivityText(feedback)).equal('looks wrong');
  });
});

describe('filterTasks', () => {
  const tasks = [
    taskSummary({ id: 'F1', repo: 'ferretry', status: 'todo', assignee: 'loge' }),
    taskSummary({ id: 'F2', repo: 'kteam', status: 'done', phase: 'done', assignee: 'sol' }),
    taskSummary({ id: 'F3', repo: 'ferretry', status: 'done', phase: 'done', assignee: 'sol' }),
  ];

  it('passes everything through when every axis is all', () => {
    should(ids(filterTasks(tasks, { repo: 'all', status: 'all', assignee: 'all' }))).eql(['F1', 'F2', 'F3']);
  });

  it('narrows on repo, status and assignee together', () => {
    should(ids(filterTasks(tasks, { repo: 'ferretry', status: 'done', assignee: 'sol' }))).eql(['F3']);
  });

  it('narrows on one axis at a time', () => {
    should(ids(filterTasks(tasks, { repo: 'kteam', status: 'all', assignee: 'all' }))).eql(['F2']);
    should(ids(filterTasks(tasks, { repo: 'all', status: 'todo', assignee: 'all' }))).eql(['F1']);
    should(ids(filterTasks(tasks, { repo: 'all', status: 'all', assignee: 'loge' }))).eql(['F1']);
  });
});

describe('sortTasksForList', () => {
  it('leads with blocked work, then stale, then the rest', () => {
    const tasks = [
      taskSummary({ id: 'calm' }),
      taskSummary({ id: 'stale', live: { staleness: 'quiet' } }),
      taskSummary({ id: 'blocked', blocked: true, blockedSince: '2026-07-05T00:00:00.000Z' }),
    ];
    should(ids(sortTasksForList(tasks))).eql(['blocked', 'stale', 'calm']);
  });

  it('puts the OLDEST evidence first within a band', () => {
    const tasks = [
      taskSummary({ id: 'recent', blocked: true, blockedSince: '2026-07-09T00:00:00.000Z' }),
      taskSummary({ id: 'ancient', blocked: true, blockedSince: '2026-07-01T00:00:00.000Z' }),
    ];
    should(ids(sortTasksForList(tasks))).eql(['ancient', 'recent']);
  });

  it('reads updatedAt when a task is not blocked, and createdAt when it has never been updated', () => {
    const tasks = [
      taskSummary({ id: 'newer', updatedAt: '2026-07-09T00:00:00.000Z' }),
      taskSummary({ id: 'older', updatedAt: '2026-07-02T00:00:00.000Z' }),
    ];
    should(ids(sortTasksForList(tasks))).eql(['older', 'newer']);
  });

  it('sorts an undated record last rather than to the top of the attention list', () => {
    const tasks = [
      taskSummary({ id: 'undated', updatedAt: null, createdAt: null } as unknown as TaskSummaryOverrides),
      taskSummary({ id: 'dated', updatedAt: '2026-07-02T00:00:00.000Z' }),
    ];
    should(ids(sortTasksForList(tasks))).eql(['dated', 'undated']);
  });

  it('ignores an unparseable timestamp instead of scrambling the order', () => {
    const tasks = [
      taskSummary({ id: 'broken', updatedAt: 'not-a-date' }),
      taskSummary({ id: 'fine', updatedAt: '2026-07-02T00:00:00.000Z' }),
    ];
    should(ids(sortTasksForList(tasks))).eql(['fine', 'broken']);
  });

  it('breaks a timestamp tie on explicit priority', () => {
    const tasks = [taskSummary({ id: 'second', order: 5 }), taskSummary({ id: 'first', order: 1 })];
    should(ids(sortTasksForList(tasks))).eql(['first', 'second']);
  });

  it('ranks an unprioritised task after a prioritised one', () => {
    const tasks = [taskSummary({ id: 'none', order: null }), taskSummary({ id: 'ranked', order: 9 })];
    should(ids(sortTasksForList(tasks))).eql(['ranked', 'none']);
  });

  it('falls through to the id so equal rows never reshuffle', () => {
    const tasks = [taskSummary({ id: 'F9' }), taskSummary({ id: 'F2' })];
    should(ids(sortTasksForList(tasks))).eql(['F2', 'F9']);
  });

  it('does not mutate the caller its own array', () => {
    const tasks = [taskSummary({ id: 'F9' }), taskSummary({ id: 'F2' })];
    sortTasksForList(tasks);
    should(ids(tasks)).eql(['F9', 'F2']);
  });
});

describe('groupTasksByBoardLane', () => {
  const tasks = [
    taskSummary({ id: 'research', phase: 'research' }),
    taskSummary({ id: 'design', phase: 'design' }),
    taskSummary({ id: 'build', phase: 'build' }),
    taskSummary({ id: 'todo', phase: 'todo' }),
    taskSummary({ id: 'live', phase: 'live', status: 'live' }),
  ];

  it('collapses research, design and build into one working lane', () => {
    const lanes = groupTasksByBoardLane(tasks);
    const inProgress = lanes.find(lane => lane.lane === 'in_progress');
    should(ids(inProgress?.tasks ?? [])).eql(['build', 'design', 'research']);
  });

  it('keeps every lane mounted, including the empty ones', () => {
    should(groupTasksByBoardLane(tasks).map(lane => lane.lane)).eql([...TASK_BOARD_LANE_ORDER]);
    should(groupTasksByBoardLane([]).map(lane => lane.tasks.length)).eql([0, 0, 0, 0, 0, 0]);
  });

  it('sorts within a lane by the same attention order the list uses', () => {
    const lanes = groupTasksByBoardLane([
      taskSummary({ id: 'calm', phase: 'todo' }),
      taskSummary({ id: 'blocked', phase: 'todo', blocked: true, blockedSince: '2026-07-01T00:00:00.000Z' }),
    ]);
    should(ids(lanes[0]?.tasks ?? [])).eql(['blocked', 'calm']);
  });
});

describe('groupTasksByPhase', () => {
  it('keeps the raw audit phases apart rather than collapsing them', () => {
    const groups = groupTasksByPhase([
      taskSummary({ id: 'r', phase: 'research' }),
      taskSummary({ id: 'b', phase: 'build' }),
    ]);
    should(groups.map(group => group.phase)).eql([...TASK_PHASE_ORDER]);
    should(ids(groups.find(group => group.phase === 'research')?.tasks ?? [])).eql(['r']);
    should(ids(groups.find(group => group.phase === 'build')?.tasks ?? [])).eql(['b']);
  });
});

describe('tasksForSession', () => {
  const fleet = [scoped('F1', 'session-a'), scoped('F2', 'session-b'), scoped('F3', null)];

  it('shows only the rows one session owns', () => {
    should(ids(tasksForSession(fleet, 'session-a'))).eql(['F1']);
  });

  it('never hands an unowned fleet task to a session surface', () => {
    should(ids(tasksForSession(fleet, 'session-c'))).be.empty();
  });
});

describe('computeFileConflicts', () => {
  it('reports the exact overlapping paths between two live claims', () => {
    const conflicts = computeFileConflicts([
      scoped('F1', 'session-a', { phase: 'build', files: ['src/a.ts', 'src/b.ts'] }),
      scoped('F2', 'session-a', { phase: 'todo', files: ['src/b.ts'] }),
    ]);
    should(conflicts.get('F1')).eql([
      { taskId: 'F2', sessionId: 'session-a', files: ['src/b.ts'], crossSession: false },
    ]);
    should(conflicts.get('F2')).eql([
      { taskId: 'F1', sessionId: 'session-a', files: ['src/b.ts'], crossSession: false },
    ]);
  });

  it('flags a claim held by a different session', () => {
    const conflicts = computeFileConflicts([
      scoped('F1', 'session-a', { phase: 'build', files: ['src/a.ts'] }),
      scoped('F2', 'session-b', { phase: 'build', files: ['src/a.ts'] }),
    ]);
    should(conflicts.get('F1')?.[0]?.crossSession).be.true();
  });

  it('lets a finished task stop lighting a banner on active work', () => {
    should(
      computeFileConflicts([
        scoped('F1', 'session-a', { phase: 'build', files: ['src/a.ts'] }),
        scoped('F2', 'session-b', { phase: 'done', status: 'done', files: ['src/a.ts'] }),
      ]),
    ).be.empty();
  });

  it('does not call the same relative path in two known-different repos one file', () => {
    should(
      computeFileConflicts([
        scoped('F1', 'session-a', { phase: 'build', repo: 'ferretry', files: ['src/a.ts'] }),
        scoped('F2', 'session-b', { phase: 'build', repo: 'kteam', files: ['src/a.ts'] }),
      ]),
    ).be.empty();
  });

  it('still warns when one side does not say which repo it is in', () => {
    const conflicts = computeFileConflicts([
      scoped('F1', 'session-a', { phase: 'build', repo: 'ferretry', files: ['src/a.ts'] }),
      scoped('F2', 'session-b', { phase: 'build', repo: null, files: ['src/a.ts'] }),
    ]);
    should(conflicts.get('F1')).have.length(1);
  });

  it('ignores a task that claims nothing', () => {
    should(
      computeFileConflicts([
        scoped('F1', 'session-a', { phase: 'build', files: [] }),
        scoped('F2', 'session-b', { phase: 'build', files: [] }),
      ]),
    ).be.empty();
  });

  it('reports nothing when no two claims overlap', () => {
    should(
      computeFileConflicts([
        scoped('F1', 'session-a', { phase: 'build', files: ['src/a.ts'] }),
        scoped('F2', 'session-b', { phase: 'build', files: ['src/b.ts'] }),
      ]),
    ).be.empty();
  });

  it('de-duplicates a repeated claim and orders conflicts by task id', () => {
    const conflicts = computeFileConflicts([
      scoped('F1', 'session-a', { phase: 'build', files: ['src/a.ts'] }),
      scoped('F9', 'session-a', { phase: 'build', files: ['src/a.ts', 'src/a.ts'] }),
      scoped('F2', 'session-a', { phase: 'build', files: ['src/a.ts'] }),
    ]);
    should(conflicts.get('F1')?.map(conflict => conflict.taskId)).eql(['F2', 'F9']);
    should(conflicts.get('F1')?.[1]?.files).eql(['src/a.ts']);
  });
});
