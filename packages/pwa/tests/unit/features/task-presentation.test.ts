import { describe, expect, it } from 'bun:test';
import type { TaskStatus } from '@ferretry/protocol';
import {
  TASK_PHASE_META,
  TASK_STALENESS_COPY,
  TASK_STATUS_META,
  TASK_STATUS_ORDER,
  filterTasksByStatuses,
  orderedTaskStatuses,
  taskAssigneePresentation,
  taskFilterSummary,
  taskStatusCounts,
  taskTitlePreview,
  toggleTaskStatusFilter,
} from '../../../src/features/tasks/task-presentation.ts';
import { taskSummary } from '../../support/tasks.ts';

describe('task state vocabulary', () => {
  it('gives every protocol status and phase a label and a contrast-checked tone', () => {
    const tones = new Set(['ok', 'warn', 'err', 'pend', 'accent']);

    for (const meta of [...Object.values(TASK_STATUS_META), ...Object.values(TASK_PHASE_META)]) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(tones.has(meta.tone)).toBe(true);
    }
  });

  it('tones the terminal states apart: live and done settle, blocked and dropped alarm', () => {
    expect(TASK_STATUS_META.live.tone).toBe('ok');
    expect(TASK_STATUS_META.done.tone).toBe('ok');
    expect(TASK_STATUS_META.blocked.tone).toBe('err');
    expect(TASK_STATUS_META.dropped.tone).toBe('err');
  });

  it('derives the board order from the meta table so a new status cannot go missing', () => {
    expect(TASK_STATUS_ORDER).toEqual(Object.keys(TASK_STATUS_META) as TaskStatus[]);
    expect(TASK_STATUS_ORDER[0]).toBe('todo');
    expect(TASK_STATUS_ORDER.at(-1)).toBe('dropped');
  });

  it('states in every staleness reason that the declared status was not changed', () => {
    for (const copy of Object.values(TASK_STALENESS_COPY)) {
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.reason.toLowerCase()).toContain('status');
    }
    expect(TASK_STALENESS_COPY['maybe-finished'].reason).toContain('evidence only');
  });
});

describe('toggleTaskStatusFilter', () => {
  it('turns the All state into a single-status selection', () => {
    expect([...(toggleTaskStatusFilter(null, 'blocked') ?? [])]).toEqual(['blocked']);
  });

  it('adds a second status and removes it again', () => {
    const one = toggleTaskStatusFilter(null, 'todo');
    const two = toggleTaskStatusFilter(one, 'done');

    expect([...(two ?? [])]).toEqual(['todo', 'done']);
    expect([...(toggleTaskStatusFilter(two, 'todo') ?? [])]).toEqual(['done']);
  });

  it('returns to the explicit All state when the last status is removed', () => {
    expect(toggleTaskStatusFilter(new Set<TaskStatus>(['todo']), 'todo')).toBeNull();
  });

  it('never mutates the set it was given', () => {
    const current: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['todo']);

    toggleTaskStatusFilter(current, 'done');

    expect([...current]).toEqual(['todo']);
  });
});

describe('taskStatusCounts and orderedTaskStatuses', () => {
  const tasks = [
    taskSummary({ id: 'F1', status: 'done', phase: 'done' }),
    taskSummary({ id: 'F2', status: 'todo' }),
    taskSummary({ id: 'F3', status: 'done', phase: 'done' }),
  ];

  it('counts each status once', () => {
    expect([...taskStatusCounts(tasks)]).toEqual([
      ['done', 2],
      ['todo', 1],
    ]);
  });

  it('lists present statuses in board order, not first-seen order', () => {
    expect(orderedTaskStatuses(taskStatusCounts(tasks), null)).toEqual(['todo', 'done']);
  });

  it('keeps a selected zero-count status mounted so the filter can always be removed', () => {
    const counts = taskStatusCounts(tasks);

    expect(orderedTaskStatuses(counts, new Set<TaskStatus>(['blocked']))).toEqual(['todo', 'done', 'blocked']);
  });
});

describe('filterTasksByStatuses', () => {
  const tasks = [taskSummary({ id: 'F1', status: 'todo' }), taskSummary({ id: 'F2', status: 'blocked' })];

  it('copies the list rather than aliasing it in the All state', () => {
    const actual = filterTasksByStatuses(tasks, null);

    expect(actual).toEqual(tasks);
    expect(actual).not.toBe(tasks as unknown as typeof actual);
  });

  it('keeps only the selected statuses', () => {
    expect(filterTasksByStatuses(tasks, new Set<TaskStatus>(['blocked'])).map(task => task.id)).toEqual(['F2']);
  });
});

describe('taskFilterSummary', () => {
  it('singularises both counts independently', () => {
    expect(taskFilterSummary(1, 1)).toBe('1 match · 1 path');
    expect(taskFilterSummary(0, 2)).toBe('0 matches · 2 paths');
  });
});

describe('taskTitlePreview', () => {
  it('leaves a title that already fits completely alone', () => {
    expect(taskTitlePreview('Short title')).toBe('Short title');
  });

  it('ellipsises a long title and trims the seam', () => {
    expect(taskTitlePreview('Port the remaining PWA feature components', 12)).toBe('Port the re…');
  });

  it('never produces an ellipsis with nothing before it', () => {
    expect(taskTitlePreview('abcdef', 1)).toBe('a…');
  });
});

describe('taskAssigneePresentation', () => {
  it('reads Unassigned with no navigable session when nothing is stored', () => {
    const actual = taskAssigneePresentation(taskSummary());

    expect(actual).toEqual({
      name: 'Unassigned',
      sessionId: null,
      status: null,
      label: 'Unassigned',
      assigned: false,
    });
  });

  it('refuses to navigate to a stored id the live annotator did not prove', () => {
    const actual = taskAssigneePresentation(taskSummary({ assignee: 'ms98uuot-8a16639b' }));

    expect(actual.sessionId).toBeNull();
    expect(actual.name).toBe('ms98uuot-8a16639b');
    expect(actual.status).toBe('status unavailable');
    expect(actual.assigned).toBe(true);
  });

  it('prefers the live name and exposes the proved session', () => {
    const actual = taskAssigneePresentation(
      taskSummary({
        assignee: 'hayden',
        live: { assigneeSessionId: 'sess-1', assigneeName: 'Hayden', assigneeStatus: 'awaiting_user' },
      }),
    );

    expect(actual.sessionId).toBe('sess-1');
    expect(actual.name).toBe('Hayden');
    expect(actual.status).toBe('awaiting user');
    expect(actual.label).toBe('Hayden · awaiting user');
  });

  it('lets staleness outrank the raw session status, because staleness is the newer evidence', () => {
    const actual = taskAssigneePresentation(
      taskSummary({ assignee: 'hayden', live: { assigneeStatus: 'running', staleness: 'maybe-finished' } }),
    );

    expect(actual.status).toBe('Maybe finished');
  });

  it('treats a blank stored assignee as unassigned', () => {
    expect(taskAssigneePresentation(taskSummary({ assignee: '   ' })).assigned).toBe(false);
  });
});
