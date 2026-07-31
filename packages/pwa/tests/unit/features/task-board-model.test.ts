import { describe, expect, it } from 'bun:test';
import type { TaskPhase } from '@ferretry/protocol';
import {
  TASK_BOARD_LANE_META,
  TASK_WORKFLOW_LABEL,
  absoluteTimestamp,
  taskAskOrigin,
  taskBoardLane,
  taskBoardState,
  taskReference,
} from '../../../src/features/tasks/task-board-model.ts';
import { taskSummary } from '../../support/tasks.ts';

describe('taskBoardLane', () => {
  it('collapses every working phase into the one in-progress column', () => {
    for (const phase of ['research', 'design', 'build'] as const) {
      expect(taskBoardLane(phase)).toBe('in_progress');
    }
  });

  it('leaves every phase that is already a lane alone', () => {
    for (const phase of ['todo', 'built', 'live', 'done', 'dropped'] as const satisfies readonly TaskPhase[]) {
      expect(taskBoardLane(phase)).toBe(phase);
    }
  });

  it('gives every lane a label and a tone', () => {
    for (const meta of Object.values(TASK_BOARD_LANE_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.tone.length).toBeGreaterThan(0);
    }
  });
});

describe('taskBoardState', () => {
  it('reads the lane of the phase for ordinary work', () => {
    expect(taskBoardState(taskSummary({ phase: 'build', status: 'in_progress' }))).toEqual({
      label: 'In progress',
      tone: 'warn',
    });
  });

  it('lets blocked outrank whichever phase it is blocked in', () => {
    const actual = taskBoardState(taskSummary({ phase: 'build', status: 'in_progress', blocked: true }));

    expect(actual).toEqual({ label: 'Blocked', tone: 'err' });
  });
});

describe('taskReference', () => {
  it('prefixes the sigil every human-facing reference uses', () => {
    expect(taskReference('F12')).toBe('&F12');
  });

  it('never doubles a sigil that is already there', () => {
    expect(taskReference('&F12')).toBe('&F12');
    expect(taskReference('#F12')).toBe('&F12');
  });
});

describe('TASK_WORKFLOW_LABEL', () => {
  it('spells the hyphenated workflows as prose', () => {
    expect(TASK_WORKFLOW_LABEL['design-first']).toBe('Design first');
    expect(TASK_WORKFLOW_LABEL['research-first']).toBe('Research first');
  });
});

describe('taskAskOrigin', () => {
  const origin = (askSource: string, askChars = 40): ReturnType<typeof taskAskOrigin> =>
    taskAskOrigin(taskSummary({ askSource, askChars }));

  it('treats a direct human channel as a human ask', () => {
    expect(origin('slack message from kirin')).toBe('human');
    expect(origin('chat')).toBe('human');
  });

  it('recognises fleet and session artifacts as agent-originated', () => {
    expect(origin('agent: hayden')).toBe('agent');
    expect(origin('session: ms98uuot')).toBe('agent');
    expect(origin('turn: 4')).toBe('agent');
    expect(origin('ferretry handoff')).toBe('agent');
    expect(origin('/home/kirin/.ferretry/abc/summary.md')).toBe('agent');
  });

  it('reads an imported legacy fleet path as human, never as a false agent claim', () => {
    expect(origin('/home/kirin/.legacy-fleet/abc/summary.md')).toBe('human');
  });

  it('refuses to guess when the record carries no ask', () => {
    expect(origin('slack', 0)).toBe('unknown');
    expect(origin('   ')).toBe('unknown');
  });

  it('refuses to guess for a legacy or self-referential source', () => {
    expect(origin('legacy:imported')).toBe('unknown');
    expect(origin('#F12')).toBe('unknown');
  });
});

describe('absoluteTimestamp', () => {
  it('renders an instant in the reader’s own zone, to the second', () => {
    const at = new Date(2026, 6, 31, 9, 5, 3);

    expect(absoluteTimestamp(at.toISOString())).toBe('2026-07-31 09:05:03');
  });

  it('renders a missing instant as an em dash rather than an epoch', () => {
    expect(absoluteTimestamp(null)).toBe('—');
    expect(absoluteTimestamp(undefined)).toBe('—');
    expect(absoluteTimestamp('')).toBe('—');
  });

  it('echoes an unparseable value verbatim rather than inventing a date', () => {
    expect(absoluteTimestamp('whenever')).toBe('whenever');
  });
});
